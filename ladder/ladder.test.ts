/**
 * One test per rung. Each test shows what the step FIXES, by first showing
 * the problem in the step below it.
 */
import { describe, it, expect } from 'vitest';
import { FakeDisk } from './fake-disk.js';
import { ArrayDb } from './v0-array.js';
import { PagedDb, Page, PAGE_SIZE } from './v1-pages.js';
import { DurableDb } from './v2-wal.js';
import { IndexedDb, CAPACITY } from './v3-btree.js';
import { SqlDb, parse } from './v4-sql.js';

describe('ladder', () => {
  it('v0: a JSON file works until the power goes out mid-save', () => {
    const disk = new FakeDisk();
    let db = new ArrayDb(disk, 'db.json');
    db.insert({ id: 1, name: 'ann' });
    db.insert({ id: 2, name: 'bob' });
    expect(db.select((r) => r['id'] === 2)).toEqual([{ id: 2, name: 'bob' }]);
    // Reopen: fine.
    db = new ArrayDb(disk, 'db.json');
    expect(db.rows.length).toBe(2);
    // Now the whole-file rewrite is interrupted after 20 bytes: EVERYTHING is lost, not just row 3.
    db.rows.push({ id: 3, name: 'cy' });
    const json = Buffer.from(JSON.stringify(db.rows));
    disk.truncate('db.json', 0);
    disk.write('db.json', 0, json);
    disk.crashTorn('db.json', 20);
    expect(() => new ArrayDb(disk, 'db.json')).toThrow(); // JSON.parse on half a file
  });

  it('v1: pages mean an insert touches 4 KB, not the whole file; but a torn page still corrupts', () => {
    const disk = new FakeDisk();
    const db = new PagedDb(disk, 'db.pages');
    for (let i = 0; i < 1000; i++) db.insert({ id: i, name: 'user' + i });
    const pagesBefore = disk.size('db.pages') / PAGE_SIZE;
    expect(pagesBefore).toBeGreaterThan(5); // rows spread over many pages
    const sizeBefore = disk.size('db.pages');
    db.insert({ id: 1000, name: 'late' });
    // The file did not get rewritten: at most one new page appeared.
    expect(disk.size('db.pages') - sizeBefore).toBeLessThanOrEqual(PAGE_SIZE);
    expect(db.select((r) => r['id'] === 777)).toEqual([{ id: 777, name: 'user777' }]);
    // Still not crash-safe. v1 overwrites a page in place; if the power dies
    // 10 bytes into that write, the page is half new, half old: garbage.
    const last = disk.size('db.pages') / PAGE_SIZE - 1;
    const page = new Page(disk.read('db.pages', last * PAGE_SIZE, PAGE_SIZE));
    const slot = page.add(Buffer.from(JSON.stringify({ id: 1001, name: 'torn' })));
    expect(slot).toBeGreaterThan(0);
    disk.write('db.pages', last * PAGE_SIZE, page.buf); // the in-place write...
    disk.crashTorn('db.pages', last * PAGE_SIZE + 10); // ...interrupted
    const reopened = new PagedDb(disk, 'db.pages');
    expect(() => reopened.get({ page: last, slot })).toThrow(); // half-written JSON on the page
  });

  it('v2: the log makes commits survive a power cut and discards half-written tails', () => {
    const disk = new FakeDisk();
    let db = new DurableDb(disk, 'db.pages');
    db.insert({ id: 1, name: 'ann' });
    db.insert({ id: 2, name: 'bob' });
    // Uncommitted work vanishes on a crash. That is correct: nobody was told it was saved.
    db.insertNoCommit({ id: 3, name: 'never told' });
    disk.crash();
    db = new DurableDb(disk, 'db.pages');
    expect(db.select(() => true).map((r) => r['id'])).toEqual([1, 2]);
    // Commit, then crash BEFORE the real file was written (only the log is on disk).
    db.insertNoCommit({ id: 3, name: 'cy' });
    const p = db.pages.readPage(0);
    db.pages.wal.logPage(0, p);
    db.pages.wal.commit(); // fsynced
    disk.crash(); // data file never got the new page 0
    db = new DurableDb(disk, 'db.pages'); // recovery replays the log
    expect(db.select((r) => r['id'] === 3)).toEqual([{ id: 3, name: 'cy' }]);
    // A torn record after the last COMMIT is ignored, not replayed.
    db.insertNoCommit({ id: 4, name: 'torn' });
    db.pages.wal.logPage(0, db.pages.readPage(0));
    disk.crashTorn('db.pages-wal', 30); // half a record, no COMMIT
    db = new DurableDb(disk, 'db.pages');
    expect(db.select((r) => r['id'] === 4)).toEqual([]);
    expect(db.select((r) => r['id'] === 3)).toEqual([{ id: 3, name: 'cy' }]);
  });

  it('v3: the index finds one row in ~3 page reads instead of hundreds', () => {
    const disk = new FakeDisk();
    const db = new IndexedDb(disk, 'db.pages');
    const N = 3000; // > CAPACITY so the tree must split and grow
    for (let i = 0; i < N; i++) db.insert({ id: i, name: 'user' + i });
    expect(N).toBeGreaterThan(CAPACITY);
    expect(db.index.height()).toBe(2);
    expect(db.findById(2345)).toEqual({ id: 2345, name: 'user2345' });
    expect(db.findById(99999)).toBeNull();
    expect(() => db.insert({ id: 5, name: 'dup' })).toThrow(/duplicate key 5/);
    // Count page reads: full scan vs index.
    const before = disk.reads;
    db.select((r) => r['id'] === 2345);
    const scanReads = disk.reads - before;
    const mid = disk.reads;
    db.findById(2345);
    const indexReads = disk.reads - mid;
    expect(indexReads).toBeLessThanOrEqual(3);
    expect(scanReads).toBeGreaterThan(indexReads * 5);
  });

  it('v4: SQL text becomes a plan that uses the index when it can', () => {
    const disk = new FakeDisk();
    const db = new SqlDb(disk, 'ladder');
    db.exec('CREATE TABLE users (id, name, age)');
    db.exec("INSERT INTO users VALUES (1, 'ann', 31)");
    db.exec("INSERT INTO users VALUES (2, 'bob', 17)");
    db.exec("INSERT INTO users VALUES (3, 'cy', 25)");
    expect(db.exec('SELECT name FROM users WHERE id = 3')).toEqual([{ name: 'cy' }]);
    expect(db.exec('SELECT name FROM users WHERE age > 20')).toEqual([{ name: 'ann' }, { name: 'cy' }]);
    expect(db.exec("SELECT * FROM users WHERE id = 1 AND name = 'ann'")).toEqual([{ id: 1, name: 'ann', age: 31 }]);
    expect(db.exec('EXPLAIN SELECT name FROM users WHERE id = 3')).toMatch(/Index Lookup/);
    expect(db.exec('EXPLAIN SELECT name FROM users WHERE age > 20')).toMatch(/Seq Scan/);
    expect(parse("SELECT a FROM t WHERE x = 1 AND y = 'z'")).toEqual({ kind: 'select', table: 't', columns: ['a'], where: [{ col: 'x', op: '=', v: 1 }, { col: 'y', op: '=', v: 'z' }], explain: false });
    expect(() => db.exec('SELECT FROM')).toThrow();
  });
});
