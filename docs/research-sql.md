# Research: SQL front-end, evaluation, Node I/O, catalog, testing

Compiled 2026-09-09.

## 1. Parsing

Grammar: `CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `INSERT ... VALUES`, `SELECT ... FROM ... [INNER JOIN ... ON] [WHERE] [ORDER BY] [LIMIT [OFFSET]]`, `UPDATE ... SET`, `DELETE FROM`.

Lexer traps: `'it''s'` doubled quote; `<>` = `!=`; `--` comments; require `;` between statements (tiny-sqlite ran `SELECT * FROM t DELETE FROM t` as two statements silently).

Precedence (low → high): `OR < AND < NOT < comparison (= != < <= > >= IS NULL) < + - < * / % < unary -`. Comparison non-associative (reject `a = b = c`).

SQLite `parse.y` puts `< > <= >=` one level above `= !=`; PG orders `BETWEEN/IN/LIKE > comparison > IS > NOT`. One flat comparison level is fine for a 3-type engine.

Pratt: `parseExpr(minBp)` loop, table of `{prefix, infix, bp}` per token; left-assoc binary uses `rbp = bp + 1`.

- https://github.com/sqlite/sqlite/blob/master/src/parse.y
- https://craftinginterpreters.com/compiling-expressions.html
- https://matklad.github.io/2020/04/13/simple-but-powerful-pratt-parsing.html

## 2. Evaluation + coercion

SQLite: `'1' = 1` → false (no affinity on literals) but `int_col = '1'` → true; TEXT via BINARY memcmp; overflow promotes to REAL silently. PG: unknown-typed literal adopts other operand's type; `text_col = 1` errors; overflow raises.

Decision: PG-style strictness. Same-type comparisons only, type error at bind time. TEXT compared byte-wise as UTF-8 (`Buffer.compare`), not JS `<` (UTF-16 code units diverge for astral chars). INT stored as int64, JS `number` guarded by `Number.isSafeInteger`, throw on overflow. NULL three-valued, WHERE keeps only TRUE.

- https://www.sqlite.org/datatype3.html
- https://www.postgresql.org/docs/current/typeconv-oper.html

## 3. Node.js file I/O

- `openSync(path, 'r+')` for existing, `'wx+'` to create; `'w+'` truncates.
- `readSync(fd, buf, off, len, position)` = pread; short reads legal, loop.
- `writeSync` returns bytes written, not guaranteed `=== len`; loop on return value (libuv `uv__fs_write_all` returns partial).
- `fsyncSync` on Darwin: libuv issues `fcntl(F_FULLFSYNC)`, falls back to `F_BARRIERFSYNC`, then `fsync()`. Real cache flush on internal disks. Also fsync directory after create/rename.
- Buffers: `readBigInt64LE`, `writeUInt32LE`, `subarray` (view), `Buffer.compare`.

- https://nodejs.org/api/fs.html
- https://github.com/nodejs/node/blob/main/deps/uv/src/unix/fs.c
- https://github.com/libuv/libuv/issues/1579

## 4. Catalog bootstrap

SQLite: page 1 = file header + root of `sqlite_schema`, definition implicit, `rootpage` per object, schema cookie bumps on DDL. PG: hardcoded descriptors for `pg_class`/`pg_attribute` in `formrdesc()`.

Decision: hardcode catalog table schemas in code, fixed roots in meta page, rows `{id, name, root_page, ...}`.

- https://sqlite.org/fileformat.html
- https://www.postgresql.org/docs/current/bki.html

## 5. Crash-recovery testing

- Spawn-and-kill (SQLite `crash.test`): child runs workload, parent SIGKILLs mid-write, reopens, checks integrity.
- In-process fault injection (RocksDB `FaultInjectionTestFS`): wrap fs interface, buffer writes until fsync, drop unsynced on "crash". Deterministic. Do both.

- https://www.sqlite.org/testing.html
- https://rocksdb.org/blog/2022/10/05/lost-buffered-write-recovery.html

## 6. Prior art (JS/TS)

- minisql (JS): tokenizer → RD parser → planner (full scan vs index) → executor, 4 KB paged B+tree. https://github.com/zheyuanhu2-sketch/minisql
- tiny-sqlite (TS): precedence climbing, 3VL, no disk. https://github.com/nradawg/tiny-sqlite
- henrydb (JS): pages, B+tree, planner, Volcano, MVCC, WAL. https://github.com/henry-the-frog/henrydb
- pglite/pglite "PostgresLite" (TS, unrelated to electric-sql/pglite): slotted pages, WAL, B-tree, Volcano, LRU. https://github.com/pglite/pglite
