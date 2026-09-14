# Where minidb is going

Single source of truth for product direction. Older research notes live in `docs/archive/` and are kept for the evidence they contain; where they disagree with this page, this page wins.

## Current decision (2026-09-13)

**Two tracks, in this order:**

1. **Learning project (live, stands on its own).** The ladder (`ladder/`), the click-through explainer (`docs/explainer.html`), the video, `START-HERE.md`, `CODE-TOUR.md`. Next step is validation, not code: put the explainer and ladder in front of two or three people who do not know database internals and watch whether they can explain a concept afterwards. A Node-based lab (REPL `.trace`, `.pages`, `.hexdump`, `.crash after N` on a real file) is the follow-on if that goes well. Not a browser sandbox: the point is a real file, real fsync, real `kill -9`.

2. **Edge direction (approved for a one-week prototype, not for the rewrite).** SQL over customer-owned object storage (S3/R2), opened from isolates and serverless functions, one small database per tenant, single writer. See `EDGE-DIRECTION.md` for the evidence and `archive/` for the review that narrowed it. The prototype must, before any engine rewrite:
   - define the object-store protocol on one page: immutable page objects, a manifest, conditional publish with a generation check (a stale writer is refused at publish time), reader snapshot pinning, compaction, garbage collection;
   - implement an async read-only path (manifest → index descent → page fetch) over a fake bucket without converting the executor;
   - test stale-writer and lost-acknowledgement cases;
   - measure cold open + first query, requests, bytes, memory, p99 against sql.js-httpvfs / wa-sqlite on the same data.
   Go/no-go on the async engine rewrite follows from those numbers.

## What was considered and dropped, with the reason

| Direction | Dropped because |
|---|---|
| "Chaos SQLite" test double with a public fault API | An app on SQLite/Postgres learns little from passing against a single-writer Postgres-flavoured engine; a fault-injecting JS VFS under real SQLite (wa-sqlite / sqlite-wasm) tests the real thing. |
| Zero-build SQL store for CLIs, Electron, VS Code | `node:sqlite` ships in Node 22.13+ unflagged; VS Code runs Node 24. The install pain that motivated it is gone. |
| Postgres test double | PGlite (real Postgres in wasm) is at 12M+ weekly downloads. |
| Records store / Node-RED / job-outbox | Real needs, but same competition as above and no reason to pick a young engine over `node:sqlite`. |
| Crash-safe lowdb replacement | Weakest moat; absorbed by `node:sqlite`. |
| Local reactive/versioned database (history, watch, undo, sync) | Strongest product idea of the set. **Being tested on branch `explore/history-watch`** (receipts, `watch()`, `undo()` with conflict detection; 12 tests; see `docs/HISTORY-WATCH.md`). Cost: ~half write throughput with history on. Next: a demo app, then user feedback. |

## Engine facts that constrain every direction

- Single writer, no MVCC. Rows and index keys must fit in a page (~4 KB / ~1 KB). No aggregates, LIKE, IN, JSON columns yet.
- Storage path is synchronous. Object storage requires an async path and a publication protocol, not just promises on `FileIO`.
- Opening performs recovery writes and closing checkpoints; a read-only remote replica needs a separate open path.
- Durable single-row transactions run at ~200–280/s on a laptop (bounded by `F_FULLFSYNC`), bulk inserts at 5–12k rows/s.
