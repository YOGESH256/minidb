# Start here

You do not need to understand all of `src/` at once. Two paths.

## Path A: the ladder (recommended if databases are new to you)

`ladder/` is the same database grown in five small steps. Each file adds **one idea** on top of the previous file and has one test that shows what breaks without it.

| Step | File | The one idea | Question it answers |
|---|---|---|---|
| v0 | `ladder/v0-array.ts` | rows in an array, saved as JSON | "why not just a JSON file?" |
| v1 | `ladder/v1-pages.ts` | 4 KB pages with slots | "how do we change one row without rewriting the file?" |
| v2 | `ladder/v2-wal.ts` | write-ahead log + commit + recovery | "how do we survive a power cut?" |
| v3 | `ladder/v3-btree.ts` | a B+tree index | "how do we find id = 4 without reading every row?" |
| v4 | `ladder/v4-sql.ts` | parser + planner + executor | "how does text become a query plan?" |

Run all five: `npx vitest run ladder`. Read them in order; each is 150–300 lines.

When you finish v4 you have seen every idea in `src/`. The real engine is the same thing with the edge cases handled (variable-length keys, NULLs, joins, page eviction, torn pages, aborted transactions).

## Path B: the real code, in the right order

Read only these four files first. Together they are a working "store rows, get them back" database:

1. `src/types.ts` — what a value looks like in bytes
2. `src/storage/page.ts` — one 4 KB block
3. `src/storage/heap.ts` — a table as a chain of blocks
4. `src/database.ts`, the `insert` and `select` methods only

Then, one at a time, as questions come up:

- "What if the power goes out?" → `src/storage/wal.ts`, then `commit` / `rollback` / `recover` in `src/storage/pager.ts`
- "Why is `WHERE id = 4` fast?" → `src/storage/btree.ts` (`insert`, `scan`), then `planScan` in `src/sql/planner.ts`
- "How does text become a plan?" → `src/sql/lexer.ts` → `parser.ts` → `expr.ts` → `executor.ts`
- "Where is the list of tables kept?" → `src/catalog.ts`

Every file in `src/` starts with a picture and a plain-English paragraph. Read those before the code.

## Other material

- `docs/explainer.html` — click each layer, step through one INSERT, pull the plug
- `video/minidb-explained.mp4` — the same in 2 min 42 s
- `docs/HOW-WE-BUILT-IT.txt` — the story in prose
- `docs/CODE-TOUR.md` — every file in one paragraph each
- `review.md` — the ten bugs a code review found, and how each was fixed. Good for "what goes wrong in real engines".
