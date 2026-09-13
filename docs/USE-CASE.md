# minidb: finding a real use case

Status: research + proposal. No code changed yet. Written 2026-09-12.

## 1. What minidb is today

A ~4,200-line, zero-runtime-dependency, pure-TypeScript SQL engine for Node.

- One data file plus a write-ahead log. 4 KB pages, B+tree indexes.
- Crash-safe: fsync on commit, replay on open, torn-page and checksum detection. Verified by an in-process fault-injecting file system and by a child process `SIGKILL`ed mid-write on a real file.
- SQL: `CREATE/DROP TABLE`, `CREATE INDEX`, `INSERT`, `SELECT` with inner joins, `WHERE`, `ORDER BY`, `LIMIT/OFFSET`, `UPDATE`, `DELETE`, `BEGIN/COMMIT/ROLLBACK`, `EXPLAIN`. Types `INT`, `TEXT`, `BOOL`, `NULL`, Postgres-strict.
- Single process, single writer, no network.

Missing for real use: parameter binding, aggregates, `GROUP BY`, `LIKE`, `IN`, an in-memory mode, a prepared-statement API, a file lock.

## 2. The landscape (what people use now)

| Option | Weekly downloads | Needs a compiler | Survives power loss | Catch |
|---|---|---|---|---|
| better-sqlite3 | ~8.7–10.4M ([Snyk](https://security.snyk.io/package/npm/better-sqlite3), [npmtrends](https://npmtrends.com/better-sqlite3-vs-node-sqlite3-vs-sqlite3)) | yes, C++ via node-gyp with prebuilds | yes | prebuild gaps on new Node, Electron ABI, Alpine (musl), ARM |
| node:sqlite | built in | no | yes | Node 22.5+ only; "Stability 1.2 Release Candidate" as of Node 25.7, not yet stable ([docs](https://nodejs.org/api/sqlite.html), [nodejs/node#57445](https://github.com/nodejs/node/issues/57445)) |
| sql.js (wasm) | ~1.2M (unverified, npm page blocked) | no | **no**, memory only; save = export the whole DB ([#302](https://github.com/sql-js/sql.js/issues/302), [#350](https://github.com/sql-js/sql.js/issues/350)) | ~1–1.5 MB wasm |
| PGlite (wasm Postgres) | 10M, vendor-reported ([electric.ax](https://electric.ax/blog/2026/06/25/pglite-reaches-10-million-weekly-downloads)) | no | Postgres WAL inside wasm; fsync behaviour of the wasm FS not verified | 2.7 MB gz / 8.9 MB raw; memory grows with data ([pglite.dev](https://pglite.dev/docs/about)) |
| lowdb (JSON file) | ~1.4–1.5M ([Snyk](https://security.snyk.io/package/npm/lowdb)) | no | **no**: its writer (steno) does temp-file + rename but never fsyncs ([steno source](https://raw.githubusercontent.com/typicode/steno/main/src/index.ts)) | whole-file rewrite per write; no lock |
| classic-level (LevelDB) | ~70k | yes, C++ | yes | key-value only |
| NeDB / @seald-io/nedb | original abandoned ([#492](https://github.com/louischatriot/nedb/issues/492)); fork ~158k | no | unknown, README silent on fsync | Mongo-style, not SQL |

**Finding: there is no pure-JS/TS SQL database with real durability.** Every candidate is wasm, NoSQL, or SQL over a JSON file (AlaSQL `FILESTORAGE`). Caveat from the researcher: searched npm and GitHub topics; a niche repo could exist, but nothing with adoption was found.

## 3. Evidence of pain

Native-build pain (better-sqlite3):

- [#1382](https://github.com/WiseLibs/better-sqlite3/issues/1382), Jun 2025: `No prebuilt binaries found (target=24.2.0 runtime=node arch=arm64 libc=musl)` → node-gyp → "You need to install the latest version of Python."
- [#1393](https://github.com/WiseLibs/better-sqlite3/issues/1393), Aug 2025, Electron 37 + pnpm: "compiled against a different Node.js version using NODE_MODULE_VERSION 127 ... execute rebuild, but still error." [electron/rebuild#1179](https://github.com/electron/rebuild/issues/1179) still open.
- [openchamber#1478](https://github.com/openchamber/openchamber/issues/1478), May 2026: v11.10 has no Node 24 prebuilds, v12 drops Node 20. No version covers both.
- [Discussion #1270](https://github.com/WiseLibs/better-sqlite3/discussions/1270): Alpine `Exec format error`; answer is "use node-slim".

JSON-file pain (lowdb):

- [#27](https://github.com/typicode/lowdb/issues/27), 2014: "various data loss conditions ... related to the async nature of the writes."
- [#333](https://github.com/typicode/lowdb/issues/333), 2019: file "becoming corrupted with malformed JSON `{ "key": "value`".
- [#359](https://github.com/typicode/lowdb/issues/359): requests for transactions / a lock file, never added.
- Ecosystem-wide: [write-file-atomic#16](https://github.com/npm/write-file-atomic/issues/16) "writeFileSync can corrupt file if crash occurs immediately after write"; the package [crash-safe-write-file](https://www.npmjs.com/package/crash-safe-write-file) exists only to add fsync.

## 4. The gap nobody fills: fault injection for Node apps

Databases test their own crash recovery with tooling that tears writes and drops unsynced data:

- SQLite crash-test VFS: "simulate incomplete sector writes, pages filled with garbage, out of order writes" ([sqlite.org/testing](https://www.sqlite.org/testing.html)). Not exposed through any Node binding.
- [LazyFS](https://github.com/dsrhaslab/lazyfs) (FUSE; lost and torn writes; found bugs in PostgreSQL, etcd, Redis, LevelDB; [VLDB'24 paper](https://www.vldb.org/pvldb/vol17/p3017-ramos.pdf)); used by [Jepsen](https://jepsen-io.github.io/jepsen/jepsen.lazyfs.html).
- [CharybdeFS](https://www.scylladb.com/2016/02/16/fault-injection-filesystem-software-testing/), [dsfs](https://github.com/macdice/dsfs).
- Deterministic simulation: [FoundationDB](https://apple.github.io/foundationdb/testing.html), [TigerBeetle VOPR](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md), [Antithesis](https://antithesis.com/docs/resources/deterministic_simulation_testing/).

For **application** code in Node ("does my order service handle a crash between two writes?") nothing was found. memfs and mock-fs fake a file system but cannot tear a write or fail an fsync. FUSE tools need root and Linux and do not fit `npm test`. Caveat: absence after ~4 searches, not proof.

minidb already contains this capability (`test/helpers.ts::FaultFS`: drop or tear unsynced writes, fail the Nth read/write/fsync, corrupt bytes on "disk"). It is simply not public API.

## 5. What a usable embedded SQL store must have

Judged by what people actually call in better-sqlite3 ([api.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)):

Table stakes: parameter binding (`?`, `$name`), `prepare()` → `run / get / all`, `db.transaction(fn)`, `':memory:'`, `COUNT/SUM/MIN/MAX/AVG` + `GROUP BY`, `LIKE`, `IN`, synchronous API.

Nice to have: `iterate`, named params, UPSERT, JSON/BLOB column, cross-process file lock, `pragma`.

## 6. Ranked use cases

1. **"Chaos SQLite" for Node test suites.** `npm i -D minidb`. SQL-compatible enough to stand in for better-sqlite3 in tests, plus a public fault API so an app proves its own retry, idempotency and recovery paths against real torn writes and power cuts. Uncontested niche. Needs: params, `:memory:`, aggregates, `LIKE`/`IN`, `transaction(fn)`, fault scripting + `reopen()`.
2. **Zero-build SQL store** for CLIs, Electron, Alpine/ARM containers where node:sqlite is unavailable (Node < 22.5, older Electron) or prebuilds fail. Same code as 1 plus a single-process file lock.
3. **Crash-safe lowdb replacement.** Typed document/KV facade over the SQL core, fsync by default. Weakest moat: node:sqlite going stable will absorb it.

## 7. Recommendation

Build 1. It makes 2 free. Skip 3.

Proposed changes (storage layer and `ladder/` untouched):

| # | Change | Files | Size |
|---|---|---|---|
| 1 | Parameter binding `?` and `$name` | `sql/lexer.ts`, `parser.ts`, `expr.ts` | small |
| 2 | `prepare().run/get/all`, `transaction(fn)`, `':memory:'` | `database.ts`, `storage/file-io.ts` (memory FileIO) | small |
| 3 | Aggregates + `GROUP BY` (`Aggregate` node, `HAVING` optional) | `parser.ts`, `expr.ts`, `executor.ts`, `planner.ts` | medium |
| 4 | `LIKE`, `IN (...)` | `lexer.ts`, `parser.ts`, `expr.ts` | small |
| 5 | Public fault API: `db.faults.powerCut()`, `tearNextWrite()`, `failFsync(n)`, `db.reopen()` | new `src/faults.ts`, promote `FaultFS` from test to src | small |
| 6 | Single-process file lock (`<file>.lock`, pid + mtime) | `storage/file-io.ts`, `database.ts` | small |

Estimate: about one day, ~800 lines, plus `test/api.test.ts` and a README section with the chaos-test example.

Example of the pitch, once built:

```ts
import { Database } from 'minidb';

const db = new Database(':memory:');
db.exec('CREATE TABLE orders (id INT PRIMARY KEY, total INT, status TEXT)');

db.faults.powerCutAfterNextFsync();   // the plug goes out mid-commit
try { placeOrder(db, { id: 1, total: 500 }); } catch {}
db.reopen();                          // "restart" the process
expect(db.prepare('SELECT COUNT(*) FROM orders').get()).toEqual({ count: 0 }); // or 1, never half
```

## 8. Open questions for further research

- Is there demand you can measure? A tweet/post asking "would you use a SQLite-shaped DB you can crash on purpose in tests?" costs nothing.
- Does anyone already ship "fault injection as a test DB" in another ecosystem (Python, Go, Rust) that we could copy the API shape from? The researcher found only database-internal tools.
- How much of better-sqlite3's API surface do typical test suites actually touch? Sample 5 open-source repos that use it in tests and list the calls.
- Performance floor: is ~5–10k inserts/s and ~8k point lookups/s enough for test suites? Almost certainly, but measure a real suite.
- Licensing and name: "minidb" is taken on npm. Check availability of candidates before publishing.
- Multi-process: Electron main + renderer both opening one file is the lowdb#333 failure. A lock file rejects the second opener; is that acceptable, or is a real multi-process story needed for use case 2?
- Node version floor: `fs.fsyncSync`, `Buffer`, `BigInt` all fine on Node 18+. Confirm nothing newer is used before claiming Node 18 support.
- Deterministic replay: should fault injection take a seed so a failing chaos test can be re-run exactly? (TigerBeetle/FoundationDB style.) Cheap to add now, painful later.
