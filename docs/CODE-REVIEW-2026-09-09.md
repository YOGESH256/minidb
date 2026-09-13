# minidb — Code Review

**Date:** 2026-09-09
**Scope:** full repository (`src/`), effort level: high
**Method:** every finding below was reproduced by executing minidb against a real file (fault-injected WAL / file I/O where noted). Findings are ranked most severe first. A further set of lower-severity items that were confirmed but cut by the 10-finding cap is listed at the end.

---

## Summary

| # | File | Line | Area | Severity |
|---|------|------|------|----------|
| 1 | `src/storage/pager.ts` | 157 | Durability | Critical |
| 2 | `src/storage/pager.ts` | 273 | Durability | Critical |
| 3 | `src/storage/pager.ts` | 244 | Capacity | High |
| 4 | `src/storage/pager.ts` | 280 | Corruption detection | High |
| 5 | `src/storage/btree.ts` | 248 | Correctness | High |
| 6 | `src/sql/parser.ts` | 170 | SQL semantics | High |
| 7 | `src/database.ts` | 74 | Transaction facade | High |
| 8 | `src/storage/pager.ts` | 205 | Transaction facade | Medium |
| 9 | `src/database.ts` | 92 | Transaction semantics | Medium |
| 10 | `src/sql/planner.ts` | 76 | SQL semantics | Medium |

Suggested fix order: 1 and 2 first (both lose or resurrect committed data), then 7 and 8 (session wedges), then the rest.

---

## Findings

### 1. `commit()` never rewinds the WAL on failure — aborted transactions are replayed on recovery

**File:** `src/storage/pager.ts:157`

Page images (and possibly the COMMIT record) appended by a commit that then throws are left in the log. The next successful commit's COMMIT record covers them, and `recover()` replays every image with index below `lastCommit`, resurrecting a transaction the caller was told rolled back.

**Reproduced:**

- T1 modifies pages 1 and 2. `appendPageImage` for page 2 throws ENOSPC after page 1's image is in the log. `Database` catches and calls `pager.rollback()` (in-memory state is correct). T2 commits an unrelated page. Crash before checkpoint, reopen: page 1 reads T1's aborted content (`'B1'` instead of the committed `'A1'`).
- Variant: `appendCommit` succeeds and only `wal.fsync` throws. After T2's fsync the aborted transaction is fully committed on recovery (`UPDATE t SET s='ROLLEDBACK'` reappears after power loss).
- Heap and index pages can also come back half-applied.

**Fix direction:** record the WAL offset at `begin()`; on any commit failure truncate (or logically rewind) the WAL to that offset before rethrowing, so no image from the failed transaction can fall under a later COMMIT record.

---

### 2. `readInto()` assigns `pageId` before the read can throw — ghost frame later drops a live mapping and loses committed writes

**File:** `src/storage/pager.ts:273`

A failed load leaves an unmapped frame carrying the page id. When the clock sweep evicts that ghost frame it calls `pageTable.delete(pageId)`, which removes a *different* frame's legitimate entry. Two frames now hold the same page; checkpoint writes them in index order and the stale one lands last.

**Reproduced:**

1. `acquire(5)`: read throws EIO / checksum failure. Frame A: `pageId=5`, unmapped, unpinned.
2. `acquire(5)` again: frame B mapped, written, committed (dirty).
3. Clock sweep evicts A: `pageTable.delete(5)` drops B's mapping.
4. `acquire(5)`: frame C loaded from disk (stale), written, committed.
5. `checkpoint()` writes frames in index order; B's stale image lands last. Data file holds the older value; reopen reads it (committed `0xC0C` lost, `0xB0B` on disk).

**Fix direction:** only assign `f.pageId` (and insert into `pageTable`) after the read and checksum succeed; on failure reset the frame to free. Eviction should also assert `pageTable.get(f.pageId) === f` before deleting.

---

### 3. Any statement that dirties more than `poolSize` (512) pages aborts with "buffer pool exhausted"

**File:** `src/storage/pager.ts:244`

Transaction-dirty frames are unevictable and every statement is its own transaction, so the pool size is a hard ceiling on per-statement write volume. The README's own 50k-row benchmark table cannot be bulk-updated, emptied, indexed, or dropped. The ceiling is not documented under "Deliberate limits".

**Reproduced:** load 50k rows at 500 per statement as the README describes (succeeds). Then each of the following throws `buffer pool exhausted: all frames pinned or uncommitted` and rolls back:

```sql
DELETE FROM t;
UPDATE t SET n = n + 1;
CREATE INDEX t_s ON t (s);
DROP TABLE t;           -- freePage → markDirty on every page
```

Same for `BEGIN; <~2 MB of inserts>; COMMIT`.

**Fix direction:** either allow dirty frames to be evicted by first writing their image to the WAL (steal policy, which the WAL already makes safe), or document the limit and fail early with a clear message.

---

### 4. `readInto()` treats an all-zero (or short) page as "fresh" for any page id, including allocated ones

**File:** `src/storage/pager.ts:280`

A zero-filled page below `meta.pageCount` after a crash is accepted as valid. `itemCount` becomes -6, `special` aliases the header, and scans silently end early instead of raising a corruption error.

**Reproduced on a real file:**

- Checkpointed heap chain `[4,7,8,11,13]`; filesystem zero-fills page 8 after power loss (WAL already truncated). Reopen, `SELECT * FROM t` returns 142 of 300 rows, no error (`S_NEXT` reads LSN bytes = 0).
- Zeroed B-tree leaf: `WHERE id = 150` and `WHERE id > 100` return 0 rows, no error. `INSERT` into it throws `RangeError: slot 0 out of range`.

**Fix direction:** only accept a zero page as fresh when `pageId >= meta.pageCount` (or when it is on the free list); otherwise raise a corruption error.

---

### 5. `splitPage()` picks the split point without budgeting for the separator high key

**File:** `src/storage/btree.ts:248`

The split point is chosen by cumulative bytes only. The separator that becomes the left page's high key is not counted, so with keys near `MAX_KEY_SIZE` the left-page rewrite throws `PageFullError` mid-split and a legal `INSERT` (or a whole explicit transaction) fails.

**Reproduced:** TEXT index; insert random keys alternating 996-byte and 1–30-byte strings. Seed 1 fails at insert #82, seed 3 at #32:

```
page full: need 1014 bytes, have 969
```

thrown from `lf.page.insertItemAt(0, separator)` at line 275, after the right sibling was allocated and `view.next` relinked. The statement rolls back. The line-39 comment ("a page can always hold a high key + 3 items after a split") does not hold.

**Fix direction:** include the separator's serialized size in the left-page budget when choosing the split index; assert the invariant after the split.

---

### 6. `LEFT JOIN` silently parses as `AS left INNER JOIN`

**File:** `src/sql/parser.ts:170`

`LEFT`, `RIGHT`, `FULL`, `OUTER`, `CROSS`, `NATURAL` are not lexer keywords, so `FROM a LEFT JOIN b` parses as `FROM a AS left INNER JOIN b` and runs as an inner join.

**Reproduced:** `users(1,ann),(2,bob),(3,cy)`; `o(uid=1)`.

- `SELECT * FROM users LEFT JOIN o ON id = uid` returns only `[1,'ann',31,1,10]` with no error (bob, cy dropped).
- With qualified columns (`ON users.id = o.uid`) it errors with the misleading `missing FROM-clause entry for table "users"` because the table was aliased to `left`.

**Fix direction:** add these words to the lexer keyword set and either implement outer joins or reject them with an explicit "not supported" error.

---

### 7. Explicit `COMMIT` clears `explicitTxn` before `pager.commit()` — a throw wedges the session

**File:** `src/database.ts:74`

If `pager.commit()` throws, `pager._inTxn` stays `true` while the facade believes no transaction is open.

**Reproduced with a fault-injected WAL:** `BEGIN; INSERT …; COMMIT` where the WAL write/fsync throws (EIO/ENOSPC). `COMMIT` rethrows; afterwards:

- `ROLLBACK` → `there is no transaction in progress`
- `SELECT 1`, `BEGIN` → `transaction already open` (from `pager.begin` at `pager.ts:146`)
- `db.inTransaction` reports `false`

Only `close()` escapes. The autocommit path is safe because its catch calls `pager.rollback()`.

**Fix direction:** call `pager.commit()` first and clear `explicitTxn` only on success; on failure call `pager.rollback()` and rethrow.

---

### 8. `acquire()` pins before the in-transaction `writeBack` — an I/O error leaks the pin and later wedges rollback

**File:** `src/storage/pager.ts:205`

`pinCount` is incremented before the `writeBack` at line 212. If `writeBack` throws, the pin on a committed-dirty frame is leaked. The next statement that dirties that page and fails makes `rollback()` throw `rollback with pinned page` (masking the real error) after half-clearing `txnDirtySet`, leaving `_inTxn=true` forever.

**Reproduced:** `INSERT` → `Heap.insert` → `with(rootPage)` → `acquire`: `pinCount++`, then `writeBack` throws EIO once. `with()` releases nothing (acquire is outside its try), heap root frame pin=1 leaked; rollback succeeds this time. Disk healthy again; a routine `INSERT (3),(1)` unique violation dirties the root → `rollback()` (line 176) throws `rollback with pinned page 4` instead of `ConstraintError`, `txnDirtySet` left with 2 entries. Every later statement throws `transaction already open` and `close()` throws before checkpointing.

**Fix direction:** perform `writeBack` before incrementing `pinCount`, or wrap it so the pin is released on throw.

---

### 9. A failed statement inside `BEGIN` silently flips the session back to autocommit

**File:** `src/database.ts:92`

A caller that catches the error and continues has its subsequent statements durably committed one by one, and its eventual `ROLLBACK` errors instead of discarding them.

**Reproduced:**

```ts
db.exec('BEGIN');
try { db.exec("INSERT … (1,'dup')"); } catch {}
db.exec("INSERT … (9,'nine')");   // committed immediately; db.inTransaction === false
db.exec('ROLLBACK');              // throws: there is no transaction in progress; row 9 survives
```

PostgreSQL would reject the second `INSERT` (`current transaction is aborted`) and `ROLLBACK` would discard everything. The README documents whole-transaction rollback but not this autocommit fall-through.

**Fix direction:** keep the transaction open in an "aborted" state after a statement failure; reject further statements until `ROLLBACK`, matching PG. At minimum, document the behaviour.

---

### 10. `ORDER BY` ordinal is a constant sort key; `ORDER BY <alias>` is unresolvable

**File:** `src/sql/planner.ts:76`

`ORDER BY` compiles its expression as a plain scalar over the FROM scope. An integer ordinal becomes a constant key (silent no-op) and an output-column alias cannot be resolved, unlike PostgreSQL where both refer to select-list positions.

**Reproduced:**

- `SELECT id, age FROM users ORDER BY 2 DESC` returns heap order `[1,31],[2,NULL],[3,25]` with no error (constant key → `SortNode` leaves input order).
- `SELECT age AS a FROM users ORDER BY a` throws `column "a" does not exist`.

**Fix direction:** resolve `ORDER BY` against the projected select list first (ordinal → position, alias → position), falling back to the FROM scope.

---

## Confirmed but cut by the 10-finding cap (lower severity)

- Heap free space is never reused after `DELETE`.
- Non-boolean `WHERE` expression yields an empty result instead of an error.
- `ORDER BY x DESC` sorts `NULL`s last (PG puts them first for `DESC`).
- Duplicate `Filter` node emitted for a `WHERE` with no `FROM`.
- Index-name check uses a `_pkey` suffix match rather than catalog metadata.
- Reserved keywords accepted as identifiers.
- Eager write-back on read paths.
- `Sort` has no top-N path when `LIMIT` is present.
- `UPDATE` re-indexes keys that did not change.
- Dead exports in several modules.

---

## Resolution (2026-09-09)

All ten findings fixed. Each has a regression test in `test/review-regressions.test.ts`, numbered to match. Full suite: 34 tests, all passing (`npm test`).

| # | Status | Change | Test |
|---|--------|--------|------|
| 1 | Fixed | `begin()` records the WAL end offset; `commit()` rewinds to it on any failure (`Wal.truncateTo`, made durable); `rollback()` rewinds too. | `#1` — write failure on 2nd page image, and fsync failure after COMMIT record; crash + reopen shows only committed values |
| 2 | Fixed | `readInto()` no longer touches frame metadata. `acquire()` guards the frame with a temporary pin during load, assigns `pageId` and the page-table entry only after read + checksum succeed, resets the frame on failure. `evictFrame()` asserts `pageTable.get(id) === f`. | `#2` — failed load, then write/commit/churn/write/checkpoint/reopen reads the latest value |
| 3 | Fixed | Steal policy. When every unpinned frame is txn-dirty the clock's second sweep spills the victim's image to the WAL (no fsync) and frees the frame; re-reads come from the WAL; commit's COMMIT record covers the spilled images; rollback rewinds past them. The per-statement pool ceiling is gone. | `#3` — 4000 rows in a 32-frame pool: bulk INSERT/UPDATE/CREATE INDEX/DELETE/DROP; `BEGIN; DELETE FROM t; ROLLBACK` restores; crash after a spilled commit recovers |
| 4 | Fixed | A zero-filled or short page is accepted as fresh only when it is being allocated (`acquire(id, fresh=true)` from `allocPage`) or lies at/after the meta page count; otherwise `CorruptionError`. | `#4` — zeroed heap page after checkpoint raises on SELECT; pages beyond the count still read as fresh |
| 5 | Fixed | Split point search budgets the separator (left high key) and the old high key (right page); among feasible points picks the most balanced; asserts free space after the rewrite. Misleading `MAX_KEY_SIZE` comment corrected. | `#5` — 5 seeds × 400 inserts alternating 996-byte and tiny keys, `verify()` after each |
| 6 | Fixed | `LEFT RIGHT FULL OUTER CROSS NATURAL USING` are lexer keywords; the parser rejects them with `<KW> JOIN is not supported (only INNER JOIN)` / `JOIN ... USING is not supported`. | `#6` |
| 7 | Fixed | `Database.endTxn()` calls the pager first and clears the facade flags in `finally`; on a commit failure it rolls the pager back and reloads the catalog. | `#7` — WAL fsync failure on COMMIT; session continues, nothing persisted |
| 8 | Fixed | In-transaction write-back runs before `pinCount++` in `acquire()`, so a failure cannot leak a pin. | `#8` — data-file write failure during INSERT, then a duplicate-key error surfaces as `ConstraintError`, not `rollback with pinned page` |
| 9 | Fixed | PG aborted-transaction state: a failed statement sets `aborted`; further statements throw `current transaction is aborted, commands ignored until end of transaction block`; `ROLLBACK` clears; `COMMIT` rolls back and returns `ROLLBACK`. Partial effects of the failed statement stay in the buffer pool and die with the rollback. | `#9` |
| 10 | Fixed | Select list is compiled before `ORDER BY`; an integer literal is a 1-based ordinal, a bare name matching an output alias refers to it, otherwise the FROM scope. Errors for out-of-range ordinals and non-integer constants. | `#10` |

Also taken from the cut list:

- Non-boolean `WHERE` / `ON` is a type error (`argument of WHERE must be type BOOL`). Test: `cut list: non-boolean WHERE`.
- `ORDER BY x DESC` now puts NULLs first (PG). Covered by `#10`.
- `UPDATE` rewrites an index entry only when its key changed or the row moved to a new TID (unique check also skipped for unchanged keys).
- Dead `Heap`/`Page` re-exports removed.

Found while fixing, not in the review: the spill fallback originally picked frames in array order, which thrashed the hottest pages (3,973 spills for a 200-page insert); it now reuses the clock sweep with usage counts (190 spills on the same workload).

Still open from the cut list (perf/polish, not correctness): heap free space is not reused after DELETE until the page is compacted by a later insert on it; `Sort` has no top-N path under `LIMIT`; reserved keywords are not usable as identifiers; index-name `_pkey` check is by suffix; a `WHERE` with no `FROM` emits a redundant Filter node.
