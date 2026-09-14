# Edge prototype: results against the acceptance criteria

Branch `explore/edge-object-store`, 2026-09-14. Protocol in `PROTOCOL.md`. Code in `src/edge/`, tests in `test/edge.test.ts`, benchmark `scripts/_edge-bench.ts`.

## What was built

| Piece | File | Lines |
|---|---|---|
| Object store interface + in-memory S3-like fake (ETags, `If-Match`, range GET, fault hooks incl. lost-ack) | `src/edge/store.ts` | 120 |
| Manifest format, chunking (16 pages / 64 KB), key layout | `src/edge/manifest.ts` | 60 |
| Snapshot writer: pages → content-addressed chunks, hot set embedded, conditional publish | `src/edge/snapshot-writer.ts` | 100 |
| Async read-only reader: open, catalog, point lookup by any index, scan, windowed concurrent prefetch | `src/edge/reader.ts` | 260 |
| Publisher: lease with generation, local in-memory copy, conditional publish, lost-ack resolution, GC | `src/edge/publisher.ts` | 170 |

No change to page layout, B-tree, WAL, SQL or the executor. The engine's page/node/tuple decoders are reused as-is; three internals were exported for that.

## Acceptance

**1. Remote snapshot supports indexed reads without converting the executor.** Done. `RemoteSnapshot.lookup(table, key, index?)` descends the B-tree using the same node format; index meta/root/internal pages ride in the manifest, so a point lookup touches one leaf chunk and one heap chunk.

**2. Measure open + first query cold, including manifest and catalog.** Done. 20,000 rows (999 pages, 63 chunks, 40 KB manifest, 7 hot pages), in-memory store with simulated per-request latency, chunk cache capped at 16 chunks (a quarter of the database) so fetches are real:

| | 30 ms/request (same region) | 80 ms/request (cross-region) |
|---|---|---|
| Cold open + first pk lookup | **3 requests, 168 KB, p50 96 ms, p99 127 ms** | 3 requests, p50 244 ms, p99 335 ms |
| Warm pk lookup | 1.15 range GETs, p50 31 ms, p99 63 ms | p50 81 ms, p99 164 ms |
| Secondary-index lookup, 100 rows across 63 chunks | 63 range GETs concurrently, 325 ms | 821 ms |
| Full scan, 20k rows, 4 MB | 63 range GETs, 344 ms | 819 ms |
| Heap growth for open + lookup | ~150 KB | |

Cold cost is exactly what the protocol predicts: manifest + leaf chunk + heap chunk. Everything is latency-bound; CPU is negligible (same run at 0 ms latency: cold 1 ms, scan 45 ms).

**3. Publication under a stale writer and a lost acknowledgement.** Done, as tests:
- Stale writer: A takes the lease, B takes it over after expiry (generation bumps), B publishes, A's publish is refused (`PublishConflictError`), the store shows B's data and B's generation. The race variant where A's pre-check passes but the conditional PUT loses is also covered (`PreconditionFailedError` from the store). A live lease is refused outright.
- Lost acknowledgement: the manifest PUT lands but the client sees an error; publish reads the manifest back, finds its own `(version, generation)`, reports success without a second PUT. A genuinely failed PUT still surfaces as an error.
- Also: snapshot isolation (an open reader keeps its version through a later publish), garbage collection (unreferenced chunks removed; a reader whose chunks were collected fails loudly, never reads wrong data), incremental publish (an in-place update re-uploads one chunk; a moved row re-uploads four: old heap page, new heap page, one leaf per index).

**4. Compare with sql.js-httpvfs / wa-sqlite on the same data.** Not done. Needs those packages plus an HTTP-range shim over the same fake store; roughly a day. Without it the numbers above have no external reference point, only the protocol's own prediction.

**5. Decide on the async engine.** Open. See below.

## What the numbers say

- The read path is as cheap as it can be for a B-tree over object storage: 2 fetches per cold point lookup after the manifest, ~1 when warm. Any competitor needs the same two unless it caches more.
- Secondary lookups and scans are dominated by the number of distinct chunks touched. Concurrency (16 in flight) turns 63 sequential fetches into ~4 rounds. Bigger chunks would cut request count at the cost of bytes; not explored.
- Manifest size grows with index height and chunk count: 40 KB for 20k rows. At 1M rows it would be a few hundred KB, still one GET, but worth measuring before claiming more.
- Publish is a full-content diff of the local copy; unchanged chunks cost nothing. A one-row change uploads 64 KB + a 40 KB manifest.

## What is still missing before this is a product

- The comparison (item 4).
- A real store adapter (S3 or R2 via `@aws-sdk/client-s3` / Workers bindings) and one run against a real bucket for true latency.
- The writer materialises the whole database into memory. Fine to ~tens of MB per tenant, which is the target; not beyond.
- Reads go through `RemoteSnapshot`, not SQL. Running the SQL executor over remote pages is the async-engine question this prototype was meant to inform, and it is still a one-to-two-week change.
- R2's one-write-per-second per key applies to the manifest: ~1 commit/s per database.

## Recommendation

The protocol holds up: publication is safe under the two failure modes the review named, and cold reads cost what the design predicted. What is not yet known is whether that beats the existing SQLite-in-wasm-over-HTTP tools, which is acceptance item 4. Do that comparison (about a day) before spending the weeks on the async engine. If minidb comes out clearly ahead on requests, bytes, or simplicity, proceed; if not, the learning track is the project and this branch stays as documentation of a sound design.
