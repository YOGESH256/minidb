# Code tour, file by file

Read bottom to top: each file only depends on the ones above it in this list.

## `src/types.ts` — values and their bytes
The three data types (`INT`, `TEXT`, `BOOL`) plus `NULL`. `encodeValue` / `decodeValue` turn one value into bytes and back (INT = 8 bytes, TEXT = length + UTF-8, BOOL = 1 byte). `encodeTuple` / `decodeTuple` do a whole row: a null bitmap first, then each non-null value. `compareValues` is the one place ordering is defined (TEXT compares raw bytes, never locale). `checkInt` throws on numbers that cannot be stored exactly.

## `src/storage/page.ts` — one 4 KB block
The `Page` class is a view over a 4096-byte `Buffer`. Header (24 bytes): LSN, checksum, flags, `lower`, `upper`, special offset, page type. After the header: 4-byte line pointers (`offset | flags | length`), growing down. Items grow up from `upper`. `addItem` reuses dead slots so slot numbers stay stable (heap use); `insertItemAt` / `removeItemAt` shift slots (B-tree use). `compact` squeezes out deleted items. `stampChecksum` / `verifyChecksum` catch torn or garbage pages. `crc32` lives here too.

## `src/storage/file-io.ts` — talking to the disk
`FileIO` interface: `read(pos, len)`, `write(pos, data)`, `size`, `truncate`, `fsync`, `close`. `NodeFileIO` implements it with `fs.readSync` / `writeSync` at explicit positions, looping on short reads and short writes. Tests swap in a fake file system through this interface, which is how we simulate power cuts.

## `src/storage/wal.ts` — the write-ahead log
Append-only file. Header, then records: `length | type | pageId | payload | crc32`. Two record types: `PageImage` (a full 4 KB page) and `Commit`. `appendPageImage` / `appendCommit` write; `fsync` marks everything before it durable; `scan` reads back and stops at the first bad checksum or short record (the crash tail). `truncateTo` rewinds after a failed or rolled-back transaction. `readPageImage` serves pages that were spilled out of memory mid-transaction.

## `src/storage/pager.ts` — page cache, transactions, recovery
The heart of durability. Holds 512 `Frame`s (a buffer + page id + pin count + dirty flags). `acquire(id)` returns a pinned frame, loading from disk or WAL if not cached; `release` unpins. `markDirty` records that the open transaction changed a frame. `begin` remembers the WAL offset. `commit` writes every changed page to the WAL, appends `COMMIT`, fsyncs, then marks frames as committed-dirty (written to the data file later). `rollback` drops changed frames and rewinds the WAL. `checkpoint` writes all dirty frames to the data file and empties the WAL. On open, `recover` replays the WAL up to the last commit. Eviction is clock-sweep (`victim`); if every frame is uncommitted, `spill` pushes one to the WAL so a big statement can still proceed. Page 0 is the meta page (page count, freelist head, catalog roots, id counter); `allocPage` / `freePage` manage the freelist.

## `src/storage/heap.ts` — a table's rows
A `Heap` is a chain of pages; special space on each page holds `next`, and the root also holds `last`. `insert` appends to the last page or grows the chain; a row's address is `TID = { page, slot }`. `get`, `delete`, `update` (in place if it fits, else delete + insert), `scan` (page by page, copies rows out so callers may write during iteration), `drop` (free every page).

## `src/storage/btree.ts` — the index
A B+tree in the shape of PostgreSQL's nbtree. Meta page stores the root. Node special space: `prev`, `next`, `level`, `flags`. Every item = `ptr | tid | key`; leaves use the tid (row address), internal nodes use ptr (child page). Non-rightmost pages hold a high key as item 0. Items are ordered by `(key, tid)`, so duplicates and exclusive bounds work by searching with a minimum or maximum tid. `insert` descends recording the path, inserts, and on a full page calls `splitPage`, which chooses the split point by bytes (budgeting the separator), rewrites the left page, allocates the right, fixes sibling links, and pushes a downlink up (root split creates a new root). `remove` deletes an exact entry, no merging. `scan` walks leaves via `next` for range queries; `lookup` is equality. `verify` and `height` exist for tests.

## `src/catalog.ts` — tables about tables
Three system tables with hardcoded schemas: `__tables (id, name, root_page)`, `__columns (table_id, ordinal, name, type, not_null, pk)`, `__indexes (id, name, table_id, column_name, meta_page, is_unique)`. Their heap roots live in the meta page. `load` reads them all into an in-memory map of `TableDef`. `createTable` / `createIndex` / `dropTable` / `dropIndex` write the rows and update the map. A `PRIMARY KEY` column automatically gets a unique index named `<table>_pkey`.

## `src/sql/lexer.ts` — text to tokens
`tokenize` produces keywords (uppercased), identifiers (lowercased unless double-quoted), numbers, strings (with `''` escape), and operators. Handles `--` and `/* */` comments. Outer-join words are reserved so they cannot be mistaken for aliases.

## `src/sql/ast.ts` — the tree shapes
Plain TypeScript types: `Expr` (literal, column, binary, not, neg, isnull) and one interface per statement (`SelectStmt`, `InsertStmt`, `UpdateStmt`, `DeleteStmt`, `CreateTableStmt`, `CreateIndexStmt`, `DropStmt`, transaction statements, `ExplainStmt`).

## `src/sql/parser.ts` — tokens to tree
Recursive descent for statements; Pratt parsing for expressions with binding powers OR < AND < NOT < comparison < additive < multiplicative < unary minus. Comparison is non-associative (`a = b = c` is an error). Rejects `LEFT/RIGHT/FULL/CROSS JOIN` and `USING` with a clear message. Requires `;` between statements.

## `src/sql/expr.ts` — names and types
`Scope` maps table aliases to column positions in a flat row and resolves `t.col` / `col` (errors on ambiguity or unknown names). `compile` turns an `Expr` into a `Compiled` object: a result type plus an `eval(row)` closure. Type checking happens here, PostgreSQL-strict: operands must match, arithmetic is INT only, AND/OR/NOT need BOOL, NULL propagates with three-valued logic. `conjuncts` / `andAll` split and rejoin `AND` chains for the planner.

## `src/sql/executor.ts` — the nodes that run a query
Volcano model: every node has `open`, `next` (one row or null), `close`, `setParam`. `SeqScanNode` walks a heap; `IndexScanNode` asks a B-tree for a key range then fetches each row; `FilterNode` keeps rows whose predicate is true; `NestedLoopNode` loops the outer, re-opens the inner per outer row (passing the outer row as parameters, so an inner index scan can use it); `SortNode` materialises and sorts (NULLs last for ASC, first for DESC); `LimitNode`; `ProjectNode` computes the select list; `OneRowNode` for `SELECT` without `FROM`. `collect` drains a node into an array. Each node also has `explain`.

## `src/sql/planner.ts` — choosing how to run it
`planSelect` builds the node tree. Gathers all `WHERE` and `ON` conjuncts with the set of tables each references. For every table (`planScan`) it looks for a conjunct `col op value` where `col` is indexed and `value` depends only on constants or tables to the left; preference order unique-equality > equality > range > seq scan. Remaining single-table conjuncts become a `Filter` right above the scan; cross-table ones become the join qual. Joins are left-deep nested loops in `FROM` order. Then Sort (ORDER BY resolves ordinals and output aliases against the select list first), Limit, Project. `exprText` renders expressions for `EXPLAIN`.

## `src/database.ts` — the front door
`Database.exec(sql)` parses and runs each statement. Autocommit by default; `BEGIN` opens an explicit transaction, and a failed statement inside it puts it into PostgreSQL's aborted state until `ROLLBACK`. `insert` / `update` / `delete` compile values, collect target rows first (so an index scan never sees rows it just moved), then `writeRow` enforces `NOT NULL` and `UNIQUE`, writes the heap, and maintains every index (only the entries whose key changed or whose row moved). `buildIndex` fills a new index from existing rows. `drop` frees the table's and its indexes' pages.

## `src/repl.ts` — the shell
Readline loop. Accumulates lines until `;`, runs them, prints result tables, and offers `.tables`, `.schema`, `.indexes`, `.stats`, `.exit`.

## `src/index.ts` — public exports
What a library user imports: `Database`, `Pager`, `Heap`, `BTree`, `Page`, `parse`, value helpers.

## `test/`
- `helpers.ts`: `FaultFS`, an in-memory file system where writes only become durable on `fsync`; `crash('drop'|'torn')` throws away or half-applies unsynced writes; `failNext` makes a chosen read/write/fsync throw; `corruptDurable` zeroes bytes on "disk".
- `page.test.ts`, `pager.test.ts`, `heap-btree.test.ts`: unit tests per layer, including a 6,000-operation B-tree fuzz against a reference map.
- `sql.test.ts`: end-to-end SQL behaviour.
- `review-regressions.test.ts`: one test per finding in `review.md`.
- `crash-child.ts` + `crash.test.ts`: a real child process committing batches on a real file, `SIGKILL`ed six times; every batch must be all-or-nothing afterwards.

## `video/`, `docs/`
`video/scenes.html` (deterministic scenes driven by `seekTo(t)`), `video/script.json` (narration), `video/tts.py` (open-source voice via sherpa-onnx), `video/render.mjs` + `render.sh` (Playwright frames + ffmpeg). `docs/explainer.html` is the interactive page, `docs/HOW-WE-BUILT-IT.txt` the prose story, `docs/research-*.md` the source notes.
