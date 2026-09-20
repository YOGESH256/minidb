// node --import tsx docs/research/catalog-size/measure.mjs /private/tmp/minidb-catalog-sizes
// Imports the actual engine encoder and validates representative decisions through SQL.
import assert from 'node:assert/strict';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Database } from '../../../src/index.ts';
import { encodeTuple } from '../../../src/types.ts';
import { MAX_TUPLE_SIZE } from '../../../src/storage/heap.ts';
import { SYS_CHANGES_COLS } from '../../../src/catalog.ts';

const directory = process.argv[2];
const sources = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
const receiptTypes = SYS_CHANGES_COLS.map(c => c.type);
const size = values => encodeTuple(['INT', ...values.slice(1).map(() => 'TEXT')], values).length;
const receipt = (before, after, table = 'records') => encodeTuple(receiptTypes,
  [2, 0, table, before ? 'UPDATE' : 'INSERT', JSON.stringify(after[0]),
    before ? JSON.stringify(before) : null, JSON.stringify(after)]).length;

function dimensions(row, projection = false) {
  const before = [row.id, ...(projection ? row.projection : row.cells)];
  const after = [...before];
  const column = projection ? 1 : 1 + (row.title_index ?? 0);
  after[column] = (after[column] ?? '') + 'x'; // minimal growing edit: one extra ASCII byte
  return { before, after, column, rowBytes: Math.max(size(before), size(after)),
    insertBytes: Math.max(size(before), receipt(null, before)),
    updateBytes: Math.max(size(after), receipt(before, after)),
    receiptBytes: receipt(before, after) };
}

function sqlProbe(row, history) {
  const d = dimensions(row);
  const db = new Database(':memory:', { history });
  const names = row.cells.map((_, i) => `c${i}`);
  db.exec(`CREATE TABLE records (id INT PRIMARY KEY, ${names.map(n => `${n} TEXT`).join(', ')})`);
  let stage = 'insert';
  let error = null;
  try {
    db.prepare(`INSERT INTO records VALUES (${d.before.map(() => '?').join(', ')})`).run(...d.before);
    stage = 'update';
    db.prepare(`UPDATE records SET ${names[d.column - 1]} = ? WHERE id = ?`).run(d.after[d.column], row.id);
    assert.deepEqual(db.query('SELECT * FROM records').rows[0], d.after);
    if (history) {
      stage = 'undo';
      db.undo(db.lastTxn());
      assert.deepEqual(db.query('SELECT * FROM records').rows[0], d.before);
    }
    stage = 'passed';
  } catch (e) {
    error = e.message;
    assert.match(error, /row too large/);
    assert.deepEqual(db.query('SELECT * FROM records').rows, stage === 'insert' ? [] : [d.before]);
  } finally {
    db.close();
  }
  const expected = history
    ? d.insertBytes > MAX_TUPLE_SIZE ? 'insert' : d.updateBytes > MAX_TUPLE_SIZE ? 'update' : 'passed'
    : size(d.before) > MAX_TUPLE_SIZE ? 'insert' : size(d.after) > MAX_TUPLE_SIZE ? 'update' : 'passed';
  assert.equal(stage, expected);
  return { stage, error };
}

function summary(values) {
  values.sort((a, b) => a - b);
  const at = p => values[Math.max(0, Math.ceil(p * values.length) - 1)];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: values.at(-1) };
}

const results = [];
for (const source of sources) {
  const result = { source, records: 0, baseRowTooLarge: 0, historyInsertTooLarge: 0,
    historyEditTooLarge: 0, insertFitsButEditFails: 0, payloadAloneProvesEditImpossible: 0,
    projectionEditTooLarge: 0, projectionBytesRetained: 0, originalValueBytes: 0 };
  const bytes = { row: [], receipt: [], payload: [], projection: [] };
  const representatives = new Map();
  for await (const line of createInterface({ input: createReadStream(join(directory, source.id + '.jsonl')), crlfDelay: Infinity })) {
    const row = JSON.parse(line);
    const full = dimensions(row);
    const projected = dimensions(row, true);
    result.records++;
    result.baseRowTooLarge += full.rowBytes > MAX_TUPLE_SIZE;
    result.historyInsertTooLarge += full.insertBytes > MAX_TUPLE_SIZE;
    result.historyEditTooLarge += full.updateBytes > MAX_TUPLE_SIZE;
    result.insertFitsButEditFails += full.insertBytes <= MAX_TUPLE_SIZE && full.updateBytes > MAX_TUPLE_SIZE;
    result.payloadAloneProvesEditImpossible += row.payload_bytes * 2 > MAX_TUPLE_SIZE;
    result.projectionEditTooLarge += projected.updateBytes > MAX_TUPLE_SIZE;
    result.originalValueBytes += row.cells.reduce((n, v) => n + Buffer.byteLength(v), 0);
    result.projectionBytesRetained += row.projection.reduce((n, v) => n + (v === null ? 0 : Buffer.byteLength(v)), 0);
    bytes.row.push(full.rowBytes);
    bytes.receipt.push(full.receiptBytes);
    bytes.payload.push(row.payload_bytes);
    bytes.projection.push(projected.receiptBytes);
    const category = full.rowBytes > MAX_TUPLE_SIZE ? 'base_failure'
      : full.insertBytes > MAX_TUPLE_SIZE ? 'history_insert_failure'
      : full.updateBytes > MAX_TUPLE_SIZE ? 'history_update_failure' : 'fits';
    if (!representatives.has(category)) representatives.set(category, row);
    const prior = representatives.get('largest_fitting');
    if (full.updateBytes <= MAX_TUPLE_SIZE && (!prior || full.updateBytes > dimensions(prior).updateBytes))
      representatives.set('largest_fitting', row);
  }
  assert.equal(result.records, source.records);
  result.byteDistributions = Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, summary(v)]));
  result.sqlProbes = [];
  for (const [category, row] of representatives) {
    result.sqlProbes.push({ category, recordOrdinal: row.id, sourceId: row.source_id,
      fields: row.cells.length, predictedReceiptBytes: dimensions(row).receiptBytes,
      historyOff: sqlProbe(row, false), historyOn: sqlProbe(row, true) });
  }
  results.push(result);
  console.log(JSON.stringify({ source: source.id, records: result.records, baseFailures: result.baseRowTooLarge,
    historyInsertFailures: result.historyInsertTooLarge, historyEditFailures: result.historyEditTooLarge,
    fitsImportFailsEdit: result.insertFitsButEditFails, payloadLowerBoundFailures: result.payloadAloneProvesEditImpossible,
    projectionFailures: result.projectionEditTooLarge, receiptBytes: result.byteDistributions.receipt }));
}

const boundaries = [];
for (const [label, table, extra] of [['minimal_ascii', 't', []], ['catalog_ascii', 'records', ['Example Press', 'History']]]) {
  const fits = n => receipt([1, 'a'.repeat(n), ...extra], [1, 'b'.repeat(n), ...extra], table) <= MAX_TUPLE_SIZE;
  let low = 0, high = MAX_TUPLE_SIZE;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid; else high = mid - 1;
  }
  const checks = [];
  for (const n of [low, low + 1]) {
    const db = new Database(':memory:', { history: true });
    db.exec(`CREATE TABLE ${table} (id INT PRIMARY KEY, value TEXT${extra.map((_, i) => `, c${i} TEXT`).join('')})`);
    const before = [1, 'a'.repeat(n), ...extra];
    db.prepare(`INSERT INTO ${table} VALUES (${before.map(() => '?').join(',')})`).run(...before);
    let error = null;
    try { db.prepare(`UPDATE ${table} SET value = ? WHERE id = 1`).run('b'.repeat(n)); }
    catch (e) { error = e.message; }
    assert.equal(error === null, n === low);
    db.close();
    checks.push({ textBytes: n, receiptBytes: receipt(before, [1, 'b'.repeat(n), ...extra], table), error });
  }
  boundaries.push({ label, maxAsciiTextBytesForSameLengthUpdate: low, checks });
}
writeFileSync(join(directory, 'results.json'), JSON.stringify({ engineCommit: '6d306d0', node: process.version,
  maxTupleBytes: MAX_TUPLE_SIZE, edit: 'append one ASCII byte to title', results, boundaries }, null, 2) + '\n');
console.log(JSON.stringify({ boundaries }));
