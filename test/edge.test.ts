/**
 * The object-store protocol (docs/edge/PROTOCOL.md) against the in-memory
 * S3-like store: snapshot round trip and request counts, incremental
 * publish, stale writer, lost acknowledgement, snapshot isolation + GC.
 */
import { describe, it, expect } from 'vitest';
import { Database } from '../src/index.js';
import { MemoryObjectStore, RemoteSnapshot, Publisher, PublishConflictError, LeaseHeldError, writeSnapshot, keys, decodeManifest, CHUNK_PAGES } from '../src/edge/index.js';

function seedDb(rows = 3000): Database {
  const db = new Database(':memory:', { checkpointBytes: 1 << 30 });
  db.exec('CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL, team INT)');
  db.exec('CREATE INDEX users_team ON users (team)');
  const ins = db.prepare('INSERT INTO users VALUES (?, ?, ?)');
  const load = db.transaction(() => {
    for (let i = 0; i < rows; i++) ins.run(i, 'user' + i, i % 50);
  });
  load();
  return db;
}

describe('edge: snapshot + reader', () => {
  it('publishes a database as chunks + manifest and answers lookups with 1 manifest GET and ≤2 chunk GETs', async () => {
    const store = new MemoryObjectStore();
    const db = seedDb();
    const r = await writeSnapshot(db, store, 'tenant/a', null, 1);
    expect(r.manifest.version).toBe(1);
    expect(r.chunksUploaded).toBe(Math.ceil(r.manifest.pageCount / CHUNK_PAGES));
    expect(Object.keys(r.manifest.hot).length).toBeGreaterThan(2); // page 0 + index metas/roots
    store.resetStats();

    const snap = await RemoteSnapshot.open(store, 'tenant/a');
    expect(store.stats.gets).toBe(1); // the manifest
    expect(snap.tableNames()).toEqual(['users']);
    const catalogChunkGets = store.stats.rangeGets; // catalog heaps live in the first chunk(s)

    store.resetStats();
    expect(await snap.lookup('users', 2345)).toEqual([[2345, 'user2345', 45]]);
    expect(store.stats.gets).toBe(0);
    expect(store.stats.rangeGets).toBeLessThanOrEqual(2); // leaf chunk + heap chunk (index root/internal came from the manifest)
    expect(snap.stats.pagesServedFromManifest).toBeGreaterThanOrEqual(2);

    expect(await snap.lookup('users', 99999)).toEqual([]);
    const team7 = await snap.lookup('users', 7, 'users_team');
    expect(team7.length).toBe(60);
    expect(team7.every((row) => row[2] === 7)).toBe(true);

    let n = 0;
    for await (const row of snap.scan('users')) n += row.length ? 1 : 0;
    expect(n).toBe(3000);
    expect(catalogChunkGets).toBeLessThanOrEqual(2);
    db.close();
  });

  it('a changed database re-uploads only the chunks that changed', async () => {
    const store = new MemoryObjectStore();
    const db = seedDb();
    const v1 = await writeSnapshot(db, store, 't', null, 1);
    db.exec("UPDATE users SET name = 'usr-10' WHERE id = 10"); // same length: updated in place, index untouched
    const v2 = await writeSnapshot(db, store, 't', { manifest: v1.manifest, etag: v1.etag }, 1);
    expect(v2.manifest.version).toBe(2);
    expect(v2.chunksUploaded).toBe(1); // only the chunk holding that heap page
    expect(v2.chunksReused).toBe(v1.chunksUploaded - 1);
    db.exec("UPDATE users SET name = 'a much longer name that will not fit in place' WHERE id = 11"); // row moves: heap old + heap new + a leaf in each of the two indexes
    const v3 = await writeSnapshot(db, store, 't', { manifest: v2.manifest, etag: v2.etag }, 1);
    expect(v3.chunksUploaded).toBeLessThanOrEqual(4);
    const snap = await RemoteSnapshot.open(store, 't');
    expect(await snap.lookup('users', 10)).toEqual([[10, 'usr-10', 10]]);
    expect((await snap.lookup('users', 11))[0]![1]).toMatch(/much longer/);
    db.close();
  });
});

describe('edge: publisher', () => {
  it('create → publish → open → change → publish; readers see each version', async () => {
    const store = new MemoryObjectStore();
    const w = new Publisher(store, 'db1', { owner: 'w1' });
    await w.acquireLease();
    const db = await w.create();
    db.exec('CREATE TABLE kv (k INT PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO kv VALUES (1, 'one')");
    expect((await w.publish()).manifest.version).toBe(1);
    w.close();

    const w2 = new Publisher(store, 'db1', { owner: 'w1' });
    await w2.acquireLease();
    const db2 = await w2.open();
    expect(db2.query('SELECT v FROM kv WHERE k = 1').rows).toEqual([['one']]);
    db2.exec("INSERT INTO kv VALUES (2, 'two')");
    expect(db2.verify().ok).toBe(true);
    expect((await w2.publish()).manifest.version).toBe(2);
    w2.close();

    const snap = await RemoteSnapshot.open(store, 'db1');
    expect(snap.manifest.version).toBe(2);
    expect(await snap.lookup('kv', 2)).toEqual([[2, 'two']]);
  });

  it('stale writer: lease taken over after expiry, late publish is refused, nothing of it is visible', async () => {
    const store = new MemoryObjectStore();
    let clock = 1_000_000;
    const now = () => clock;
    const a = new Publisher(store, 'db2', { owner: 'A', leaseMs: 1000, now });
    await a.acquireLease();
    const dbA = await a.create();
    dbA.exec('CREATE TABLE t (id INT PRIMARY KEY, who TEXT)');
    await a.publish(); // version 1
    dbA.exec("INSERT INTO t VALUES (1, 'A')"); // A's unpublished work

    clock += 5000; // A's lease expires
    const b = new Publisher(store, 'db2', { owner: 'B', leaseMs: 1000, now });
    await b.acquireLease();
    expect(b.generation).toBe(a.generation + 1);
    const dbB = await b.open();
    dbB.exec("INSERT INTO t VALUES (1, 'B')");
    await b.publish(); // version 2, generation 2

    await expect(a.publish()).rejects.toBeInstanceOf(PublishConflictError);
    const snap = await RemoteSnapshot.open(store, 'db2');
    expect(await snap.lookup('t', 1)).toEqual([[1, 'B']]);
    expect(snap.manifest.generation).toBe(b.generation);

    // The race variant: A's pre-check passes but the store rejects the conditional PUT.
    const stale = { manifest: snap.manifest, etag: 'not-the-current-etag' };
    await expect(writeSnapshot(dbA, store, 'db2', stale, a.generation)).rejects.toThrow(/precondition failed/);
    expect(decodeManifest((await store.get(keys.manifest('db2')))!.data).version).toBe(2);

    // A live lease is refused outright.
    const c = new Publisher(store, 'db2', { owner: 'C', leaseMs: 1000, now });
    await expect(c.acquireLease()).rejects.toBeInstanceOf(LeaseHeldError);
    a.close();
    b.close();
  });

  it('lost acknowledgement: the manifest PUT lands but the response is lost; publish resolves by reading back', async () => {
    const store = new MemoryObjectStore();
    const w = new Publisher(store, 'db3', { owner: 'w' });
    await w.acquireLease();
    const db = await w.create();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await w.publish();
    db.exec('INSERT INTO t VALUES (7)');
    store.failNext('put', keys.manifest('db3'), 'apply-then-throw');
    const r = await w.publish();
    expect(r.manifest.version).toBe(2);
    expect(r.chunksUploaded).toBe(-1); // resolved by read-back, not by a second PUT
    expect(store.stats.puts).toBeGreaterThan(0);
    const snap = await RemoteSnapshot.open(store, 'db3');
    expect(await snap.lookup('t', 7)).toEqual([[7]]);
    // and a genuinely failed PUT (nothing landed) is an error, not a silent success
    db.exec('INSERT INTO t VALUES (8)');
    store.failNext('put', keys.manifest('db3'), 'throw');
    await expect(w.publish()).rejects.toThrow(/injected network error/);
    w.close();
  });

  it('snapshot isolation: an open reader keeps its version until garbage collection removes its chunks', async () => {
    const store = new MemoryObjectStore();
    const w = new Publisher(store, 'db4', { owner: 'w' });
    await w.acquireLease();
    const db = await w.create();
    db.exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 500; i++) db.exec(`INSERT INTO t VALUES (${i}, 'v${i}')`);
    await w.publish();
    const reader = await RemoteSnapshot.open(store, 'db4'); // pinned at version 1
    db.exec("UPDATE t SET v = 'changed'");
    await w.publish();
    expect(await reader.lookup('t', 400)).toEqual([[400, 'v400']]); // still version 1
    expect((await RemoteSnapshot.open(store, 'db4')).manifest.version).toBe(2);
    const removed = await w.collectGarbage();
    expect(removed).toBeGreaterThan(0);
    const fresh = await RemoteSnapshot.open(store, 'db4');
    expect(await fresh.lookup('t', 400)).toEqual([[400, 'changed']]);
    // the old reader's uncached chunks are gone now: loud failure, not wrong data
    reader.dropCache();
    await expect(reader.lookup('t', 1)).rejects.toThrow(/garbage-collected|missing/);
    w.close();
  });
});
