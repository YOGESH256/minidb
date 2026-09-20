#!/usr/bin/env node
/**
 * A week in the life of a small shop's database, with something living in it.
 *
 *   npx tsx examples/custodian-demo.ts
 *
 * Nothing here asks the custodian a question. It watches the ordinary traffic
 * go past, and at the end says what it noticed. Then we take one piece of its
 * advice and measure whether it was worth taking.
 */
import { Database, type Finding } from '../src/index.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const colour = { warning: '\x1b[31m', suggestion: '\x1b[33m', info: '\x1b[36m' } as const;

const db = new Database(':memory:', { custodian: true, history: true, checkpointBytes: 1 << 30 });
db.exec(`
  CREATE TABLE orders (id INT PRIMARY KEY, status TEXT NOT NULL, customer INT, coupon TEXT);
  CREATE INDEX orders_coupon ON orders (coupon);
`);

// ---- Monday: the shop fills up.
const place = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)');
db.transaction(() => {
  for (let i = 0; i < 8000; i++) {
    const coupon = i % 3 === 0 ? 'SAVE10' : null;
    place.run(i, i % 2000 === 0 ? 'disputed' : 'shipped', i % 900, coupon);
  }
})();
db.sampleColumn('orders', 'coupon'); // a healthy reading, while things are fine

// ---- All week: support looks up disputed orders, over and over.
const disputed = db.prepare('SELECT id, customer FROM orders WHERE status = ?');
for (let i = 0; i < 40; i++) disputed.all('disputed');

// ---- Also all week: two jobs disagree about one order's status.
const setStatus = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
for (let i = 0; i < 6; i++) {
  setStatus.run('refunded', 12);
  setStatus.run('shipped', 12);
}

// ---- Thursday: a deploy quietly stops writing coupons.
db.exec('UPDATE orders SET coupon = NULL WHERE id > 1500');
db.sampleColumn('orders', 'coupon');

// ---- Friday: somebody asks what the custodian has seen.
console.log(bold('\nWhat the custodian noticed this week\n'));
const findings = db.notice();
for (const f of findings) print(f);

// ---- And we take the index advice, then check it was worth it.
const advice = findings.find((f) => f.kind === 'missing-index');
if (advice?.suggestion) {
  const before = db.trace("SELECT id, customer FROM orders WHERE status = 'disputed'").summary;
  db.exec(advice.suggestion);
  const after = db.trace("SELECT id, customer FROM orders WHERE status = 'disputed'").summary;
  console.log(bold('Taking the advice: ') + dim(advice.suggestion));
  console.log(`  pages read for that query: ${before.distinctPagesRead} → ${after.distinctPagesRead}` + dim(`  (${(before.distinctPagesRead / Math.max(1, after.distinctPagesRead)).toFixed(1)}x less)`));
  console.log(dim(`  the custodian predicted about ${advice.evidence['estimatedIndexPages']} pages, ${advice.evidence['estimatedSpeedup']}x less work\n`));
}

console.log(dim('Nothing above changed the database. verify(): ' + (db.verify().ok ? 'ok' : 'PROBLEMS')));
db.close();

function print(f: Finding): void {
  const tag = `${colour[f.severity]}${f.severity}\x1b[0m`;
  console.log(`${tag} ${dim('[' + f.kind + ']')}`);
  console.log(`  ${f.message}`);
  console.log(dim('  evidence: ' + JSON.stringify(f.evidence)));
  if (f.suggestion) console.log(dim('  → ' + f.suggestion));
  console.log();
}
