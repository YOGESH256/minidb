# minidb over an object store: the protocol on one page

Branch `explore/edge-object-store`. Status: design, no code. If this does not fit on a page, the idea is not ready.

## The problem in one sentence

A bucket (S3, R2) is not a disk: you cannot change bytes in the middle of an object, only PUT whole objects and GET byte ranges. So the database cannot be "a file"; it has to be a set of immutable objects plus one small object that says which of them are current.

## Objects

```
<db>/manifest                 the only mutable key. Small JSON.
<db>/chunks/<sha>.pages       immutable. N consecutive pages (default 16 → 64 KB), content-addressed.
<db>/lease                    mutable. Who may write, until when.
```

Pages keep their exact on-disk format (header, checksum, LSN). A chunk is just pages concatenated, so the existing `Page`, heap and B-tree code reads them unchanged.

## Manifest

```json
{
  "format": 1,
  "version": 42,                          // increases by exactly 1 per publish
  "generation": 7,                        // the lease generation that published it
  "pageCount": 1830,
  "meta": "<base64 of page 0>",           // catalog roots etc., so open() needs no extra GET
  "hot":  "<base64 of the B-tree metas + roots + internal pages>",  // turbolite trick: a lookup is manifest + one leaf + one heap page
  "chunks": { "0": "sha-a", "16": "sha-b", "32": "sha-c" }   // first page id → chunk object
}
```

Cost of an indexed point lookup, cold: GET manifest (1) + GET leaf chunk range (1) + GET heap chunk range (1) = 3 requests. Warm (manifest cached): 2.

## Reading (a snapshot)

1. GET manifest → this is the snapshot. Never re-read it during a query or transaction.
2. Page `p` lives in chunk `chunks[floor(p/16)*16]` at offset `(p % 16) * 4096`. Fetch with a range GET; cache chunks in memory (LRU, bounded).
3. Verify each page's checksum as today. A mismatch is corruption, not a torn write: objects are atomic.

Readers never take the lease. Readers never write.

## Writing (single writer, published atomically)

1. Acquire the lease: conditional PUT of `lease` `{ owner, generation: g+1, expires }` with `If-Match: <previous etag>` (or `If-None-Match: *` when absent). Failure = someone else writes; stop.
2. Run the transaction locally exactly as today (buffer pool, txn-dirty frames). No network during the transaction.
3. Commit:
   a. Group every dirty page with its 15 neighbours into chunks (reading unchanged neighbours from the snapshot). PUT each chunk under its content hash. Retry on error; idempotent.
   b. Build the new manifest: `version + 1`, `generation` = our lease generation, updated `chunks`, updated `meta`/`hot`.
   c. **Publish** with a conditional PUT on `manifest`: `If-Match: <etag of the manifest we started from>`. This is the commit point. Success = durable. Failure = someone published in between; our chunks are garbage, our transaction is rolled back locally, report a conflict.
4. Renew the lease periodically; if it expires mid-transaction, step 3c still protects us: a newer writer would have bumped the manifest's `generation`, so our `If-Match` on the old etag fails.

The WAL-then-data rule survives as chunks-then-manifest. There is no separate WAL object: the manifest publish is the commit record.

## The two nasty cases

- **Stale writer.** A pauses, its lease expires, B takes the lease (generation g+2), B publishes version 43. A wakes and tries to publish version 43 with `If-Match: etag(42)`. The store rejects it. A must not retry blindly: it reloads the manifest, sees a foreign `generation`, and aborts. Test: exactly this sequence against the fake store.
- **Lost acknowledgement.** A's manifest PUT succeeds on the server but the response never arrives. A does not know if it committed. Rule: GET the manifest; if `version` is ours and `generation` is ours, it committed; otherwise it did not. Never re-PUT. Test: fake store applies the write but throws.

Both work because every publish carries `(version, generation)` and the store enforces `If-Match`. S3 and R2 both support conditional writes; R2 allows one write per second per key, which caps commit rate at ~1/s per database. Fine for the target workload; say so.

## Garbage collection

Chunks referenced by neither the current manifest nor any manifest younger than the reader grace period (say 10 minutes) are deleted by the writer after publish. Readers hold a snapshot for at most that long, or re-open.

## What is deliberately not here

Multi-writer. Cross-database transactions. Streaming replication. Rows larger than a page. Any change to page layout, B-tree, or SQL.

## Acceptance for the prototype (from the review)

1. Open a remote snapshot and answer an indexed lookup with the read path above; no executor conversion.
2. Measure open + first query cold, including manifest load: requests, bytes, memory, p50/p99.
3. Publish protocol passes the stale-writer and lost-ack tests on a fake conditional store.
4. Same measurements for sql.js-httpvfs on the same data.
5. Then decide on the async engine.
