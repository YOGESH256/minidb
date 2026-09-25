import { describe, it, expect } from 'vitest';
import { Database } from '../src/database.js';
import { compareText, compareEncoded, encodeValue } from '../src/types.js';
import { FaultFS } from './helpers.js';

function open() {
  return new Database('/db', { openFile: new FaultFS().open, poolSize: 128, checkpointBytes: 1 << 30 });
}

/**
 * compareText decides ordering in memory; compareEncoded decides it on disk,
 * inside the B+tree. They must agree on every pair, or an index scan and a seq
 * scan answer the same predicate with different rows.
 */
const WORDS = [
  '', 'a', 'ab', 'abc', 'b', 'A', 'Z', 'z', '0', '9', '_', '~',
  'ann', 'anna', 'Ann', 'é', 'e', 'ß', '€', '中',
  '\u0000', '\u007f', '\u0080', '߿', 'ࠀ', '퟿', '', '￿',
  '😀', '😀a', '𐀀', '\u{10ffff}', 'a😀', 'a￿',
];

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

describe('TEXT ordering', () => {
  it('agrees with the on-disk key ordering on every pair', () => {
    const disagreements: string[] = [];
    for (const a of WORDS) {
      for (const b of WORDS) {
        const mem = Math.sign(compareText(a, b));
        const disk = Math.sign(compareEncoded('TEXT', encodeValue('TEXT', a), encodeValue('TEXT', b)));
        if (mem !== disk) disagreements.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}: memory ${mem}, disk ${disk}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('sorts a list the same way Buffer.compare does', () => {
    expect([...WORDS].sort(compareText)).toEqual([...WORDS].sort(byBytes));
  });

  it('is reflexive, antisymmetric, and zero only on equality', () => {
    for (const a of WORDS) {
      expect(compareText(a, a)).toBe(0);
      for (const b of WORDS) {
        // `|| 0` normalises -0, which Object.is (and so toBe) treats as distinct from 0.
        expect(Math.sign(compareText(a, b)) || 0).toBe(-Math.sign(compareText(b, a)) || 0);
        expect(compareText(a, b) === 0).toBe(a === b);
      }
    }
  });

  /**
   * The invariant a user would notice: the same WHERE clause returns the same
   * rows whether the planner reached the table by index or by sequential scan.
   */
  it('index scan and seq scan return the same rows for TEXT predicates', () => {
    const db = open();
    db.exec('CREATE TABLE w (k TEXT PRIMARY KEY, tag TEXT NOT NULL)');
    const ins = db.prepare('INSERT INTO w VALUES (?, ?)');
    db.transaction(() => {
      for (const word of WORDS) ins.run(word, 'x');
    })();

    for (const probe of WORDS) {
      for (const op of ['=', '<', '<=', '>', '>=']) {
        const viaIndex = db.prepare(`SELECT k FROM w WHERE k ${op} ? ORDER BY k`).all(probe);
        const viaSeq = db.prepare(`SELECT k FROM w WHERE tag = 'x' AND k ${op} ? ORDER BY k`).all(probe);
        expect(viaSeq, `${op} ${JSON.stringify(probe)}`).toEqual(viaIndex);
      }
    }

    // ORDER BY sorts in memory; it must land on the index's stored order too.
    const sorted = db.query('SELECT k FROM w ORDER BY k').rows.map((r) => r[0] as string);
    expect(sorted).toEqual([...WORDS].sort(byBytes));
    db.close();
  });
});

describe('operators after hoisting the per-row switch', () => {
  it('every comparison operator still returns what it did', () => {
    const db = open();
    db.exec(`
      CREATE TABLE n (id INT PRIMARY KEY, v INT, s TEXT, b BOOL);
      INSERT INTO n VALUES (1, 10, 'm', TRUE), (2, 20, 'n', FALSE), (3, NULL, NULL, NULL);
    `);
    const ids = (where: string) => db.query(`SELECT id FROM n WHERE ${where} ORDER BY id`).rows.map((r) => r[0]);
    expect(ids('v = 10')).toEqual([1]);
    expect(ids('v != 10')).toEqual([2]);
    expect(ids('v < 20')).toEqual([1]);
    expect(ids('v <= 20')).toEqual([1, 2]);
    expect(ids('v > 10')).toEqual([2]);
    expect(ids('v >= 10')).toEqual([1, 2]);
    expect(ids("s = 'm'")).toEqual([1]);
    expect(ids("s > 'm'")).toEqual([2]);
    expect(ids('b = TRUE')).toEqual([1]);
    expect(ids('b < TRUE')).toEqual([2]);
    // NULL stays unknown, so row 3 never qualifies.
    expect(ids('v = NULL')).toEqual([]);
    expect(ids('v IS NULL')).toEqual([3]);
    db.close();
  });

  it('every arithmetic operator still returns what it did', () => {
    const db = open();
    const one = (e: string) => db.query(`SELECT ${e} AS r`).rows[0]![0];
    expect(one('7 + 3')).toBe(10);
    expect(one('7 - 3')).toBe(4);
    expect(one('7 * 3')).toBe(21);
    expect(one('7 / 3')).toBe(2);
    expect(one('-7 / 3')).toBe(-2); // truncation, not floor
    expect(one('7 % 3')).toBe(1);
    expect(one('NULL + 1')).toBe(null);
    expect(() => db.query('SELECT 1 / 0')).toThrow(/division by zero/);
    expect(() => db.query('SELECT 1 % 0')).toThrow(/division by zero/);
    db.close();
  });

  /** The loose path: a bare parameter has no type until the value arrives. */
  it('still type-checks parameters at run time, per operator', () => {
    const db = open();
    db.exec("CREATE TABLE p (id INT PRIMARY KEY, s TEXT NOT NULL); INSERT INTO p VALUES (1, 'a')");
    expect(db.prepare('SELECT id FROM p WHERE id = ?').all(1)).toEqual([{ id: 1 }]);
    expect(() => db.prepare('SELECT id FROM p WHERE id = ?').all('a')).toThrow(/operator does not exist/);
    expect(() => db.prepare('SELECT id FROM p WHERE id > ?').all('a')).toThrow(/operator does not exist/);
    expect(() => db.prepare('SELECT id FROM p WHERE s < ?').all(1)).toThrow(/operator does not exist/);
    expect(() => db.prepare('SELECT ? + 1 AS r').all('a')).toThrow(/operator does not exist/);
    // A parameter compared to a parameter: both unknown until run time.
    expect(db.prepare('SELECT ? = ? AS r').all(2, 2)).toEqual([{ r: true }]);
    expect(() => db.prepare('SELECT ? = ? AS r').all(2, 'x')).toThrow(/operator does not exist/);
    db.close();
  });
});
