/**
 * Workload for the spawn-and-kill crash test. Each transaction inserts a
 * batch of BATCH rows tagged with the same batch number, so after recovery a
 * batch must be either complete or absent. Runs until killed.
 */
import { Database } from '../src/index.js';

const path = process.argv[2]!;
const BATCH = 10;
const db = new Database(path, { checkpointBytes: 256 * 1024 }); // frequent checkpoints
if (!db.catalog.getTable('log')) db.exec('CREATE TABLE log (id INT PRIMARY KEY, batch INT, payload TEXT); CREATE INDEX log_batch ON log (batch)');
let batch = (db.query('SELECT batch FROM log ORDER BY batch DESC LIMIT 1').rows[0]?.[0] as number | undefined) ?? -1;
let id = (db.query('SELECT id FROM log ORDER BY id DESC LIMIT 1').rows[0]?.[0] as number | undefined) ?? -1;
process.stdout.write('ready\n');
for (;;) {
  batch++;
  const rows: string[] = [];
  for (let i = 0; i < BATCH; i++) rows.push(`(${++id}, ${batch}, '${'p'.repeat(100)}')`);
  db.exec(`BEGIN; INSERT INTO log VALUES ${rows.join(',')}; COMMIT`);
}
