# The custodian

Branch `explore/custodian`. Something that lives with the data and notices things.

It is **not** an autonomous tuner. It never changes the database. That distinction is the whole design: a database's value is that it does exactly what you told it, which is why Microsoft ships automatic index creation [disabled by default](https://learn.microsoft.com/en-us/azure/azure-sql/database/automatic-tuning-overview) after eight years. A custodian reports; you decide.

```ts
const db = new Database('shop.db', { custodian: true });
// ... ordinary traffic, for a week ...
db.notice();   // Finding[]
```

## What it noticed in the demo

`npx tsx examples/custodian-demo.ts` runs a week of a small shop's traffic. Nothing in it asks a question; the custodian just watches.

```
warning [null-rate-shift]
  coupon in orders was 67% empty and is now 94%. Something that used to fill it may have stopped.

warning [row-churn]
  Row 12 in orders changed 12 times and returned to a previous value 11 times.
  Two writers may be overwriting each other.

suggestion [missing-index]
  40 queries scanned all of "orders" to filter on status, reading 71 pages each time
  to return 4 of 8,000 rows. An index on status would read about 7, roughly 10.1x less work.
  → CREATE INDEX orders_status ON orders (status);

suggestion [unused-index]
  Index "orders_coupon" on orders(coupon) has been maintained through 14,511 row writes
  and no query has used it.
  → DROP INDEX orders_coupon;
```

Taking the index advice: the query went from **71 pages to 7**, exactly the 10.1× the custodian predicted.

Two of those four are performance. The other two are not, and they are the ones no tuner would report: a column that quietly stopped being filled by a deploy, and a row two jobs are fighting over. Those are what a careful person would notice if they sat with your data every day, and nobody sits with your data.

## What it can notice

| Kind | Severity | What it means |
|---|---|---|
| `missing-index` | suggestion | A recurring query scans the table, and an index would read materially fewer pages |
| `unused-index` | suggestion | An index is maintained on every write and no query has used it |
| `null-rate-shift` | warning | A column's empty share jumped, usually because something upstream broke |
| `row-churn` | warning | One row keeps returning to a previous value: two writers disagreeing |
| `history-outgrew-data` | info | Change receipts now outweigh live rows; pruning would reclaim the space |

Every finding carries its `evidence`, so you can disagree with it.

## How the index advice is costed

Selectivity alone is not enough, and the first version of this got it wrong. A query returning 80 rows from a 45-page table looks selective at 2%, but those rows are scattered across nearly every page, so an index scan touches nearly every page too and pays for the tree on top. The test caught it suggesting an index that made the query *slower*.

The rule now costs both sides:

```
scan  = pages the sequential scan reads
index = 3 (tree descent) + min(rows returned, scan pages)   // one heap page per row, worst case
suggest only when scan / index >= minSpeedup   (default 2)
```

That is why the demo's 4-rows-in-8,000 case is suggested (71 vs 7 pages) and a 80-rows-in-4,000 case is not. Real planners model this as clustering; this is the cheap version of the same idea.

## How it works

It reads what the engine already knows, and adds one thing.

- **Access paths.** `planSelect` now returns `paths: AccessPath[]`, saying for each table whether it was reached by a sequential scan or an index, which index, and which columns were filtered *after* the scan. Those leftover columns are the evidence for "an index here would have helped". Previously this was only available as `EXPLAIN` text.
- **Cost.** Pages touched, taken from the pager's counters either side of the run. Wall-clock is recorded too but not used for decisions; it is noise on a shared machine.
- **Shapes.** Literals are replaced with `?` so a thousand runs of one query collapse into one row. Bounded to `maxShapes` (500), least-used evicted.
- **Writes** per table, to price the indexes those writes maintain.
- **Null samples**, taken when you call `db.sampleColumn(table, column)`. The custodian compares the first sample against the latest.
- **Churn** comes from the change history (`history: true`), by counting how often a row returns to a value it already held.

## Cost

Watching adds two counter reads and one `performance.now()` per SELECT, and one counter increment per write. `notice()` itself walks every table to count rows, so call it on demand, not per query. All 83 tests pass with it on.

## Options

```ts
new Database(path, { custodian: {
  maxShapes: 500,              // distinct query shapes remembered
  minRuns: 20,                 // how often a query must recur before advice
  minSpeedup: 2,               // how much cheaper an index must be to suggest it
  minPagesPerScan: 4,          // ignore tables small enough that scanning is free
  minWritesForUnusedIndex: 100 // how much an index must have cost before complaining
} });
```

## What it does not do yet

- No persistence: the workload lives in memory and resets when the database closes. Aggregates are small enough to store, and the engine already has somewhere to put them.
- Null sampling is manual. It should ride along with a background pass, or sample during scans it is already watching.
- Composite indexes are never suggested, because the engine has none.
- No index *drop* safety check beyond "never used": an index enforcing uniqueness would be wrong to drop, and only primary keys are currently exempt.
- Findings are not deduplicated across calls, so a long-running process repeats itself.
