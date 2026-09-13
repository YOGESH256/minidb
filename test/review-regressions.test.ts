/**
 * One regression test per finding in review.md, numbered to match.
 */
import { describe, it, expect } from 'vitest';
import { Pager, CorruptionError } from '../src/storage/pager.js';
import { PAGE_SIZE, PageType } from '../src/storage/page.js';
import { BTree } from '../src/storage/btree.js';
import { Database } from '../src/database.js';
import { encodeValue, compareEncoded } from '../src/types.js';
import { FaultFS, mulberry32 } from './helpers.js';

function writeMarker(pager: Pager, pageId: number, text: string) {
  pager.with(pageId, (f) => {
    f.buf.write(text.padEnd(32, '\0'), 40);
    pager.markDirty(f);
  });
}
function readMarker(pager: Pager, pageId: number): string {
  return pager.with(pageId, (f) => f.buf.toString('utf8', 40, 72).replace(/\0+$/, ''));
}
function alloc(pager: Pager): number {
  const f = pager.allocPage(PageType.Heap, 0);
  pager.release(f);
  return f.pageId;
}
function openDb(fs = new FaultFS(), poolSize = 64) {
  return new Database('/db', { openFile: fs.open, poolSize, checkpointBytes: 1 << 30 });
}

describe('review.md regressions', () => {
  it('#1 a failed commit leaves nothing in the WAL for a later COMMIT to cover', () => {
    const fs = new FaultFS();
    let pager = new Pager('/db', { openFile: fs.open, poolSize: 16, checkpointBytes: 1 << 30 });
    pager.begin();
    const a = alloc(pager);
    const b = alloc(pager);
    pager.commit();
    pager.begin();
    writeMarker(pager, a, 'A1');
    writeMarker(pager, b, 'B1');
    pager.commit();
    pager.checkpoint();
    // T1: second page image write fails mid-commit.
    pager.begin();
    writeMarker(pager, a, 'A-aborted');
    writeMarker(pager, b, 'B-aborted');
    fs.failNext('write', '/db-wal', 2);
    expect(() => pager.commit()).toThrow(/EIO/);
    pager.rollback();
    expect(readMarker(pager, a)).toBe('A1');
    // T2 commits something unrelated, then power loss before checkpoint.
    pager.begin();
    const c = pager.allocPage(PageType.Heap, 0).pageId;
    writeMarker(pager, c, 'C1');
    pager.commit();
    fs.crash('drop');
    pager = new Pager('/db', { openFile: fs.open, poolSize: 16 });
    expect(readMarker(pager, a)).toBe('A1');
    expect(readMarker(pager, b)).toBe('B1');
    expect(readMarker(pager, c)).toBe('C1');
    // Variant: only the fsync fails after the COMMIT record was appended.
    pager.begin();
    writeMarker(pager, a, 'A-aborted2');
    fs.failNext('fsync', '/db-wal');
    expect(() => pager.commit()).toThrow(/EIO/);
    pager.rollback();
    pager.begin();
    writeMarker(pager, c, 'C2');
    pager.commit();
    fs.crash('drop');
    pager = new Pager('/db', { openFile: fs.open, poolSize: 16 });
    expect(readMarker(pager, a)).toBe('A1');
    expect(readMarker(pager, c)).toBe('C2');
    pager.close();
  });

  it('#2 a failed page load does not leave a ghost frame that later drops a live mapping', () => {
    const fs = new FaultFS();
    let pager = new Pager('/db', { openFile: fs.open, poolSize: 8, checkpointBytes: 1 << 30 });
    pager.begin();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(alloc(pager));
    for (const id of ids) writeMarker(pager, id, 'v0-' + id);
    pager.commit();
    pager.checkpoint();
    const p = ids[2]!;
    for (let i = 0; i < 60; i++) pager.with(1000 + i, () => {}); // evict everything cached
    // 1. load of p fails
    fs.failNext('read', '/db');
    expect(() => pager.with(p, () => {})).toThrow(/EIO/);
    // 2. load again, write, commit (frame B, committed-dirty)
    pager.begin();
    writeMarker(pager, p, 'v1');
    pager.commit();
    // 3. churn the pool so the clock sweeps every frame several times
    for (let i = 0; i < 200; i++) pager.with(100 + i, () => {});
    // 4. write + commit again
    pager.begin();
    writeMarker(pager, p, 'v2');
    pager.commit();
    pager.checkpoint();
    pager.close();
    pager = new Pager('/db', { openFile: fs.open, poolSize: 8 });
    expect(readMarker(pager, p)).toBe('v2');
    pager.close();
  });

  it('#3 a statement may dirty more pages than the pool holds (spill), and rollback/crash still behave', () => {
    const fs = new FaultFS();
    const db = openDb(fs, 32); // 128 KB pool
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, n INT, s TEXT)');
    const rows: string[] = [];
    for (let i = 0; i < 4000; i++) rows.push(`(${i}, ${i}, '${'x'.repeat(150)}')`); // ~200 heap pages + index
    db.exec(`INSERT INTO t VALUES ${rows.join(',')}`);
    expect(db.pager.stats.spills).toBeGreaterThan(0);
    expect(db.query('SELECT * FROM t').rows.length).toBe(4000);
    db.exec('UPDATE t SET n = n + 1');
    expect(db.query('SELECT n FROM t WHERE id = 3999').rows).toEqual([[4000]]);
    db.exec('CREATE INDEX t_s ON t (s)');
    db.exec('BEGIN; DELETE FROM t; ROLLBACK');
    expect(db.query('SELECT * FROM t').rows.length).toBe(4000);
    expect(db.query('SELECT id FROM t WHERE id = 1234').rows).toEqual([[1234]]);
    db.exec('DELETE FROM t WHERE id >= 2000');
    fs.crash('drop');
    const db2 = openDb(fs, 32);
    expect(db2.query('SELECT * FROM t').rows.length).toBe(2000);
    expect(db2.query('SELECT n FROM t WHERE id = 1999').rows).toEqual([[2000]]);
    db2.exec('DROP TABLE t');
    expect(db2.pager.getMeta().freelistHead).not.toBe(0);
    db2.close();
  });

  it('#4 a zero-filled allocated page is reported as corruption, not silently treated as fresh', () => {
    const fs = new FaultFS();
    const db = openDb(fs);
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, s TEXT)');
    const rows: string[] = [];
    for (let i = 0; i < 300; i++) rows.push(`(${i}, '${'y'.repeat(100)}')`);
    db.exec(`INSERT INTO t VALUES ${rows.join(',')}`);
    db.exec('CHECKPOINT');
    const root = db.catalog.mustGetTable('t').rootPage;
    const second = db.pager.with(root, (f) => f.page.special.readUInt32LE(0));
    db.close();
    fs.corruptDurable('/db', second * PAGE_SIZE, Buffer.alloc(PAGE_SIZE));
    const db2 = openDb(fs);
    expect(() => db2.query('SELECT * FROM t')).toThrow(CorruptionError);
    // pages beyond the allocated count are still fine to read as fresh
    expect(() => db2.pager.with(db2.pager.getMeta().pageCount + 5, () => {})).not.toThrow();
    db2.close();
  });

  it('#5 split budgets the separator: near-max keys alternating with tiny keys', () => {
    const fs = new FaultFS();
    const pager = new Pager('/db', { openFile: fs.open, poolSize: 256 });
    const cmp = (a: Buffer, b: Buffer) => compareEncoded('TEXT', a, b);
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = mulberry32(seed);
      pager.begin();
      const tree = new BTree(pager, BTree.create(pager), cmp);
      const keys = new Set<string>();
      for (let i = 0; i < 400; i++) {
        const big = i % 2 === 0;
        const k = big ? 'B' + String(Math.floor(rng() * 1e9)).padStart(9, '0') + 'z'.repeat(986) : 'a' + String(Math.floor(rng() * 1e9)).padStart(Math.floor(rng() * 30), '0');
        keys.add(k);
        tree.insert(encodeValue('TEXT', k), { page: i, slot: 0 });
      }
      pager.commit();
      expect(tree.verify()).toBe(400);
      expect([...tree.scan()].length).toBe(400);
    }
    pager.close();
  });

  it('#6 outer joins are rejected explicitly instead of parsing as an alias', () => {
    const db = openDb();
    db.exec('CREATE TABLE users (id INT PRIMARY KEY); CREATE TABLE o (uid INT)');
    expect(() => db.exec('SELECT * FROM users LEFT JOIN o ON id = uid')).toThrow(/LEFT JOIN is not supported/);
    expect(() => db.exec('SELECT * FROM users LEFT OUTER JOIN o ON id = uid')).toThrow(/not supported/);
    expect(() => db.exec('SELECT * FROM users CROSS JOIN o')).toThrow(/CROSS JOIN is not supported/);
    expect(() => db.exec('SELECT * FROM users JOIN o USING (id)')).toThrow(/USING is not supported/);
    expect(() => db.exec('SELECT * FROM users left')).toThrow(/syntax error/);
    db.close();
  });

  it('#7 a COMMIT whose WAL fsync fails does not wedge the session', () => {
    const fs = new FaultFS();
    const db = openDb(fs);
    db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
    db.exec('BEGIN; INSERT INTO t VALUES (1)');
    fs.failNext('fsync', '/db-wal');
    expect(() => db.exec('COMMIT')).toThrow(/EIO/);
    expect(db.inTransaction).toBe(false);
    expect(db.query('SELECT * FROM t').rows).toEqual([]);
    db.exec('BEGIN; INSERT INTO t VALUES (2); COMMIT');
    expect(db.query('SELECT * FROM t').rows).toEqual([[2]]);
    db.close();
  });

  it('#8 an I/O error during in-transaction write-back does not leak a pin', () => {
    const fs = new FaultFS();
    const db = openDb(fs);
    db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
    db.exec('INSERT INTO t VALUES (1)'); // heap root now committed-dirty
    fs.failNext('write', '/db'); // data-file write-back fails once
    expect(() => db.exec('INSERT INTO t VALUES (2)')).toThrow(/EIO/);
    // A routine constraint failure must surface as such, not as "rollback with pinned page".
    expect(() => db.exec('INSERT INTO t VALUES (3), (1)')).toThrow(/duplicate key/);
    db.exec('BEGIN; INSERT INTO t VALUES (4); COMMIT');
    expect(db.query('SELECT id FROM t ORDER BY id').rows).toEqual([[1], [4]]);
    db.close();
  });

  it('#9 a failed statement inside BEGIN poisons the transaction until ROLLBACK', () => {
    const db = openDb();
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, s TEXT)");
    db.exec("INSERT INTO t VALUES (1, 'one')");
    db.exec('BEGIN');
    db.exec("INSERT INTO t VALUES (2, 'two')");
    expect(() => db.exec("INSERT INTO t VALUES (1, 'dup')")).toThrow(/duplicate key/);
    expect(db.inTransaction).toBe(true);
    expect(() => db.exec("INSERT INTO t VALUES (9, 'nine')")).toThrow(/current transaction is aborted/);
    expect(() => db.exec('SELECT 1')).toThrow(/current transaction is aborted/);
    expect(db.exec('COMMIT')[0]!.command).toBe('ROLLBACK');
    expect(db.inTransaction).toBe(false);
    expect(db.query('SELECT id FROM t').rows).toEqual([[1]]); // row 2 and 9 never committed
    db.exec('BEGIN');
    expect(() => db.exec('SELECT nope FROM t')).toThrow(/does not exist/);
    db.exec('ROLLBACK');
    db.exec("INSERT INTO t VALUES (3, 'three')");
    expect(db.query('SELECT id FROM t ORDER BY id').rows).toEqual([[1], [3]]);
    db.close();
  });

  it('#10 ORDER BY ordinal and output alias resolve against the select list', () => {
    const db = openDb();
    db.exec('CREATE TABLE users (id INT PRIMARY KEY, age INT)');
    db.exec('INSERT INTO users VALUES (1, 31), (2, NULL), (3, 25)');
    expect(db.query('SELECT id, age FROM users ORDER BY 2 DESC').rows).toEqual([
      [2, null],
      [1, 31],
      [3, 25],
    ]); // DESC puts NULLs first, as in PG
    expect(db.query('SELECT age AS a FROM users ORDER BY a').rows).toEqual([[25], [31], [null]]);
    expect(db.query('SELECT id, age * 2 AS twice FROM users ORDER BY twice DESC, 1').rows).toEqual([
      [2, null],
      [1, 62],
      [3, 50],
    ]);
    expect(() => db.exec('SELECT id FROM users ORDER BY 3')).toThrow(/not in select list/);
    expect(() => db.exec("SELECT id FROM users ORDER BY 'x'")).toThrow(/non-integer constant/);
    db.close();
  });

  it('cut list: non-boolean WHERE is a type error', () => {
    const db = openDb();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, s TEXT)');
    expect(() => db.exec('SELECT * FROM t WHERE id')).toThrow(/argument of WHERE must be type BOOL/);
    expect(() => db.exec("SELECT * FROM t WHERE s")).toThrow(/argument of WHERE must be type BOOL/);
    expect(() => db.exec('SELECT 1 WHERE 5')).toThrow(/argument of WHERE must be type BOOL/);
    db.close();
  });
});

