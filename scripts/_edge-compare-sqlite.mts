/**
 * Acceptance item 4: real SQLite (wa-sqlite, asyncify build) reading the same
 * 20k-row table through a JS VFS that fetches 64 KB chunks from the same
 * fake object store with the same simulated latency, versus minidb's reader.
 *
 *   npx tsx scripts/_edge-compare-sqlite.mts [rows=20000] [latencyMs=30]
 */
import initSqlJs from 'sql.js';
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from 'wa-sqlite';
import * as VFS from 'wa-sqlite/src/VFS.js';
import { Database } from '../src/index.js';
import { MemoryObjectStore, RemoteSnapshot, writeSnapshot } from '../src/edge/index.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ROWS = Number(process.argv[2] ?? 20000);
const LATENCY = Number(process.argv[3] ?? 30);
const CHUNK = 64 * 1024;
const CACHE_CHUNKS = 16;
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const bio = (i: number) => 'bio '.repeat(20) + i;

// ------------------------------------------------------------ build the SQLite file with sql.js
const SQL = await initSqlJs();
const sdb = new SQL.Database();
sdb.run('PRAGMA page_size = 4096; PRAGMA journal_mode = OFF;');
sdb.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, team INTEGER, bio TEXT)');
sdb.run('BEGIN');
const st = sdb.prepare('INSERT INTO users VALUES (?, ?, ?, ?)');
for (let i = 0; i < ROWS; i++) st.run([i, 'user' + i, i % 200, bio(i)]);
st.free();
sdb.run('COMMIT');
sdb.run('CREATE INDEX users_team ON users (team)');
const sqliteBytes = Buffer.from(sdb.export());
sdb.close();

// ------------------------------------------------------------ same store, same chunking, for both
const store = new MemoryObjectStore();
for (let off = 0, n = 0; off < sqliteBytes.length; off += CHUNK, n++) await store.put(`sqlite/chunks/${n}`, sqliteBytes.subarray(off, off + CHUNK));
const sqliteChunks = Math.ceil(sqliteBytes.length / CHUNK);

const mdb = new Database(':memory:', { checkpointBytes: 1 << 30 });
mdb.exec('CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL, team INT, bio TEXT)');
mdb.exec('CREATE INDEX users_team ON users (team)');
const ins = mdb.prepare('INSERT INTO users VALUES (?, ?, ?, ?)');
mdb.transaction(() => {
  for (let i = 0; i < ROWS; i++) ins.run(i, 'user' + i, i % 200, bio(i));
})();
const snap = await writeSnapshot(mdb, store, 'minidb', null, 1);
console.log(JSON.stringify({ rows: ROWS, sqliteFileKB: Math.round(sqliteBytes.length / 1024), sqliteChunks, minidbPages: snap.manifest.pageCount, minidbChunks: snap.chunksUploaded, minidbManifestKB: Math.round(JSON.stringify(snap.manifest).length / 1024) }));
store.latencyMs = LATENCY;

// ------------------------------------------------------------ a read-only chunked VFS for wa-sqlite
class ChunkedStoreVFS extends VFS.Base {
  name = 'chunked-store';
  private cache = new Map<number, Buffer>();
  constructor(private readonly size: number) {
    super();
  }
  reset(): void {
    this.cache.clear();
  }
  private async chunk(n: number): Promise<Buffer> {
    let c = this.cache.get(n);
    if (!c) {
      c = (await store.getRange(`sqlite/chunks/${n}`, 0, CHUNK))!;
      if (this.cache.size >= CACHE_CHUNKS) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(n, c);
    }
    return c;
  }
  xOpen(_name: string, _fileId: number, _flags: number, pOutFlags: DataView): number {
    pOutFlags.setInt32(0, VFS.SQLITE_OPEN_READONLY, true);
    return VFS.SQLITE_OK;
  }
  xClose(): number {
    return VFS.SQLITE_OK;
  }
  xRead(_fileId: number, pData: Uint8Array, iOffset: number): number {
    return this.handleAsync(async () => {
      let done = 0;
      while (done < pData.byteLength && iOffset + done < this.size) {
        const pos = iOffset + done;
        const n = Math.floor(pos / CHUNK);
        const c = await this.chunk(n);
        const within = pos - n * CHUNK;
        const take = Math.min(pData.byteLength - done, c.length - within);
        pData.set(c.subarray(within, within + take), done);
        done += take;
      }
      if (done < pData.byteLength) {
        pData.fill(0, done);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }
      return VFS.SQLITE_OK;
    }) as unknown as number;
  }
  xFileSize(_fileId: number, pSize64: DataView): number {
    pSize64.setBigInt64(0, BigInt(this.size), true);
    return VFS.SQLITE_OK;
  }
  xAccess(_name: string, _flags: number, pResOut: DataView): number {
    pResOut.setInt32(0, 1, true);
    return VFS.SQLITE_OK;
  }
  xLock(): number {
    return VFS.SQLITE_OK;
  }
  xUnlock(): number {
    return VFS.SQLITE_OK;
  }
  xCheckReservedLock(_fileId: number, pResOut: DataView): number {
    pResOut.setInt32(0, 0, true);
    return VFS.SQLITE_OK;
  }
  xDeviceCharacteristics(): number {
    return VFS.SQLITE_IOCAP_IMMUTABLE;
  }
}

const wasmPath = createRequire(import.meta.url).resolve('wa-sqlite/dist/wa-sqlite-async.wasm');
const module = await SQLiteESMFactory({ wasmBinary: readFileSync(wasmPath) });
const sqlite3 = SQLite.Factory(module);
const vfs = new ChunkedStoreVFS(sqliteBytes.length);
sqlite3.vfs_register(vfs, true);

async function sqliteRun(sql: string, bind?: (number | string)[]): Promise<unknown[][]> {
  const db = await sqlite3.open_v2('users.db', VFS.SQLITE_OPEN_READONLY, 'chunked-store');
  const rows: unknown[][] = [];
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (bind) sqlite3.bind_collection(stmt, bind);
    while ((await sqlite3.step(stmt)) === VFS.SQLITE_ROW) rows.push(sqlite3.row(stmt));
  }
  await sqlite3.close(db);
  return rows;
}

// ------------------------------------------------------------ measurements, identical shape for both
async function measure(label: string, fns: { cold: (key: number) => Promise<void>; warmSetup: () => Promise<unknown>; warm: (r: unknown, key: number) => Promise<void>; secondary: (r: unknown) => Promise<number>; scan: (r: unknown) => Promise<number> }) {
  const cold: number[] = [];
  let coldReq = 0;
  let coldBytes = 0;
  for (let i = 0; i < 10; i++) {
    store.resetStats();
    const s = performance.now();
    await fns.cold((i * 7919) % ROWS);
    cold.push(performance.now() - s);
    coldReq = store.stats.gets + store.stats.rangeGets;
    coldBytes = store.stats.bytesRead;
  }
  const r = await fns.warmSetup();
  store.resetStats();
  const warm: number[] = [];
  for (let i = 0; i < 100; i++) {
    const s = performance.now();
    await fns.warm(r, (i * 7919) % ROWS);
    warm.push(performance.now() - s);
  }
  const warmReq = ((store.stats.gets + store.stats.rangeGets) / 100).toFixed(2);
  store.resetStats();
  let s2 = performance.now();
  const n2 = await fns.secondary(r);
  const secMs = performance.now() - s2;
  const secReq = store.stats.gets + store.stats.rangeGets;
  store.resetStats();
  s2 = performance.now();
  const n3 = await fns.scan(r);
  const scanMs = performance.now() - s2;
  console.log(
    JSON.stringify({
      engine: label,
      cold: { requests: coldReq, bytesKB: Math.round(coldBytes / 1024), p50ms: Math.round(pct(cold, 0.5)), p99ms: Math.round(pct(cold, 0.99)) },
      warmLookup: { requestsPerLookup: warmReq, p50ms: Math.round(pct(warm, 0.5)), p99ms: Math.round(pct(warm, 0.99)) },
      secondary100: { rows: n2, requests: secReq, ms: Math.round(secMs) },
      fullScan: { rows: n3, requests: store.stats.gets + store.stats.rangeGets, bytesKB: Math.round(store.stats.bytesRead / 1024), ms: Math.round(scanMs) },
    }),
  );
}

await measure('sqlite (wa-sqlite + chunked VFS)', {
  cold: async (key) => {
    vfs.reset();
    await sqliteRun('SELECT * FROM users WHERE id = ?', [key]);
  },
  warmSetup: async () => {
    vfs.reset();
    return null;
  },
  warm: async (_r, key) => {
    await sqliteRun('SELECT * FROM users WHERE id = ?', [key]);
  },
  secondary: async () => (await sqliteRun('SELECT * FROM users WHERE team = 42')).length,
  scan: async () => Number((await sqliteRun("SELECT COUNT(*) FROM users WHERE bio <> ''"))[0]![0]), // predicate on a non-indexed column forces a table scan
});

await measure('minidb (RemoteSnapshot)', {
  cold: async (key) => {
    const r = await RemoteSnapshot.open(store, 'minidb', { maxCachedChunks: CACHE_CHUNKS });
    await r.lookup('users', key);
  },
  warmSetup: () => RemoteSnapshot.open(store, 'minidb', { maxCachedChunks: CACHE_CHUNKS }),
  warm: async (r, key) => {
    await (r as RemoteSnapshot).lookup('users', key);
  },
  secondary: async (r) => (await (r as RemoteSnapshot).lookup('users', 42, 'users_team')).length,
  scan: async (r) => {
    let n = 0;
    for await (const _ of (r as RemoteSnapshot).scan('users')) n++;
    return n;
  },
});
mdb.close();
