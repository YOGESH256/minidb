/**
 * Acceptance measurements for the edge prototype (docs/edge/PROTOCOL.md §acceptance):
 * cold open + first indexed query, request count, bytes, memory, p50/p99,
 * against the in-memory store with simulated per-request latency.
 *
 *   npx tsx scripts/_edge-bench.ts [rows=20000] [latencyMs=30]
 */
import { Database } from '../src/index.js';
import { MemoryObjectStore, RemoteSnapshot, writeSnapshot } from '../src/edge/index.js';

const ROWS = Number(process.argv[2] ?? 20000);
const LATENCY = Number(process.argv[3] ?? 30);

const db = new Database(':memory:', { checkpointBytes: 1 << 30 });
db.exec('CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL, team INT, bio TEXT)');
db.exec('CREATE INDEX users_team ON users (team)');
const ins = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)');
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) ins.run(i, 'user' + i, i % 200, 'bio '.repeat(20) + i);
})();

const store = new MemoryObjectStore();
const t0 = performance.now();
const snap = await writeSnapshot(db, store, 'bench', null, 1);
const uploadMs = performance.now() - t0;
const manifestBytes = (await store.get('bench/manifest'))!.data.length;
console.log(JSON.stringify({ rows: ROWS, pages: snap.manifest.pageCount, chunks: snap.chunksUploaded, manifestKB: +(manifestBytes / 1024).toFixed(1), hotPages: Object.keys(snap.manifest.hot).length, uploadMs: Math.round(uploadMs) }));

store.latencyMs = LATENCY;
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;

// cold: open + one indexed lookup, repeated with a fresh reader each time
const cold: number[] = [];
let coldReq = 0;
let coldBytes = 0;
for (let i = 0; i < 10; i++) {
  store.resetStats();
  const memBefore = process.memoryUsage().heapUsed;
  const s = performance.now();
  const r = await RemoteSnapshot.open(store, 'bench');
  await r.lookup('users', (i * 7919) % ROWS);
  cold.push(performance.now() - s);
  coldReq = store.stats.gets + store.stats.rangeGets;
  coldBytes = store.stats.bytesRead;
  if (i === 0) console.log(JSON.stringify({ coldOpenPlusLookup_heapDeltaKB: Math.round((process.memoryUsage().heapUsed - memBefore) / 1024) }));
}

// warm: same reader, many lookups (chunk cache bounded)
const reader = await RemoteSnapshot.open(store, 'bench', { maxCachedChunks: 16 }); // a quarter of this database: forces real fetches
store.resetStats();
const warm: number[] = [];
for (let i = 0; i < 200; i++) {
  const s = performance.now();
  await reader.lookup('users', (i * 7919) % ROWS);
  warm.push(performance.now() - s);
}
const warmReqPerLookup = (store.stats.rangeGets / 200).toFixed(2);

// secondary index lookup (60-100 rows spread over many heap pages: the worst case for range fetches)
store.resetStats();
const s2 = performance.now();
const team = await reader.lookup('users', 42, 'users_team');
const teamMs = performance.now() - s2;

// full scan
store.resetStats();
const s3 = performance.now();
let n = 0;
for await (const _ of reader.scan('users')) n++;
const scanMs = performance.now() - s3;

console.log(
  JSON.stringify({
    latencyMs: LATENCY,
    cold: { p50ms: Math.round(pct(cold, 0.5)), p99ms: Math.round(pct(cold, 0.99)), requests: coldReq, bytesKB: Math.round(coldBytes / 1024) },
    warmLookup: { p50ms: Math.round(pct(warm, 0.5)), p99ms: Math.round(pct(warm, 0.99)), rangeGetsPerLookup: warmReqPerLookup },
    secondaryIndex: { rows: team.length, ms: Math.round(teamMs), rangeGets: store.stats.rangeGets },
    fullScan: { rows: n, ms: Math.round(scanMs), rangeGets: store.stats.rangeGets, bytesKB: Math.round(store.stats.bytesRead / 1024) },
  }),
);
db.close();
