/**
 * The application-facing API: prepared statements with parameters,
 * transaction(fn), ':memory:', exclusive file ownership, trace(), pageMap(),
 * and heap space reuse after DELETE.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database, DatabaseLockedError, Heap } from '../src/index.js';

describe('prepared statements + parameters', () => {
  it('positional ? binding via run/get/all', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, name TEXT, age INT)');
    const ins = db.prepare('INSERT INTO t VALUES (?, ?, ?)');
    expect(ins.run(1, 'ann', 31)).toEqual({ changes: 1 });
    ins.run(2, 'bob', null);
    ins.run(3, "o'hara", 25); // quotes are data, not SQL
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get(3)).toEqual({ name: "o'hara" });
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get(99)).toBeUndefined();
    expect(db.prepare('SELECT id FROM t WHERE age > ? ORDER BY id').all(20)).toEqual([{ id: 1 }, { id: 3 }]);
    expect(db.prepare('SELECT id FROM t WHERE age IS NULL').all()).toEqual([{ id: 2 }]);
    expect(db.prepare('UPDATE t SET age = ? WHERE id = ?').run(26, 3).changes).toBe(1);
    expect(db.prepare('DELETE FROM t WHERE id > ?').run(1).changes).toBe(2);
    db.close();
  });

  it('named $name binding, reuse of one statement, and error cases', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, s TEXT)');
    const ins = db.prepare('INSERT INTO t VALUES ($id, $s)');
    for (let i = 0; i < 5; i++) ins.run({ id: i, s: 'v' + i });
    expect(db.prepare('SELECT s FROM t WHERE id = $id').get({ id: 4 })).toEqual({ s: 'v4' });
    expect(() => ins.run({ id: 9 })).toThrow(/missing value for parameter \$s/);
    expect(() => db.prepare('SELECT * FROM t WHERE id = ?').get()).toThrow(/too few parameter values/);
    expect(() => db.prepare('SELECT * FROM t WHERE id = ?').get(1, 2)).toThrow(/too many parameter values/);
    expect(() => db.prepare('SELECT * FROM t WHERE id = ?').get({ id: 1 })).toThrow(/positional parameter/);
    expect(() => db.prepare('SELECT * FROM t WHERE id = ?').get('x')).toThrow(/operator does not exist: INT = TEXT/);
    expect(() => db.prepare('SELECT 1; SELECT 2')).toThrow(/exactly one statement/);
    // a plain exec() with an unbound ? is an error, not silently NULL
    expect(() => db.exec('SELECT * FROM t WHERE id = ?')).toThrow(/unbound parameter/);
    // params work in EXPLAIN; the plan is built once, so it shows the placeholder, like PG's $1
    const plan = db.prepare('EXPLAIN SELECT * FROM t WHERE id = ?').all(1).map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index Cond: id = \?/);
    db.close();
  });

  it('raw() keeps column arrays; duplicate output names collapse in objects', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (a INT, b INT)');
    db.exec('INSERT INTO t VALUES (1, 2)');
    expect(db.prepare('SELECT a, b, a + b AS sum FROM t').raw().columns).toEqual(['a', 'b', 'sum']);
    expect(db.prepare('SELECT a, b AS a FROM t').get()).toEqual({ a: 2 });
    db.close();
  });
});

describe('transaction(fn)', () => {
  it('commits on return, rolls back on throw, returns the value', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE acct (id INT PRIMARY KEY, bal INT)');
    db.exec('INSERT INTO acct VALUES (1, 100), (2, 0)');
    const transfer = db.transaction((from: number, to: number, amt: number) => {
      db.prepare('UPDATE acct SET bal = bal - ? WHERE id = ?').run(amt, from);
      const b = db.prepare('SELECT bal FROM acct WHERE id = ?').get(from)!['bal'] as number;
      if (b < 0) throw new Error('insufficient funds');
      db.prepare('UPDATE acct SET bal = bal + ? WHERE id = ?').run(amt, to);
      return b;
    });
    expect(transfer(1, 2, 30)).toBe(70);
    expect(() => transfer(1, 2, 500)).toThrow(/insufficient/);
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT id, bal FROM acct ORDER BY id').all()).toEqual([
      { id: 1, bal: 70 },
      { id: 2, bal: 30 },
    ]);
    expect(() => transfer(1, 2, 1)).not.toThrow();
    // nesting is refused
    const outer = db.transaction(() => transfer(1, 2, 1));
    expect(() => outer()).toThrow(/within a transaction/);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('refuses an async callback instead of committing partial work', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (x INT)');
    const bad = db.transaction(async () => {
      db.exec('INSERT INTO t VALUES (1)');
      await Promise.resolve();
      db.exec('INSERT INTO t VALUES (2)');
    });
    expect(() => bad()).toThrow(/must be synchronous/);
    expect(db.inTransaction).toBe(false);
    expect(db.query('SELECT * FROM t').rows).toEqual([]); // the first insert was rolled back too
    db.close();
  });
});

describe('plan reuse', () => {
  it('a prepared statement survives schema changes and rebinds params each run', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, k INT)');
    for (let i = 0; i < 300; i++) db.exec(`INSERT INTO t VALUES (${i}, ${i % 10})`);
    const byK = db.prepare('SELECT id FROM t WHERE k = ? ORDER BY id LIMIT 2');
    expect(byK.all(3)).toEqual([{ id: 3 }, { id: 13 }]);
    expect(byK.all(7)).toEqual([{ id: 7 }, { id: 17 }]);
    expect(db.prepare('EXPLAIN SELECT id FROM t WHERE k = ?').all(3)[0]!['QUERY PLAN']).toMatch(/Seq Scan/);
    db.exec('CREATE INDEX t_k ON t (k)'); // schema change: cached plans must rebuild
    expect(db.prepare('EXPLAIN SELECT id FROM t WHERE k = ?').all(3)[0]!['QUERY PLAN']).toMatch(/Index Scan using t_k/);
    expect(byK.all(3)).toEqual([{ id: 3 }, { id: 13 }]);
    // a rolled-back DDL also invalidates
    db.exec('BEGIN; DROP TABLE t; ROLLBACK');
    expect(byK.all(9)).toEqual([{ id: 9 }, { id: 19 }]);
    // a wrong-typed value at run time is a type error, never a silent mismatch
    expect(() => byK.all('x')).toThrow(/operator does not exist: INT = TEXT/);
    expect(() => db.prepare('SELECT * FROM t WHERE k + ? > 1').all('x')).toThrow(/operator does not exist/);
    expect(() => db.prepare('SELECT * FROM t WHERE ? AND k = 1').all(5)).toThrow(/must be type BOOL/);
    expect(() => db.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1)).toThrow(/is of type INT/);
    db.close();
  });
});

describe('verify()', () => {
  it('reports a clean database and finds planted damage', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, s TEXT NOT NULL)');
    db.exec('CREATE INDEX t_s ON t (s)');
    const rows: string[] = [];
    for (let i = 0; i < 1500; i++) rows.push(`(${i}, 's${i % 40}')`);
    db.exec(`INSERT INTO t VALUES ${rows.join(',')}`);
    db.exec('DELETE FROM t WHERE id % 3 = 0');
    db.exec('UPDATE t SET s = \'moved\' WHERE id % 5 = 1');
    const r = db.verify();
    expect(r.ok, r.problems.join('; ')).toBe(true);
    expect(r).toMatchObject({ tables: 1, indexes: 2, rows: 1000 });
    expect(r.entries).toBe(2000);
    // plant damage: delete a row behind the index's back
    const t = db.catalog.mustGetTable('t');
    db.pager.begin();
    const heap = new Heap(db.pager, t.rootPage);
    heap.delete([...heap.scan()][0]!.tid);
    db.pager.commit();
    const bad = db.verify();
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/t_pkey.*1 entries point at deleted rows/);
    expect(bad.problems.join('\n')).toMatch(/t_s.*1 entries point at deleted rows/);
    db.close();
  });
});

describe(':memory: and file ownership', () => {
  it(':memory: databases are independent and need no disk', () => {
    const a = new Database(':memory:');
    const b = new Database(':memory:');
    a.exec('CREATE TABLE t (x INT)');
    expect(() => b.exec('SELECT * FROM t')).toThrow(/does not exist/);
    a.close();
    b.close();
  });

  it('a second opener of the same file is refused; a stale lock is taken over', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minidb-lock-'));
    const file = path.join(dir, 'a.db');
    const db1 = new Database(file);
    db1.exec('CREATE TABLE t (x INT)');
    expect(() => new Database(file)).toThrow(DatabaseLockedError);
    db1.close();
    // stale lock: a pid that cannot exist
    fs.writeFileSync(file + '.lock', '999999999\nstale\n');
    const db2 = new Database(file);
    expect(db2.query('SELECT * FROM t').rows).toEqual([]);
    db2.close();
    expect(fs.existsSync(file + '.lock')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('trace() and pageMap()', () => {
  it('reports pages read, index hops, WAL records and fsyncs per statement', () => {
    const db = new Database(':memory:', { checkpointBytes: 1 << 30 });
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, s TEXT)');
    const rows: string[] = [];
    for (let i = 0; i < 2000; i++) rows.push(`(${i}, 'row${i}')`);
    db.exec(`INSERT INTO t VALUES ${rows.join(',')}`);
    db.exec('CHECKPOINT');

    const seq = db.trace("SELECT * FROM t WHERE s = 'row1999'");
    const idx = db.trace('SELECT * FROM t WHERE id = ?', [1999]);
    expect(seq.results[0]!.rows.length).toBe(1);
    expect(idx.results[0]!.rows.length).toBe(1);
    const heapPages = db.pageMap().filter((p) => p.kind === 'heap').length - 3; // minus the three catalog heaps
    expect(seq.summary.distinctPagesRead).toBeGreaterThanOrEqual(heapPages); // every page of t
    expect(idx.summary.distinctPagesRead).toBeLessThanOrEqual(6); // meta, tree root+leaf, heap page
    expect(seq.summary.distinctPagesRead).toBeGreaterThan(idx.summary.distinctPagesRead * 2);
    expect(idx.summary.indexHops).toBeGreaterThanOrEqual(2);
    expect(idx.events.some((e) => e.op === 'index' && e.note === 'leaf')).toBe(true);
    expect(seq.summary.walRecords).toBe(0);

    const w = db.trace("INSERT INTO t VALUES (5000, 'new')");
    expect(w.summary.pagesWritten).toBeGreaterThanOrEqual(2); // heap page + index leaf (+ meta if a page was allocated)
    expect(w.summary.walRecords).toBe(w.summary.pagesWritten);
    expect(w.summary.fsyncs).toBe(1);
    expect(w.events.filter((e) => e.op === 'commit').length).toBe(1);

    const map = db.pageMap();
    expect(map[0]).toEqual({ page: 0, kind: 'meta' });
    expect(map.find((p) => p.owner === 't')?.kind).toBe('heap');
    expect(map.find((p) => p.owner === 't_pkey')?.kind).toBe('btree-meta');
    expect(map.filter((p) => p.kind === 'btree').length).toBeGreaterThan(1);
    db.close();
  });
});

describe('heap space reuse', () => {
  it('space freed by DELETE is used before the table grows', () => {
    const db = new Database(':memory:', { poolSize: 128 });
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, pad TEXT)');
    const ins = db.prepare('INSERT INTO t VALUES (?, ?)');
    const pad = 'x'.repeat(300);
    for (let i = 0; i < 2000; i++) ins.run(i, pad);
    const heapPages = () => db.pageMap().filter((p) => p.kind === 'heap').length;
    const before = heapPages();
    db.exec('DELETE FROM t WHERE id % 2 = 0'); // free half of every page
    for (let i = 2000; i < 3000; i++) ins.run(i, pad); // should fit in the holes
    expect(heapPages()).toBe(before); // the index may grow; the table must not
    expect(db.query('SELECT * FROM t').rows.length).toBe(2000);
    expect(db.prepare('SELECT pad FROM t WHERE id = ?').get(2999)).toEqual({ pad });
    db.close();
  });
});
