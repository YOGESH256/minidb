# History, watch, undo: a database that knows what changed

Branch `explore/history-watch`. Prototype, 2026-09-14. Tests in `test/history.test.ts` (12).

## The idea in three sentences

Every committed transaction leaves a receipt per changed row: what table, which row, old values, new values. An application can subscribe to a query and be told when its answer changes. Because the old values are kept, a transaction can be undone, safely, later.

## API

```ts
const db = new Database('app.db', { history: true });   // receipts on (off by default)

db.changes({ since: txn, table?: 'tasks', limit? })     // ChangeRecord[] oldest first
db.history('tasks', 27)                                  // every receipt for one row
db.lastTxn()                                             // id of the last transaction that recorded a change
db.pruneHistory(beforeTxn)                               // retention

const stop = db.watch('SELECT * FROM tasks WHERE project_id = ? AND NOT done', [7], (rows) => render(rows));
// called once now, then after every commit that touched `tasks` AND changed the result

db.undo(txn)                                             // reverses that transaction in a new one, or throws UndoConflictError
```

```ts
interface ChangeRecord {
  txn: number; seq: number; table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  key: Value;              // primary-key value, null if the table has none
  before: Value[] | null;  // whole old row
  after: Value[] | null;   // whole new row
}
```

## How it works

- **Receipts** live in a system table `__changes (txn, seq, table_name, op, row_key, before, after)`, an ordinary heap whose root is in the meta page. `writeRow` and the delete path append one row to it inside the same pager transaction, so a rollback drops receipts with the data and a crash recovers both together (tested). `before`/`after` are JSON arrays; `row_key` is the JSON of the primary-key value.
- **Transaction ids** come from a counter in the meta page, taken on the first recorded change of a transaction and bumped in the same transaction, so a rolled-back transaction consumes no id. A `BEGIN … COMMIT` block is one id; an autocommit statement is one id.
- **watch()** parses the SELECT once, records the tables it names (`FROM` and `JOIN`), prepares it, and stores the JSON of its last result. The facade tracks the set of tables written by the open transaction; after the pager commits, every watcher whose table set intersects is re-run and called back only if the JSON differs. Callbacks run after the commit returns, may write, and their commits notify other watchers through a queue (no re-entrancy). A watcher whose query now fails (table dropped) reports through `onError` and is skipped.
- **undo(txn)** loads that transaction's receipts and walks them newest-first inside one `transaction()`: for each row it checks the live row against the receipt's `after` (an insert or update) or its absence (a delete), tracking the expected state per row across several receipts for the same row. Any mismatch collects a conflict; if there are conflicts nothing is written and `UndoConflictError` lists them. Otherwise the inverse operations run as ordinary SQL through prepared statements, so the undo gets its own receipts and can itself be undone. Tables without a primary key cannot be undone.

## Cost

Same 20k inserts + 5k updates in memory:

| | writes/s | pages |
|---|---|---|
| history off | 11–18k | 354 |
| history on | 6.5–7.7k | 764 |

Roughly half the write throughput and twice the pages: each receipt stores the whole row twice as JSON. Both are addressable (store only changed columns; compact encoding) but that is the honest v0 number. Reads are unaffected. `watch()` costs one query re-run per relevant commit per watcher.

## What this is not yet

- No incremental view maintenance: a watcher re-runs its whole query. Fine for tens of watchers over small tables, which is a local application.
- No branches or "as of" queries. `history(table, key)` gives the row's timeline; reconstructing a whole table at a point in time is a fold over receipts, not implemented.
- No sync. Receipts with stable keys and transaction ids are the raw material; merging is a separate problem.
- Receipts are whole rows. Diffs would cut storage but complicate undo.
- Watchers detect table-level relevance, not row-level; a write to any row of a watched table re-runs the query.

## Why this and not more SQLite features

SQLite deliberately does not keep history, does not notify, and does not undo (its update hook and session extension are building blocks, not this). Local-first tools (ElectricSQL, PowerSync, cr-sqlite, Dexie liveQuery, TinyBase) bolt these on from outside with triggers and shadow tables. Owning the engine lets the receipt be written in the same page transaction as the row, with no second source of truth. That is the one advantage a small engine has, and this branch is the test of whether it is worth anything.

## Next step, if the idea holds

A demo app: a task board with live lists, an activity log, "undo last change", and "review what the assistant changed". Two days. Then show it to people. The engine work here is done enough for that.
