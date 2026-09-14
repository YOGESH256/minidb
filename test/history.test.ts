/**
 * Change receipts, watch(), undo(): the "database that knows what changed"
 * branch. See docs/DIRECTION.md (parked idea, now being tested).
 */
import { describe, it, expect } from 'vitest';
import { Database, UndoConflictError } from '../src/index.js';
import { FaultFS } from './helpers.js';

function open(history = true) {
  return new Database(':memory:', { history });
}

describe('change receipts', () => {
  it('records one receipt per changed row, in the same transaction, with before/after', () => {
    const db = open();
    db.exec('CREATE TABLE tasks (id INT PRIMARY KEY, title TEXT NOT NULL, done BOOL)');
    expect(db.changes()).toEqual([]);
    db.exec("INSERT INTO tasks VALUES (1, 'write tests', FALSE), (2, 'ship', FALSE)");
    db.exec('UPDATE tasks SET done = TRUE WHERE id = 1');
    db.exec('DELETE FROM tasks WHERE id = 2');
    const c = db.changes();
    expect(c.map((x) => [x.txn, x.seq, x.op, x.key])).toEqual([
      [1, 0, 'INSERT', 1],
      [1, 1, 'INSERT', 2],
      [2, 0, 'UPDATE', 1],
      [3, 0, 'DELETE', 2],
    ]);
    expect(c[2]).toMatchObject({ table: 'tasks', before: [1, 'write tests', false], after: [1, 'write tests', true] });
    expect(c[3]).toMatchObject({ before: [2, 'ship', false], after: null });
    expect(db.lastTxn()).toBe(3);
    // per-row history
    expect(db.history('tasks', 1).map((x) => x.op)).toEqual(['INSERT', 'UPDATE']);
    expect(db.history('tasks', 2).map((x) => x.op)).toEqual(['INSERT', 'DELETE']);
    // since / table filters
    expect(db.changes({ since: 2 }).map((x) => x.txn)).toEqual([3]);
    expect(db.changes({ table: 'nope' })).toEqual([]);
    db.close();
  });

  it('a BEGIN block is one transaction; a rollback leaves no receipts', () => {
    const db = open();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
    db.exec('BEGIN; INSERT INTO t VALUES (1, 1); INSERT INTO t VALUES (2, 2); UPDATE t SET v = 10; COMMIT');
    const c = db.changes();
    expect(new Set(c.map((x) => x.txn)).size).toBe(1);
    expect(c.length).toBe(4); // 2 inserts + 2 updates
    db.exec('BEGIN; DELETE FROM t; ROLLBACK');
    expect(db.changes().length).toBe(4);
    expect(db.lastTxn()).toBe(1); // the rolled-back txn id was not consumed
    expect(() => db.exec('INSERT INTO t VALUES (1, 0)')).toThrow(/duplicate/);
    expect(db.changes().length).toBe(4); // failed statement: no receipt
    db.close();
  });

  it('receipts survive a crash exactly like the rows they describe', () => {
    const fs = new FaultFS();
    let db = new Database('/db', { fs: fs.fs, history: true, checkpointBytes: 1 << 30 });
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("UPDATE t SET v = 'b' WHERE id = 1");
    fs.crash('drop');
    db = new Database('/db', { fs: fs.fs, history: true });
    expect(db.query('SELECT v FROM t').rows).toEqual([['b']]);
    expect(db.history('t', 1).map((x) => x.op)).toEqual(['INSERT', 'UPDATE']);
    expect(db.verify().ok).toBe(true);
    db.close();
  });

  it('history off: no receipts, no cost; the same file can turn it on later', () => {
    const fs = new FaultFS();
    let db = new Database('/db', { fs: fs.fs });
    db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
    db.exec('INSERT INTO t VALUES (1)');
    expect(db.changes()).toEqual([]);
    expect(() => db.undo(1)).toThrow(/history option/);
    db.close();
    db = new Database('/db', { fs: fs.fs, history: true });
    db.exec('INSERT INTO t VALUES (2)');
    expect(db.changes().map((x) => x.key)).toEqual([2]);
    db.close();
  });

  it('pruneHistory drops old receipts', () => {
    const db = open();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
    for (let i = 0; i < 10; i++) db.exec(`INSERT INTO t VALUES (${i})`);
    expect(db.pruneHistory(8)).toBe(7);
    expect(db.changes().map((x) => x.txn)).toEqual([8, 9, 10]);
    db.close();
  });
});

describe('watch()', () => {
  it('fires once now, then only when a commit changes the result', () => {
    const db = open(false);
    db.exec('CREATE TABLE tasks (id INT PRIMARY KEY, project INT, title TEXT, done BOOL)');
    db.exec('CREATE TABLE other (x INT)');
    db.exec("INSERT INTO tasks VALUES (1, 7, 'a', FALSE), (2, 7, 'b', FALSE), (3, 8, 'c', FALSE)");
    const seen: number[][] = [];
    const stop = db.watch('SELECT id FROM tasks WHERE project = ? AND NOT done ORDER BY id', [7], (rows) => seen.push(rows.map((r) => r['id'] as number)));
    expect(seen).toEqual([[1, 2]]);
    db.exec('INSERT INTO other VALUES (1)'); // unrelated table: nothing
    expect(seen.length).toBe(1);
    db.exec("UPDATE tasks SET title = 'zzz' WHERE id = 3"); // related table, result unchanged: nothing
    expect(seen.length).toBe(1);
    db.exec('UPDATE tasks SET done = TRUE WHERE id = 1');
    expect(seen).toEqual([[1, 2], [2]]);
    db.exec("BEGIN; INSERT INTO tasks VALUES (4, 7, 'd', FALSE); INSERT INTO tasks VALUES (5, 7, 'e', FALSE); COMMIT");
    expect(seen.length).toBe(3); // one notification per transaction, not per statement
    expect(seen[2]).toEqual([2, 4, 5]);
    db.exec("BEGIN; DELETE FROM tasks WHERE id = 4; ROLLBACK");
    expect(seen.length).toBe(3);
    stop();
    db.exec('DELETE FROM tasks');
    expect(seen.length).toBe(3);
    db.close();
  });

  it('a watcher may write; its write notifies others; a join watches both tables', () => {
    const db = open(false);
    db.exec('CREATE TABLE orders (id INT PRIMARY KEY, total INT)');
    db.exec('CREATE TABLE stats (k TEXT PRIMARY KEY, v INT)');
    db.exec("INSERT INTO stats VALUES ('orders', 0)");
    const statSeen: number[] = [];
    db.watch("SELECT v FROM stats WHERE k = 'orders'", [], (rows) => statSeen.push(rows[0]!['v'] as number));
    // materialised counter kept by a watcher on orders
    db.watch('SELECT id FROM orders', [], (rows) => db.prepare("UPDATE stats SET v = ? WHERE k = 'orders'").run(rows.length));
    db.exec('INSERT INTO orders VALUES (1, 10)');
    db.exec('INSERT INTO orders VALUES (2, 20)');
    expect(statSeen).toEqual([0, 1, 2]);
    const joined: number[] = [];
    db.watch('SELECT o.id FROM orders o JOIN stats s ON s.v > 0 WHERE o.total > ?', [15], (rows) => joined.push(rows.length));
    db.exec("UPDATE stats SET v = 0 WHERE k = 'orders'"); // only the stats table changed; join result changes
    expect(joined).toEqual([1, 0]);
    db.close();
  });

  it('a watcher whose table is dropped reports through onError and keeps the database usable', () => {
    const db = open(false);
    db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
    const errors: string[] = [];
    db.watch('SELECT * FROM t', [], () => {}, { onError: (e) => errors.push(e.message) });
    db.exec('DROP TABLE t');
    expect(errors[0]).toMatch(/does not exist/);
    db.exec('CREATE TABLE u (id INT)');
    db.close();
  });
});

describe('undo()', () => {
  it('reverts a transaction of mixed inserts, updates and deletes, and is itself recorded', () => {
    const db = open();
    db.exec('CREATE TABLE tasks (id INT PRIMARY KEY, title TEXT NOT NULL, done BOOL)');
    db.exec("INSERT INTO tasks VALUES (1, 'a', FALSE), (2, 'b', FALSE), (3, 'c', FALSE)"); // txn 1
    // a "bulk edit": mark all done, rename one, delete one, add one
    db.exec("BEGIN; UPDATE tasks SET done = TRUE; UPDATE tasks SET title = 'A!' WHERE id = 1; DELETE FROM tasks WHERE id = 3; INSERT INTO tasks VALUES (4, 'd', FALSE); COMMIT"); // txn 2
    expect(db.query('SELECT id, title, done FROM tasks ORDER BY id').rows).toEqual([
      [1, 'A!', true],
      [2, 'b', true],
      [4, 'd', false],
    ]);
    const r = db.undo(2);
    expect(r.reverted).toBe(6); // 3 updates + 1 update + 1 delete + 1 insert
    expect(db.query('SELECT id, title, done FROM tasks ORDER BY id').rows).toEqual([
      [1, 'a', false],
      [2, 'b', false],
      [3, 'c', false],
    ]);
    expect(db.lastTxn()).toBe(3); // the undo is a transaction with its own receipts
    expect(db.changes({ since: 2 }).length).toBe(6);
    // and an undo can be undone
    db.undo(3);
    expect(db.query('SELECT id, title FROM tasks ORDER BY id').rows).toEqual([[1, 'A!'], [2, 'b'], [4, 'd']]);
    db.close();
  });

  it('refuses, changing nothing, when a row was edited after the transaction being undone', () => {
    const db = open();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')"); // txn 1
    db.exec("UPDATE t SET v = 'x'"); // txn 2: both rows
    db.exec("UPDATE t SET v = 'y' WHERE id = 2"); // txn 3: someone edited row 2 since
    let err: UndoConflictError | null = null;
    try {
      db.undo(2);
    } catch (e) {
      err = e as UndoConflictError;
    }
    expect(err).toBeInstanceOf(UndoConflictError);
    expect(err!.conflicts).toEqual([{ table: 't', key: 2, reason: 'modified since' }]);
    expect(db.query('SELECT v FROM t ORDER BY id').rows).toEqual([['x'], ['y']]); // untouched, incl. row 1
    // undo the later edit first, then the earlier one works
    db.undo(3);
    db.undo(2);
    expect(db.query('SELECT v FROM t ORDER BY id').rows).toEqual([['a'], ['b']]);
    // deleted-since and re-created-since
    db.exec("INSERT INTO t VALUES (3, 'c')"); // txn 6
    db.exec('DELETE FROM t WHERE id = 3'); // txn 7
    expect(() => db.undo(6)).toThrow(/already deleted/);
    db.exec("INSERT INTO t VALUES (3, 'c2')"); // txn 8
    expect(() => db.undo(7)).toThrow(/re-created since/);
    expect(() => db.undo(99)).toThrow(/no recorded changes/);
    db.close();
  });

  it('undo needs a primary key on the table', () => {
    const db = open();
    db.exec('CREATE TABLE nokey (v INT)');
    db.exec('INSERT INTO nokey VALUES (1)');
    expect(db.changes()[0]!.key).toBeNull();
    expect(() => db.undo(1)).toThrow(/no primary key/);
    db.close();
  });

  it('watchers see an undo like any other commit', () => {
    const db = open();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
    db.exec('INSERT INTO t VALUES (1, 1)');
    const seen: number[] = [];
    db.watch('SELECT v FROM t WHERE id = 1', [], (rows) => seen.push(rows[0]!['v'] as number));
    db.exec('UPDATE t SET v = 2 WHERE id = 1');
    db.undo(db.lastTxn());
    expect(seen).toEqual([1, 2, 1]);
    db.close();
  });
});
