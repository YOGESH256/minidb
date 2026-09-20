/**
 * The custodian: something that lives with the data and notices things.
 * Each test creates a situation a careful person would spot, then checks the
 * custodian spots it, with the right evidence — and stays quiet otherwise.
 */
import { describe, it, expect } from 'vitest';
import { Database, shapeOf, type Finding } from '../src/index.js';

const find = (fs: Finding[], kind: string) => fs.filter((f) => f.kind === kind);

function shop(rows = 4000, opts: Record<string, unknown> = {}) {
  const db = new Database(':memory:', { custodian: true, checkpointBytes: 1 << 30, ...opts });
  db.exec('CREATE TABLE orders (id INT PRIMARY KEY, status TEXT NOT NULL, customer INT, note TEXT)');
  const ins = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    // 'open' is rare on purpose: an index only pays when the rows it finds are
    // far fewer than the pages a scan would read.
    for (let i = 0; i < rows; i++) ins.run(i, i % 1000 === 0 ? 'open' : 'shipped', i % 500, 'note ' + i);
  })();
  return db;
}

describe('noticing a missing index', () => {
  it('reports the column, the pages wasted, and the SQL that would fix it', () => {
    const db = shop();
    const q = db.prepare("SELECT id FROM orders WHERE status = ?");
    for (let i = 0; i < 30; i++) q.all('open');

    const found = find(db.notice(), 'missing-index');
    expect(found.length).toBe(1);
    const f = found[0]!;
    expect(f.table).toBe('orders');
    expect(f.message).toMatch(/scanned all of "orders" to filter on status/);
    expect(f.suggestion).toBe('CREATE INDEX orders_status ON orders (status);');
    expect(f.evidence['runs']).toBe(30);
    expect(f.evidence['rowsPerRun']).toBe(4); // 4 'open' rows out of 4000
    expect(f.evidence['selectivityPercent']).toBe(0.1);
    expect(f.evidence['estimatedSpeedup'] as number).toBeGreaterThan(2);
    expect(f.message).toMatch(/roughly \d+(\.\d+)?x less work/);
    db.close();
  });

  it('goes quiet once the index exists, and the query really does get cheaper', () => {
    const db = shop();
    const q = db.prepare('SELECT id FROM orders WHERE status = ?');
    for (let i = 0; i < 30; i++) q.all('open');
    const before = db.trace("SELECT id FROM orders WHERE status = 'open'").summary.distinctPagesRead;

    db.exec(find(db.notice(), 'missing-index')[0]!.suggestion!); // take the advice
    db.custodian!.reset();
    for (let i = 0; i < 30; i++) q.all('open');

    expect(find(db.notice(), 'missing-index')).toEqual([]);
    const after = db.trace("SELECT id FROM orders WHERE status = 'open'").summary.distinctPagesRead;
    expect(after).toBeLessThan(before / 3); // the advice was worth taking
    db.close();
  });

  it('stays quiet when matching rows are spread across the whole table anyway', () => {
    // 80 rows scattered over a 45-page table: an index scan would touch nearly
    // every page too, and pay for the tree on top. A real gain, not a guess.
    const db = new Database(':memory:', { custodian: true, checkpointBytes: 1 << 30 });
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, status TEXT NOT NULL, pad TEXT)');
    const ins = db.prepare('INSERT INTO t VALUES (?, ?, ?)');
    db.transaction(() => {
      for (let i = 0; i < 4000; i++) ins.run(i, i % 50 === 0 ? 'open' : 'shipped', 'p'.repeat(40));
    })();
    const q = db.prepare('SELECT id FROM t WHERE status = ?');
    for (let i = 0; i < 30; i++) q.all('open');
    expect(find(db.notice(), 'missing-index')).toEqual([]);
    db.close();
  });

  it('stays quiet about a query that runs rarely, or already returns most of the table', () => {
    const db = shop();
    db.prepare('SELECT id FROM orders WHERE customer = ?').all(7); // once
    const q = db.prepare('SELECT id FROM orders WHERE status = ?');
    for (let i = 0; i < 30; i++) q.all('shipped'); // 98% of rows: an index saves nothing
    expect(find(db.notice(), 'missing-index')).toEqual([]);
    db.close();
  });

  it('ignores conditions an index could not serve', () => {
    const db = shop();
    const q = db.prepare('SELECT id FROM orders WHERE customer + 1 = ?');
    for (let i = 0; i < 30; i++) q.all(8);
    expect(find(db.notice(), 'missing-index')).toEqual([]);
    db.close();
  });
});

describe('noticing an index nobody uses', () => {
  it('prices it in writes and offers to drop it', () => {
    const db = shop(200);
    db.exec('CREATE INDEX orders_note ON orders (note)');
    const ins = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 1000; i < 1200; i++) ins.run(i, 'open', i, 'n' + i);
    })();

    const f = find(db.notice(), 'unused-index');
    expect(f.length).toBe(1);
    expect(f[0]!.message).toMatch(/"orders_note".*no query has used it/);
    expect(f[0]!.suggestion).toBe('DROP INDEX orders_note;');
    expect(f[0]!.evidence['writesMaintained']).toBe(400); // 200 seeded + 200 more
    db.close();
  });

  it('says nothing about an index that is used, or about a primary key', () => {
    const db = shop(200);
    db.exec('CREATE INDEX orders_customer ON orders (customer)');
    const ins = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 1000; i < 1200; i++) ins.run(i, 'open', i, 'n');
    })();
    db.prepare('SELECT id FROM orders WHERE customer = ?').all(7);
    db.prepare('SELECT id FROM orders WHERE id = ?').all(7);
    expect(find(db.notice(), 'unused-index')).toEqual([]); // pkey is never reported
    db.close();
  });
});

describe('noticing a column that stopped being filled', () => {
  it('reports the before and after share, not just the current one', () => {
    const db = shop(300);
    db.sampleColumn('orders', 'note'); // healthy: nothing null
    db.exec("UPDATE orders SET note = NULL WHERE id > 60"); // the writer broke
    db.sampleColumn('orders', 'note');

    const f = find(db.notice(), 'null-rate-shift');
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.message).toMatch(/note in orders was 0% empty and is now 80%/);
    expect(f[0]!.evidence).toMatchObject({ beforePercent: 0, afterPercent: 80 });
    db.close();
  });

  it('says nothing when the share barely moves', () => {
    const db = shop(300);
    db.sampleColumn('orders', 'note');
    db.exec('UPDATE orders SET note = NULL WHERE id < 30'); // 10%
    db.sampleColumn('orders', 'note');
    expect(find(db.notice(), 'null-rate-shift')).toEqual([]);
    db.close();
  });
});

describe('noticing two writers fighting over a row', () => {
  it('counts the reversions and names the row', () => {
    const db = new Database(':memory:', { custodian: true, history: true });
    db.exec('CREATE TABLE settings (id INT PRIMARY KEY, mode TEXT)');
    db.exec("INSERT INTO settings VALUES (1, 'auto'), (2, 'auto')");
    const set = db.prepare('UPDATE settings SET mode = ? WHERE id = ?');
    for (let i = 0; i < 5; i++) {
      set.run('manual', 1); // one writer
      set.run('auto', 1); // and another, undoing it
    }
    set.run('manual', 2); // a settled row: changed once, never reverted

    const f = find(db.notice(), 'row-churn');
    expect(f.length).toBe(1);
    expect(f[0]!.table).toBe('settings');
    expect(f[0]!.evidence).toMatchObject({ key: 1, changes: 10, distinctStates: 2 });
    expect(f[0]!.message).toMatch(/Two writers may be overwriting each other/);
    db.close();
  });
});

describe('noticing history outgrowing its data', () => {
  it('compares receipts to live rows and points at pruning', () => {
    const db = new Database(':memory:', { custodian: true, history: true, checkpointBytes: 1 << 30 });
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
    db.exec('INSERT INTO t VALUES (1, 0), (2, 0)');
    const up = db.prepare('UPDATE t SET v = ? WHERE id = ?');
    for (let i = 0; i < 20; i++) up.run(i, 1);

    const f = find(db.notice(), 'history-outgrew-data');
    expect(f.length).toBe(1);
    expect(f[0]!.evidence['dataRows']).toBe(2);
    expect(f[0]!.evidence['historyRows'] as number).toBeGreaterThan(20);
    db.close();
  });
});

describe('the custodian itself', () => {
  it('collapses runs of the same query into one shape', () => {
    expect(shapeOf("SELECT * FROM t WHERE a = 41 AND b = 'x'")).toBe(shapeOf("SELECT * FROM t WHERE a = 7 AND b = 'yy'"));
    expect(shapeOf('SELECT * FROM t WHERE a = 1')).not.toBe(shapeOf('SELECT * FROM u WHERE a = 1'));
  });

  it('keeps a bounded workload summary, heaviest first', () => {
    const db = shop(500, { custodian: { maxShapes: 3, minRuns: 1 } });
    for (let i = 0; i < 10; i++) {
      db.prepare('SELECT id FROM orders WHERE customer = ?').all(i);
      db.prepare('SELECT id FROM orders WHERE note = ?').all('note ' + i);
      db.prepare('SELECT id FROM orders WHERE status = ?').all('open');
      db.prepare('SELECT id FROM orders WHERE id = ?').all(i);
    }
    const w = db.custodian!.workload();
    expect(w.length).toBeLessThanOrEqual(3); // bounded
    expect(w[0]!.pagesRead).toBeGreaterThanOrEqual(w[w.length - 1]!.pagesRead); // heaviest first
    expect(w.every((s) => s.table === 'orders')).toBe(true);
    db.close();
  });

  it('is off by default, and notice() says so rather than lying', () => {
    const db = new Database(':memory:');
    expect(db.custodian).toBeNull();
    expect(() => db.notice()).toThrow(/needs the custodian option/);
    db.close();
  });

  it('never changes the database', () => {
    const db = shop(); // big enough that there is something to report
    const before = db.query('SELECT id FROM orders').rows.length;
    const pagesBefore = db.pager.getMeta().pageCount;
    for (let i = 0; i < 30; i++) db.prepare('SELECT id FROM orders WHERE status = ?').all('open');
    expect(db.notice().length).toBeGreaterThan(0);
    expect(db.query('SELECT id FROM orders').rows.length).toBe(before);
    expect(db.pager.getMeta().pageCount).toBe(pagesBefore);
    expect(db.verify().ok).toBe(true);
    db.close();
  });
});
