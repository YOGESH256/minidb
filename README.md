# minidb

[![tests](https://github.com/YOGESH256/minidb/actions/workflows/ci.yml/badge.svg)](https://github.com/YOGESH256/minidb/actions/workflows/ci.yml)

A SQL database engine written from scratch in TypeScript, shaped after PostgreSQL. Slotted pages, a write-ahead log, a buffer pool, a B+tree, a rule-based planner and a Volcano executor, in about 4,000 lines with zero runtime dependencies.

**It is built to be read, not deployed.** Single writer, no MVCC, no `GROUP BY` yet. If you want a database for an application, use SQLite or Postgres. If you want to understand how one works, or to change one and see what happens, this is unusually approachable: every layer maps to a real PostgreSQL structure, and the tests prove the parts that are easy to claim and hard to do.

It survives `kill -9` mid-commit. That is tested six times a run, on Linux and macOS, on Node 20, 22 and 24.

```
$ npx tsx src/repl.ts demo.db
minidb> CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL, age INT);
minidb> INSERT INTO users VALUES (1,'ann',31),(2,'bob',NULL),(3,'cy',25);
minidb> SELECT name, age FROM users WHERE age > 20 ORDER BY age DESC;
 name | age
------+-----
 ann  | 31
 cy   | 25
(2 rows)
minidb> EXPLAIN SELECT * FROM users u JOIN users v ON v.id = u.id;
 Nested Loop
   -> Seq Scan on users u
   -> Index Scan using users_pkey on users v
        Index Cond: id = u.id
```

**New to databases?** Read [`START-HERE.md`](START-HERE.md). It points you at `ladder/`, the same engine grown in five 150–300-line steps, each adding one idea with one test that shows what breaks without it.

## What it is

One data file plus a write-ahead log. Every design choice mirrors PostgreSQL where a single-writer engine can afford to, and the deviations are called out below. Sources are in `docs/research-*.md`.

| Layer | File | Postgres analogue |
| --- | --- | --- |
| Slotted page | `src/storage/page.ts` | `bufpage.h`: 24 B header, 4 B line pointers (`off:15 flags:2 len:15`), tuples grow from the end, `pd_lsn`, checksum |
| File I/O | `src/storage/file-io.ts` | positional pread/pwrite, short-write loops, `F_FULLFSYNC` on Darwin via libuv |
| WAL | `src/storage/wal.ts` | CRC-framed records, LSN = end offset, replay stops at the last COMMIT |
| Buffer pool + txn | `src/storage/pager.ts` | clock-sweep eviction (`usage_count` ≤ 5), pin/unpin, WAL-before-data on write-back, checkpoint = flush + truncate WAL |
| Heap | `src/storage/heap.ts` | chained slotted pages, `TID = (page, slot)` stable across deletes |
| B+tree | `src/storage/btree.ts` | nbtree: metapage root, high key, sibling links, `(key, TID)` ordering, split by bytes, no merge on delete |
| Catalog | `src/catalog.ts` | hardcoded schemas for `__tables`, `__columns`, `__indexes` (SQLite `sqlite_schema` trick) |
| SQL | `src/sql/{lexer,parser,ast}.ts` | recursive descent + Pratt expressions, PG precedence |
| Binder | `src/sql/expr.ts` | strict typing (`INT = TEXT` is an error), 3-valued logic, byte-wise TEXT |
| Planner | `src/sql/planner.ts` | left-deep nested loop, parameterized index scan on the inner side, predicate pushdown |
| Executor | `src/sql/executor.ts` | Volcano `open/next/close` nodes: SeqScan, IndexScan, Filter, NestedLoop, Sort, Limit, Project |
| Facade | `src/database.ts` | autocommit, `BEGIN/COMMIT/ROLLBACK`, constraint enforcement, index maintenance |

## SQL supported

```sql
CREATE TABLE t (id INT PRIMARY KEY, s TEXT NOT NULL, b BOOL);
CREATE [UNIQUE] INDEX i ON t (s);
DROP TABLE [IF EXISTS] t;  DROP INDEX [IF EXISTS] i;
INSERT INTO t [(cols)] VALUES (...), (...);
SELECT expr [AS alias], t.*, * FROM t [AS a] [[INNER] JOIN u ON ...]* [WHERE ...] [ORDER BY ... [ASC|DESC]] [LIMIT n] [OFFSET n];
UPDATE t SET c = expr, ... [WHERE ...];
DELETE FROM t [WHERE ...];
BEGIN; COMMIT; ROLLBACK; CHECKPOINT;
EXPLAIN SELECT ...;
```

`ORDER BY` accepts expressions, select-list ordinals (`ORDER BY 2`) and output aliases; `DESC` puts NULLs first, as in Postgres. `WHERE`/`ON` must be boolean.

Types: `INT` (64-bit, overflow raises), `TEXT` (UTF-8, byte-wise order), `BOOL`, `NULL`. Operators: `+ - * / %`, `= != <> < <= > >=`, `AND OR NOT`, `IS [NOT] NULL`. Comments `--` and `/* */`. Doubled quotes in strings. System tables `__tables`, `__columns`, `__indexes` are queryable.

## Durability model

Redo-only WAL with full-page images (SQLite's WAL framing, Postgres's record/LSN discipline):

1. A transaction mutates pages in the buffer pool. Under memory pressure an uncommitted page is *spilled*: its image is appended to the WAL (no fsync) and re-read from there, so a statement may touch more pages than the pool holds.
2. `COMMIT` stamps each page's LSN and checksum, appends its full image to the WAL, appends a COMMIT record, and fsyncs once. If any step fails the WAL is rewound to where the transaction began, so nothing of it can hide under a later COMMIT.
3. Frames are then "committed-dirty": written to the data file on eviction or at checkpoint. A page is never written unless its LSN is at or below the durable WAL end.
4. `ROLLBACK` drops the transaction's frames and rewinds the WAL; the data file never saw them.
5. On open, page images up to the last COMMIT are replayed into the data file; anything after (a torn tail, a bad CRC) is discarded. Then the WAL is truncated. A zero-filled page inside the allocated range is reported as corruption rather than read as empty.

Tested three ways: an in-process fault-injecting file system that drops or tears unsynced writes and can fail any read/write/fsync on demand (`test/helpers.ts`), a child process committing batches on a real file that gets `SIGKILL`ed at random moments six times (`test/crash.test.ts`), and one regression test per finding of the code review in `docs/CODE-REVIEW-2026-09-09.md` (`test/review-regressions.test.ts`).

## Numbers (M-series laptop, 50k rows, 4 KB pages, 512-frame pool)

| Operation | Rate |
| --- | --- |
| Bulk insert, 500 rows per statement, pk + secondary index | 5k–12k rows/s (run-to-run swing is `F_FULLFSYNC` noise) |
| Primary key point lookup | ~8k/s |
| Secondary index range, 50 rows | ~1 ms |
| Seq scan, 50k rows with filter | ~70 ms |
| `UPDATE` all 50k rows (spills past the pool) | ~8 s |
| `DELETE` all 50k rows (spills past the pool) | ~22 s |
| Single-row autocommit transaction | 200–280/s (bounded by `F_FULLFSYNC`, same as Postgres with `fsync=on`) |

Measured on an M-series Mac. The `UPDATE` and `DELETE` figures are **known issues, not targets**: both spill past the buffer pool and re-read their own spill, and neither has been optimised. They are left here because a learning project that hides its slow paths is worth less than one that points at them.

## Deliberate limits (v1)

- Single writer, no concurrency, no MVCC. Reads inside a transaction see its own writes.
- A statement error inside `BEGIN` puts the transaction in Postgres's aborted state: later statements fail with `current transaction is aborted` until `ROLLBACK` (`COMMIT` also rolls back and reports `ROLLBACK`).
- No `GROUP BY`, aggregates, subqueries, `LIKE`, `IN`, `BETWEEN`, composite indexes, or `ALTER TABLE`. `LEFT/RIGHT/FULL/CROSS JOIN` and `USING` are rejected with an explicit error.
- Rows and index keys must fit in a page (~4 KB and ~1 KB). No TOAST.
- NULLs are not indexed, so `IS NULL` always seq-scans.
- Planner is rule-based, no statistics: unique equality > equality > range > seq scan; joins in FROM order.

## Develop

```
npm install
npm test            # vitest: unit tests per layer, SQL end-to-end, review regressions,
                    # fault-injected recovery, a real-file SIGKILL test, and the ladder
npm run typecheck
npm run build       # dist/
npx tsx src/repl.ts some.db
```

## Library API

```ts
import { Database } from 'minidb';

const db = new Database('app.db');          // or ':memory:'
db.exec('CREATE TABLE t (id INT PRIMARY KEY, s TEXT)');

const ins = db.prepare('INSERT INTO t VALUES (?, ?)');   // ? positional, $name named
ins.run(1, 'one');                                       // → { changes: 1 }
db.prepare('SELECT s FROM t WHERE id = $id').get({ id: 1 }); // → { s: 'one' } | undefined
db.prepare('SELECT * FROM t').all();                     // → row objects

const move = db.transaction((from: number, to: number) => { /* runs inside BEGIN … COMMIT, rolls back on throw */ });

db.trace('SELECT * FROM t WHERE id = ?', [1]);  // { results, events: [page reads, index hops, WAL, fsync…], summary }
db.pageMap();                                    // what every page in the file is
db.close();
```

Values are bound, never interpolated, and a prepared statement is planned once (re-planned automatically after schema changes). A file may have one owner at a time (`<file>.lock`; a second `Database` on the same path throws `DatabaseLockedError`; a lock left by a dead process is taken over). `exec(sql)` runs several statements; `query(sql)` one, returning `{ columns, rows }`.

## Experiments

Each of these lives on its own branch and is an attempt to find out what the engine's unusual parts are good for. None is merged to `main`.

- **Live queries, change history and undo** (`explore/history-watch`). `npm run demo` opens a task board whose columns are live queries, whose activity log is the database's own change receipts, and whose undo is `db.undo(txn)` with conflict detection. See [`docs/HISTORY-WATCH.md`](docs/HISTORY-WATCH.md).
- **The custodian** (`explore/custodian`). `npm run demo:custodian`. Something that lives with the data and notices things: a query that keeps scanning a whole table, an index nothing uses, a column that quietly stopped being filled, a row two writers are fighting over. It reports; it never changes anything. See [`docs/CUSTODIAN.md`](docs/CUSTODIAN.md).
- **Experiments on disposable copies.** `npm run demo:experiment` exercises the first agent experiment harness: fresh copies, transaction replay, measured costs, result and constraint comparisons, and a JSONL observations log. An agent can drive it through a JSONL tool interface. This phase supplies the harness; the demo is scripted and microVM isolation is not implemented yet. See [the experiment protocol](docs/EXPERIMENTS.md).
- **SQL over object storage** (`explore/edge-object-store`). Chunks, a manifest and conditional publish, measured against real SQLite behind a JavaScript VFS. The measurements said no; [`docs/edge/RESULTS.md`](docs/edge/RESULTS.md) says why.

## Direction

[`docs/DIRECTION.md`](docs/DIRECTION.md) is the single current statement of where this goes. [`docs/research/`](docs/research/) holds nine rounds of looking for a use case, each with its verdict and its sources, including the ones that came back negative and why.

## How it was built

Written over about two weeks, with heavy use of AI coding tools. That is worth saying plainly because it is the first thing people ask.

It was written by someone who runs PostgreSQL in production daily — replicas, connection pools, query plans, index choices, the occasional 3am incident — but had never built a storage engine. That shows in the shape of it: the engine mirrors PostgreSQL closely because the goal was to understand the system already being operated, from the inside. The page layout follows `bufpage.h`, the B+tree follows nbtree's README, the WAL follows PostgreSQL's record and LSN discipline, and each was read before it was written, cited in [`docs/research-storage.md`](docs/research-storage.md) and [`docs/research-sql.md`](docs/research-sql.md).

Two code reviews found fourteen real bugs between them, including a rollback that lost a committed page and a B+tree split that could fail mid-way. Both reviews and every fix are in [`docs/CODE-REVIEW-2026-09-09.md`](docs/CODE-REVIEW-2026-09-09.md) and [`docs/CODE-REVIEW-2026-09-14.md`](docs/CODE-REVIEW-2026-09-14.md). Corrections are welcome, especially from people who know PostgreSQL internals.
