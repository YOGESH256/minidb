# Research: Postgres-shaped storage internals

Compiled 2026-09-09 from PostgreSQL docs/source, SQLite WAL format, CMU 15-445, cstack, toydb, *Database Internals*.

## 1. Heap page layout (PG `bufpage.h`, `itemid.h`)

Five regions: `PageHeaderData` (24 B) → line pointers (4 B each, grow forward from `pd_lower`) → free space → tuples (allocated backward from `pd_upper`) → special space (`pd_special`..end).

PageHeaderData: `pd_lsn` u64, `pd_checksum` u16, `pd_flags` u16, `pd_lower` u16, `pd_upper` u16, `pd_special` u16, `pd_pagesize_version` u16, `pd_prune_xid` u32.

ItemIdData = 32 bits: `lp_off:15`, `lp_flags:2`, `lp_len:15`. Flags `LP_UNUSED=0`, `LP_NORMAL=1`, `LP_REDIRECT=2`, `LP_DEAD=3`.

Free space = `pd_upper - pd_lower`; insert fits iff `free >= align(len) + 4`. Compaction moves tuples toward `pd_special`, rewrites `lp_off`; line-pointer indices stay stable so TID `(page, slot)` survives.

`pd_lsn` enforces "write xlog before data".

- https://www.postgresql.org/docs/current/storage-page-layout.html
- https://github.com/postgres/postgres/blob/master/src/include/storage/bufpage.h
- https://github.com/postgres/postgres/blob/master/src/include/storage/itemid.h

## 2. WAL

XLogRecord (24 B): `xl_tot_len` u32, `xl_xid` u32, `xl_prev` u64, `xl_info` u8, `xl_rmid` u8, pad 2, `xl_crc` u32 (last; CRC covers payload then header-before-crc). Bad CRC / short read = end of valid log.

LSN = byte offset in WAL stream. Page `pd_lsn` = end-LSN of last record touching it.

WAL-before-data: modify page → mark dirty → XLogInsert → PageSetLSN. Buffer manager must `XLogFlush(page.lsn)` before writing a dirty page.

Checkpoint: flush dirty buffers, write checkpoint record, store redo pointer. Recovery scans forward from it. First touch of a page after checkpoint logs a full-page image (torn-page protection).

Redo idempotent: skip if `page.lsn >= record.lsn`, else apply and set lsn. Full-page image replay just overwrites.

Minimal redo-only log for single-writer engine:
1. Record `[len][type][pageId][payload][crc32]`, append-only, fsync on commit.
2. Never write a page whose lsn > durable WAL end.
3. Commit marker record; recovery applies only up to last commit marker (SQLite commit-frame rule).
4. Torn pages: log full page images (SQLite frame = 24 B header + full page, salts + cumulative checksum).
5. Checkpoint = flush + truncate WAL.

- https://github.com/postgres/postgres/blob/master/src/include/access/xlogrecord.h
- https://github.com/postgres/postgres/blob/master/src/backend/access/transam/README
- https://www.postgresql.org/docs/current/wal-internals.html
- https://www.sqlite.org/fileformat2.html#walformat

## 3. B+tree (PG nbtree)

Special space `BTPageOpaqueData` (16 B): `btpo_prev` u32, `btpo_next` u32, `btpo_level` u32 (0 = leaf), `btpo_flags` u16 (`LEAF 1`, `ROOT 2`, `DELETED 4`, `META 8`, `HALF_DEAD 16`, `INCOMPLETE_SPLIT 128`), `btpo_cycleid` u16. Block 0 = metapage (`btm_root`, `btm_level`).

High key: on non-rightmost pages item 1 is the high key (upper bound); data starts at item 2. Rightmost has none. Internal item = (separator key, child block); first item's key = -∞. Leaf item = TID (6 B) + key; sorted by (key, TID).

Right-link + high key (Lehman-Yao): reader that lands on a page with highkey < key moves right. Also gives leaf range scan as linked-list walk.

Split: trigger when free < itemsz; choose split point by bytes; right gets old high key + items ≥ split; left high key = first item of right; fix sibling links; insert (leftHighKey, rightBlock) into parent, recurse; root split makes new root. Max item ≈ 1/3 page.

Search: root → binary search last key ≤ search key → downlink; leaf: first key ≥ lower bound; range scan follows `btpo_next`. Delete: remove item, no merge needed for correctness (PG never merges).

Variable-length keys: slotted page handles it; split by cumulative bytes.

- https://github.com/postgres/postgres/blob/master/src/backend/access/nbtree/README
- https://github.com/postgres/postgres/blob/master/src/include/access/nbtree.h
- https://github.com/postgres/postgres/blob/master/src/backend/access/nbtree/nbtinsert.c

## 4. Buffer pool

PG uses clock-sweep (usage_count ≤ 5, hand cycles, decrement or evict when refcount 0). Pin = refcount, unpinned may be evicted. Dirty flag set on modify; write deferred to eviction/checkpoint. `FlushBuffer` → `XLogFlush(page.lsn)` → write.

- https://github.com/postgres/postgres/blob/master/src/backend/storage/buffer/README
- https://github.com/postgres/postgres/blob/master/src/backend/storage/buffer/freelist.c

## 5. Volcano executor

`ExecInitNode` / `ExecProcNode` (next tuple or NULL) / `ExecEndNode` / `ExecReScan`. Nested loop: fetch outer, rescan inner, loop inner, test join qual, project. SeqScan walks pages/line pointers in TID order. IndexScan asks index for next matching TID, fetches heap tuple, output in key order.

- https://github.com/postgres/postgres/blob/master/src/backend/executor/README
- https://github.com/postgres/postgres/blob/master/src/backend/executor/nodeNestloop.c

## 6. Reference projects

- cstack db_tutorial (C): 4096 pages, fixed-cell B-tree, no WAL, cursor executor. https://cstack.github.io/db_tutorial/
- toydb (Rust): BitCask KV, Raft, MVCC, clean iterator executor. https://github.com/erikgrinaker/toydb
- CMU 15-445 BusTub (C++): LRU-K buffer pool, slotted B+tree, `Init()/Next()` executors. https://15445.courses.cs.cmu.edu/fall2024/project1/
- *Database Internals* (Petrov) ch 2-5: slotted pages, splits, buffer mgmt, WAL/ARIES.
