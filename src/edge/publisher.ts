/**
 * The write side of the protocol: take the lease, work on a local copy,
 * publish with a conditional PUT. See docs/edge/PROTOCOL.md.
 *
 * The local copy is a normal in-memory Database materialised from the
 * snapshot, so every existing feature (SQL, transactions, indexes, verify)
 * works on it unchanged. Publish diffs pages by content, uploads changed
 * chunks, and swaps the manifest.
 */
import { Database } from '../database.js';
import { MemoryFiles, type FileSystem } from '../storage/file-io.js';
import { PAGE_SIZE } from '../storage/page.js';
import { PreconditionFailedError, type ObjectStore } from './store.js';
import { keys, decodeManifest, type Manifest, type Lease } from './manifest.js';
import { RemoteSnapshot } from './reader.js';
import { writeSnapshot, type SnapshotResult } from './snapshot-writer.js';

export class LeaseHeldError extends Error {
  constructor(lease: Lease) {
    super(`database is being written by "${lease.owner}" (generation ${lease.generation}) until ${lease.expires}`);
    this.name = 'LeaseHeldError';
  }
}

/** Publish was refused: the manifest moved under us. Local work was not persisted. */
export class PublishConflictError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PublishConflictError';
  }
}

export interface PublisherOptions {
  owner: string;
  leaseMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class Publisher {
  private lease: { value: Lease; etag: string } | null = null;
  private readonly now: () => number;
  private readonly leaseMs: number;
  /** Set once open() has run: the manifest this writer started from. */
  private base: { manifest: Manifest; etag: string } | null = null;
  db: Database | null = null;

  constructor(
    private readonly store: ObjectStore,
    private readonly prefix: string,
    private readonly opts: PublisherOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.leaseMs = opts.leaseMs ?? 30_000;
  }

  get generation(): number {
    return this.lease?.value.generation ?? 0;
  }

  // ------------------------------------------------------------ lease

  /** Take the lease with a conditional PUT. Refuses if another live owner holds it. */
  async acquireLease(): Promise<Lease> {
    const key = keys.lease(this.prefix);
    const cur = await this.store.get(key);
    let generation = 1;
    if (cur) {
      const l = JSON.parse(cur.data.toString('utf8')) as Lease;
      const expired = Date.parse(l.expires) <= this.now();
      if (!expired && l.owner !== this.opts.owner) throw new LeaseHeldError(l);
      generation = l.generation + 1;
    }
    const value: Lease = { owner: this.opts.owner, generation, expires: new Date(this.now() + this.leaseMs).toISOString() };
    try {
      const { etag } = await this.store.put(key, Buffer.from(JSON.stringify(value)), cur ? { ifMatch: cur.etag } : { ifNoneMatch: true });
      this.lease = { value, etag };
    } catch (e) {
      if (e instanceof PreconditionFailedError) throw new LeaseHeldError(value);
      throw e;
    }
    return value;
  }

  async renewLease(): Promise<void> {
    if (!this.lease) throw new Error('no lease');
    const value: Lease = { ...this.lease.value, expires: new Date(this.now() + this.leaseMs).toISOString() };
    const { etag } = await this.store.put(keys.lease(this.prefix), Buffer.from(JSON.stringify(value)), { ifMatch: this.lease.etag });
    this.lease = { value, etag };
  }

  // ------------------------------------------------------------ local copy

  /** Materialise the current snapshot into an in-memory Database. Fetches every chunk (fine for small tenant databases). */
  async open(): Promise<Database> {
    const snap = await RemoteSnapshot.open(this.store, this.prefix, { maxCachedChunks: 1 << 20 });
    const files = new MemoryFiles();
    const io = files.open(this.prefix);
    for (let p = 0; p < snap.manifest.pageCount; p++) io.write(p * PAGE_SIZE, (await snap.page(p)).buf);
    const fs: FileSystem = { open: files.open, lock: () => () => {} };
    this.db = new Database(this.prefix, { fs, checkpointBytes: 1 << 30 });
    this.base = { manifest: snap.manifest, etag: snap.etag };
    return this.db;
  }

  /** Brand-new database: create locally, publish version 1. */
  async create(): Promise<Database> {
    this.db = new Database(':memory:', { checkpointBytes: 1 << 30 });
    this.base = null;
    return this.db;
  }

  // ------------------------------------------------------------ publish

  /**
   * The commit point. Uploads changed chunks, then swaps the manifest with
   * If-Match on the one we opened from. A stale writer (lease taken over,
   * manifest moved) gets PublishConflictError; nothing of theirs is visible.
   * A lost acknowledgement is resolved by reading the manifest back.
   */
  async publish(): Promise<SnapshotResult> {
    if (!this.db) throw new Error('open() or create() first');
    if (!this.lease) throw new Error('acquireLease() first');
    if (this.db.inTransaction) throw new Error('commit or roll back the open transaction first');
    // Belt and braces: if someone published since we opened, don't even upload.
    const current = await this.store.get(keys.manifest(this.prefix));
    if (this.base && (!current || current.etag !== this.base.etag)) {
      throw new PublishConflictError(`manifest moved: expected version ${this.base.manifest.version}, found ${current ? decodeManifest(current.data).version : 'none'}`);
    }
    if (!this.base && current) throw new PublishConflictError('database already exists');
    const generation = this.lease.value.generation;
    try {
      const r = await writeSnapshot(this.db, this.store, this.prefix, this.base, generation);
      this.base = { manifest: r.manifest, etag: r.etag };
      return r;
    } catch (e) {
      if (e instanceof PreconditionFailedError) throw new PublishConflictError('manifest changed during publish (stale writer)');
      // Lost acknowledgement? Read back: if the manifest carries our version and generation, it committed.
      const after = await this.store.get(keys.manifest(this.prefix));
      if (after) {
        const m = decodeManifest(after.data);
        const expectedVersion = (this.base?.manifest.version ?? 0) + 1;
        if (m.version === expectedVersion && m.generation === generation) {
          this.base = { manifest: m, etag: after.etag };
          return { manifest: m, etag: after.etag, chunksUploaded: -1, chunksReused: -1 };
        }
      }
      throw e;
    }
  }

  /** Delete chunk objects no manifest references. Caller decides the grace period. */
  async collectGarbage(): Promise<number> {
    const current = await this.store.get(keys.manifest(this.prefix));
    if (!current) return 0;
    const live = new Set(Object.values(decodeManifest(current.data).chunks));
    let removed = 0;
    for (const key of await this.store.list(keys.chunkPrefix(this.prefix))) {
      const id = key.slice(keys.chunkPrefix(this.prefix).length).replace(/\.pages$/, '');
      if (!live.has(id)) {
        await this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

