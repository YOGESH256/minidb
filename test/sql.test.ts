import { describe, it, expect } from 'vitest';
import { Database } from '../src/database.js';
import { FaultFS } from './helpers.js';

function open(fs = new FaultFS()) {
  return { fs, db: new Database('/db', { openFile: fs.open, poolSize: 128, checkpointBytes: 1 << 30 }) };
}

describe('SQL end to end', () => {
  it('DDL, INSERT, SELECT, ORDER BY, LIMIT, expressions', () => {
    const { db } = open();
    db.exec(`
      CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL, age INT, active BOOL);
      INSERT INTO users VALUES (1, 'ann', 31, TRUE), (2, 'bob', NULL, FALSE), (3, 'cy', 25, TRUE);
    `);
    const r = db.query('SELECT name, age + 1 AS next FROM users WHERE active ORDER BY age DESC LIMIT 5');
    expect(r.columns).toEqual(['name', 'next']);
    expect(r.rows).toEqual([
      ['ann', 32],
      ['cy', 26],
    ]);
    expect(db.query('SELECT * FROM users WHERE age IS NULL').rows).toEqual([[2, 'bob', null, false]]);
    expect(db.query('SELECT 1 + 2 * 3, NOT FALSE, 7 / 2, -5 % 3').rows).toEqual([[7, true, 3, -2]]);
    expect(db.query("SELECT name FROM users WHERE name > 'b' ORDER BY name").rows).toEqual([['bob'], ['cy']]);
    expect(db.query('SELECT id FROM users ORDER BY age').rows).toEqual([[3], [1], [2]]); // NULLS LAST
    expect(db.query('SELECT id FROM users ORDER BY id DESC LIMIT 1 OFFSET 1').rows).toEqual([[2]]);
    db.close();
  });

  it('uses indexes: EXPLAIN shows Index Scan, results match seq scan', () => {
    const { db } = open();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, k INT, s TEXT)');
    const rows: string[] = [];
    for (let i = 0; i < 2000; i++) rows.push(`(${i}, ${i % 100}, 's${i % 37}')`);
    db.exec(`INSERT INTO t VALUES ${rows.join(',')}`);
    db.exec('CREATE INDEX t_k ON t (k)');
    const plan = db.query('EXPLAIN SELECT * FROM t WHERE k = 7 AND s = \'s1\'').rows.map((r) => r[0]);
    expect(plan[0]).toMatch(/Index Scan using t_k/);
    expect(plan.join('\n')).toMatch(/Filter: \(s = 's1'\)/);
    expect(db.query('EXPLAIN SELECT * FROM t WHERE id = 5').rows[0]![0]).toMatch(/Index Scan using t_pkey/);
    expect(db.query('EXPLAIN SELECT * FROM t WHERE 5 = id').rows[0]![0]).toMatch(/Index Scan using t_pkey/);
    expect(db.query('EXPLAIN SELECT * FROM t WHERE s = \'x\'').rows[0]![0]).toMatch(/Seq Scan/);
    expect(db.query('SELECT id FROM t WHERE k = 7 ORDER BY id').rows.map((r) => r[0])).toEqual([7, 107, 207, 307, 407, 507, 607, 707, 807, 907, 1007, 1107, 1207, 1307, 1407, 1507, 1607, 1707, 1807, 1907]);
    // range on the pk index
    const range = db.query('EXPLAIN SELECT * FROM t WHERE id >= 10 AND id < 20').rows.map((r) => r[0]);
    expect(range.join('\n')).toMatch(/Index Cond: id >= 10 AND id < 20/);
    expect(db.query('SELECT id FROM t WHERE id >= 10 AND id < 20').rows.length).toBe(10);
    expect(db.query('SELECT id FROM t WHERE id > 1990').rows.length).toBe(9);
    expect(db.query('SELECT id FROM t WHERE id <= 3').rows.map((r) => r[0])).toEqual([0, 1, 2, 3]);
    expect(db.query('SELECT id FROM t WHERE k = NULL').rows.length).toBe(0);
    db.close();
  });

  it('constraints: primary key, unique, not null; errors roll back the statement', () => {
    const { db } = open();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, email TEXT NOT NULL)');
    db.exec('CREATE UNIQUE INDEX t_email ON t (email)');
    db.exec("INSERT INTO t VALUES (1, 'a@x')");
    expect(() => db.exec("INSERT INTO t VALUES (1, 'b@x')")).toThrow(/duplicate key.*t_pkey/);
    expect(() => db.exec("INSERT INTO t VALUES (2, 'a@x')")).toThrow(/duplicate key.*t_email/);
    expect(() => db.exec('INSERT INTO t VALUES (2, NULL)')).toThrow(/not-null/);
    expect(() => db.exec("INSERT INTO t VALUES (2, 'ok'), (3, 'a@x')")).toThrow(/duplicate/);
    expect(db.query('SELECT * FROM t').rows).toEqual([[1, 'a@x']]); // multi-row insert rolled back atomically
    expect(() => db.exec("INSERT INTO t VALUES ('x', 'y')")).toThrow(/is of type INT/);
    expect(() => db.exec("SELECT * FROM t WHERE id = 'x'")).toThrow(/operator does not exist: INT = TEXT/);
    expect(() => db.exec('SELECT * FROM t WHERE id = 1 = 1')).toThrow(/not associative/);
    expect(() => db.exec('SELECT nope FROM t')).toThrow(/column "nope" does not exist/);
    expect(() => db.exec('SELECT * FROM nope')).toThrow(/relation "nope" does not exist/);
    expect(() => db.exec('SELECT 1 / 0')).toThrow(/division by zero/);
    db.close();
  });

  it('UPDATE and DELETE maintain indexes, including moving rows', () => {
    const { db } = open();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, s TEXT)');
    db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    db.exec('CREATE INDEX t_s ON t (s)');
    // grow the row so it must move to a new TID
    expect(db.query(`UPDATE t SET s = '${'z'.repeat(500)}' WHERE id = 2`).rowCount).toBe(1);
    expect(db.query(`SELECT id FROM t WHERE s = '${'z'.repeat(500)}'`).rows).toEqual([[2]]);
    expect(db.query("SELECT id FROM t WHERE s = 'b'").rows).toEqual([]);
    // change the pk itself
    db.exec('UPDATE t SET id = id + 10 WHERE id >= 2');
    expect(db.query('SELECT id FROM t ORDER BY id').rows.map((r) => r[0])).toEqual([1, 12, 13]);
    expect(db.query('SELECT id FROM t WHERE id = 12').rows).toEqual([[12]]);
    expect(() => db.exec('UPDATE t SET id = 1 WHERE id = 12')).toThrow(/duplicate key/);
    expect(db.query('DELETE FROM t WHERE id > 12').rowCount).toBe(1);
    expect(db.query("SELECT id FROM t WHERE s = 'c'").rows).toEqual([]);
    expect(db.query('DELETE FROM t').rowCount).toBe(2);
    expect(db.query('SELECT * FROM t').rows).toEqual([]);
    db.close();
  });

  it('joins: nested loop with parameterized index scan, aliases, qualified stars', () => {
    const { db } = open();
    db.exec(`
      CREATE TABLE authors (id INT PRIMARY KEY, name TEXT);
      CREATE TABLE books (id INT PRIMARY KEY, author_id INT, title TEXT, year INT);
      INSERT INTO authors VALUES (1, 'Le Guin'), (2, 'Herbert'), (3, 'Nobody');
      INSERT INTO books VALUES (10, 1, 'Dispossessed', 1974), (11, 1, 'Left Hand', 1969), (12, 2, 'Dune', 1965);
    `);
    const r = db.query(`
      SELECT a.name, b.title FROM authors a JOIN books b ON b.author_id = a.id
      WHERE b.year < 1972 ORDER BY b.title`);
    expect(r.columns).toEqual(['name', 'title']);
    expect(r.rows).toEqual([
      ['Herbert', 'Dune'],
      ['Le Guin', 'Left Hand'],
    ]);
    // inner side uses the pk index parameterized by the outer row
    const plan = db.query('EXPLAIN SELECT * FROM books b JOIN authors a ON a.id = b.author_id').rows.map((r) => r[0] as string);
    expect(plan[0]).toBe('Nested Loop');
    expect(plan.join('\n')).toMatch(/Index Scan using authors_pkey on authors a/);
    expect(plan.join('\n')).toMatch(/Index Cond: id = b.author_id/);
    // three-way, star forms, ambiguous column detection
    db.exec('CREATE TABLE sales (book_id INT, qty INT)');
    db.exec('INSERT INTO sales VALUES (10, 5), (10, 7), (12, 1)');
    const r3 = db.query(`
      SELECT a.name, s.qty FROM sales s JOIN books b ON b.id = s.book_id JOIN authors a ON a.id = b.author_id
      ORDER BY s.qty DESC`);
    expect(r3.rows).toEqual([
      ['Le Guin', 7],
      ['Le Guin', 5],
      ['Herbert', 1],
    ]);
    expect(db.query('SELECT b.* FROM authors a JOIN books b ON b.author_id = a.id WHERE a.id = 2').rows).toEqual([[12, 2, 'Dune', 1965]]);
    expect(() => db.exec('SELECT id FROM authors a JOIN books b ON b.author_id = a.id')).toThrow(/ambiguous/);
    // join with no matching rows for an author: inner join drops them
    expect(db.query('SELECT a.name FROM authors a JOIN books b ON b.author_id = a.id WHERE a.id = 3').rows).toEqual([]);
    db.close();
  });

  it('transactions: BEGIN/COMMIT/ROLLBACK, DDL rollback restores catalog, error aborts txn', () => {
    const { db } = open();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
    db.exec('BEGIN; INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); ROLLBACK');
    expect(db.query('SELECT * FROM t').rows).toEqual([]);
    db.exec('BEGIN; INSERT INTO t VALUES (1); CREATE TABLE u (x TEXT); INSERT INTO u VALUES (\'hi\'); COMMIT');
    expect(db.query('SELECT * FROM u').rows).toEqual([['hi']]);
    db.exec('BEGIN; DROP TABLE u; CREATE TABLE v (y INT); ROLLBACK');
    expect(db.query('SELECT * FROM u').rows).toEqual([['hi']]);
    expect(() => db.exec('SELECT * FROM v')).toThrow(/does not exist/);
    db.exec('BEGIN; INSERT INTO t VALUES (2)');
    expect(db.inTransaction).toBe(true);
    expect(() => db.exec('INSERT INTO t VALUES (1)')).toThrow(/duplicate/);
    expect(db.inTransaction).toBe(true); // aborted, still open (PG)
    expect(() => db.exec('SELECT id FROM t')).toThrow(/current transaction is aborted/);
    db.exec('ROLLBACK');
    expect(db.query('SELECT id FROM t').rows).toEqual([[1]]);
    expect(() => db.exec('COMMIT')).toThrow(/no transaction/);
    db.close();
  });

  it('DROP TABLE frees pages; catalog and data survive reopen + recovery', () => {
    const { fs, db } = open();
    db.exec('CREATE TABLE big (id INT PRIMARY KEY, pad TEXT)');
    const rows: string[] = [];
    for (let i = 0; i < 500; i++) rows.push(`(${i}, '${'x'.repeat(200)}')`);
    db.exec(`INSERT INTO big VALUES ${rows.join(',')}`);
    const pagesBefore = db.pager.getMeta().pageCount;
    db.exec('DROP TABLE big');
    expect(db.pager.getMeta().freelistHead).not.toBe(0);
    db.exec('CREATE TABLE again (id INT PRIMARY KEY, pad TEXT)');
    db.exec(`INSERT INTO again VALUES ${rows.join(',')}`);
    expect(db.pager.getMeta().pageCount).toBeLessThanOrEqual(pagesBefore + 2); // pages were reused
    // crash without close: everything committed must come back via the WAL
    fs.crash('drop');
    const db2 = new Database('/db', { openFile: fs.open, poolSize: 128 });
    expect(db2.query('SELECT id FROM again WHERE id = 499').rows).toEqual([[499]]);
    expect(db2.query('SELECT * FROM again').rows.length).toBe(500);
    expect(() => db2.exec('SELECT * FROM big')).toThrow(/does not exist/);
    expect(db2.query('SELECT name FROM __tables').rows).toEqual([['again']]);
    db2.close();
  });

  it('system tables are readable, not writable', () => {
    const { db } = open();
    db.exec('CREATE TABLE t (a INT, b TEXT NOT NULL)');
    expect(db.query('SELECT name, type, not_null FROM __columns ORDER BY ordinal').rows).toEqual([
      ['a', 'INT', false],
      ['b', 'TEXT', true],
    ]);
    expect(() => db.exec("INSERT INTO __tables VALUES (9, 'x', 1)")).toThrow(/system table/);
    expect(() => db.exec('CREATE TABLE __x (a INT)')).toThrow(/reserved/);
    db.close();
  });

  it('parser: comments, quoted strings, no statement run-on', () => {
    const { db } = open();
    db.exec("CREATE TABLE t (s TEXT); -- trailing comment\n/* block */ INSERT INTO t VALUES ('it''s');");
    expect(db.query('SELECT s FROM t').rows).toEqual([["it's"]]);
    expect(() => db.exec('SELECT * FROM t DELETE FROM t')).toThrow(/syntax error/);
    expect(db.query('SELECT * FROM t').rows.length).toBe(1);
    expect(() => db.exec('SELECT * FROM t WHERE')).toThrow(/syntax error at or near end of input/);
    db.close();
  });
});
