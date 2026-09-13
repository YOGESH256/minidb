# minidb — Code Review

**Date:** 2026-09-14
**Scope:** `src/` read pass (pager, WAL, page, heap, B-tree, facade, planner, node I/O), focused on what the previous review did not cover
**Method:** source-level review; prior review findings verified against the code rather than trusted

---

## Summary

| # | File | Line | Area | Severity |
|---|------|------|------|----------|
| 1 | `src/database.ts` | 202 | Transaction facade | Medium |
| 2 | `src/database.ts` | 519 | Index build | Low |
| 3 | `src/database.ts` | 194 | Prepared statements | Low (perf) |
| 4 | `src/storage/btree.ts` | — | Integrity API | Low (product) |
| 5 | `.tmp/`, `docs/archive/` | — | Housekeeping | Low |

The 2026-09-09 review's ten fixes were spot-checked in code and are present: WAL rewind on failed commit (`pager.ts:215`), separator budgeting in splits (`btree.ts:242-263`), write-back before pin (`pager.ts:297`), zero-page corruption detection (`pager.ts:409-412`), PG aborted-transaction state (`database.ts:294-303`). Still-open items from its cut list re-confirmed: heap free space unreclaimed until compaction, no top-N Sort under LIMIT, NULLs not indexed, reserved keywords unusable as identifiers.

Suggested fix order: 1 first (data-integrity footgun), then 2; 3 and 4 are improvements, not defects.

---

## Findings

### 1. `transaction(fn)` accepts asynchronous callbacks — commits partial work

**File:** `src/database.ts:202-215`

`fn` is invoked and `COMMIT` executes immediately on the returned value. If `fn` is `async`, it returns an unresolved Promise; the commit succeeds while the callback's actual work is either unfinished or absent. The later rejection of that Promise cannot trigger rollback — the transaction is already committed, and the rejection surfaces as an unhandled-rejection. Any caller that composes async I/O with this helper can silently persist a partial transaction.

**Evidence:** `docs/archive/REAL-USE-CASES-2026-09-13.md` already lists this as an open API concern. The code has no guard yet. The helper is the primary integration surface (job runners, framework adapters), so this is the first footgun an adopter hits.

**Fix direction:** after `const r = fn(...args)`, reject thenable results (`isThenable(r) → throw TypeError_('transaction callback must be synchronous')`) before committing. Optionally await nothing and document the synchronous contract in the type signature.

---

### 2. `buildIndex` deduplicates values via `String(v)`

**File:** `src/database.ts:519`

Duplicate detection while building a unique index stringifies values into a `Set<string>`. It is correct today only because a column is single-typed and the three types stringify injectively. As soon as a new type (e.g., a JSON or binary value) is added, distinct values can collide or equal values can diverge in string form. `compareValues`/`compareEncoded` already define the single canonical ordering — stringification bypasses it.

**Fix direction:** compare encoded buffers (`Buffer.compare` via `compareEncoded`) instead of `String(v)`.

---

### 3. Prepared statements re-plan on every execution

**File:** `src/database.ts:92-196` (`runBound` → `bindParams` → `runStatement`)

`prepare()` parses once, which is real work saved, but every `run/get/all/raw` call substitutes parameters into the AST and plans the statement from scratch. For point lookups — the hot path any queue/session workload uses — planning overhead exceeds execution. Not a correctness issue; a performance one that matters once there are adopters.

**Fix direction:** cache plans keyed by parameter-free statement shape, or keep parameters as values consulted at execution (planner already supports parameterized bounds for joins; the same mechanism applies).

---

### 4. No user-facing integrity check

**File:** `src/storage/btree.ts:393` (`verify` is test-internal)

`BTree.verify()` walks leaf links, ordering, and high keys, but only tests invoke it. Given that the crash-test suite is the project's main trust argument for holding data, a public `CHECK`/verify API (B-tree structure + heap chain + catalog consistency) would let adopters audit their own files rather than trust the README.

**Fix direction:** expose a `db.verify()` that runs B-tree `verify()` per index plus heap-chain and catalog-root traversal; report as structured results, not just throw.

---

### 5. Scratch and archive clutter in the repo root/docs

**Paths:** `.tmp/`, `docs/archive/`

`.tmp/` holds the reproduction scripts and databases from the 2026-09-09 review — useful once, confusing to adopters reading the repo top to bottom. `docs/archive/` is accumulating direction papers while `docs/DIRECTION.md`, `docs/EDGE-DIRECTION.md`, and the archived use-case studies overlap.

**Fix direction:** move `.tmp/` scripts under `test/` as reusable crash helpers or delete them; consolidate direction docs so a reader lands on exactly one current-direction file.

---

## Resolution (2026-09-14)

| # | Status | Change |
|---|--------|--------|
| 1 | Fixed | `transaction(fn)` throws `transaction callback must be synchronous` when the callback returns a thenable, and rolls back. Test in `test/api.test.ts`. |
| 2 | Fixed | `buildIndex` dedupes on the encoded key bytes (the identity the index uses), not `String(v)`. |
| 3 | Fixed | See the commit "plan once per prepared statement"; parameters stay runtime values, Statement caches the compiled plan. Benchmark in that commit message. |
| 4 | Fixed | `db.verify()` returns `{ ok, problems, tables, indexes, rows, entries, pages }`: catalog roots and page types, heap chain + `last` pointer, B-tree structure, every index entry resolved against its row. Test plants a dangling entry. |
| 5 | Partly stale | `.tmp/` is gitignored and never was in the repo. `docs/archive/` exists deliberately so `docs/DIRECTION.md` is the one current page; nothing further. |
