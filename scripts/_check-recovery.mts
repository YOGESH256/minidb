/**
 * Open a database that was killed mid-write and report what survived.
 * Used by scripts/kill-9-demo.sh; exits non-zero if any batch is torn.
 */
import { Database } from '../src/index.js';

const path = process.argv[2];
if (!path) throw new Error('usage: _check-recovery.mts <db>');

const g = '\x1b[32m';
const r = '\x1b[31m';
const d = '\x1b[2m';
const n = '\x1b[0m';

const db = new Database(path);
const batches = db.query('SELECT batch FROM log ORDER BY batch').rows.map((row) => row[0] as number);
const perBatch = new Map<number, number>();
for (const b of batches) perBatch.set(b, (perBatch.get(b) ?? 0) + 1);
const torn = [...perBatch.entries()].filter(([, count]) => count !== 10);
const contiguous = [...perBatch.keys()].every((b, i) => b === i);

console.log(`   ${batches.length} rows recovered, in ${perBatch.size} complete batches`);
console.log(`   ${d}batches run from 0 with no gaps: ${contiguous}${n}`);
if (torn.length) {
  console.log(`   ${r}TORN BATCHES: ${JSON.stringify(torn)}${n}`);
  process.exit(1);
}
console.log(`   ${g}every batch is all-or-nothing. no half-written transaction survived.${n}`);
console.log(`   ${d}integrity check: ${db.verify().ok ? 'pages, chains and indexes all sound' : 'FAILED'}${n}`);
db.close();
