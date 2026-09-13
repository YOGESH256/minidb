import { Page, PAGE_SIZE, PageType } from './page.js';
import { Wal, PAGE_IMAGE_RECORD_SIZE } from './wal.js';
import type { FileIO, OpenFile } from './file-io.js';
import { getDefaultFileSystem } from './file-io.js';

/**
 * Pager = disk manager + buffer pool + transaction/checkpoint/recovery.
 *
 * Single-writer protocol (redo-only WAL, no undo):
 *   begin()   → remember the WAL end offset (rewind point)
 *   modify    → acquire frame, mutate page bytes, markDirty (frame becomes
 *               txn-dirty; not evicted unless the pool is under pressure)
 *   spill     → under pressure a txn-dirty frame's image is appended to the
 *               WAL (no fsync) and the frame freed; re-reads come from the WAL.
 *               The image precedes the eventual COMMIT record, so recovery
 *               replays it; rollback rewinds the WAL past it.
 *   commit()  → for each txn-dirty page: set pd_lsn, stamp checksum, append
 *               full-page image; append COMMIT; fsync WAL. On any failure the
 *               WAL is rewound to the begin() offset so nothing from this
 *               transaction can fall under a later COMMIT. Frames become
 *               "committed-dirty": durable in WAL, write-back to the data file
 *               deferred to eviction or checkpoint.
 *   rollback()→ drop txn-dirty frames from the pool, rewind the WAL.
 *   checkpoint→ write every dirty frame to the data file, fsync, truncate WAL.
 *   open()    → replay WAL page images up to the last COMMIT, then checkpoint.
 *
 * WAL-before-data invariant: a frame is only written to the data file when
 * page.lsn <= wal.durableLsn, which commit() guarantees before marking dirty.
 *
 * Page 0 is the meta page (page count, freelist head, catalog roots, id seq).
 * Every piece of engine state lives in a page, so rollback is uniform.
 */

export const DEFAULT_POOL_SIZE = 512; // frames = 2 MB
export const DEFAULT_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_USAGE = 5; // PG BM_MAX_USAGE_COUNT

const META_MAGIC = 0x3142444d; // 'MDB1'
const META_VERSION = 1;
// Meta page body offsets (after the 24 B page header)
const M_MAGIC = 24;
const M_VERSION = 28;
const M_PAGE_COUNT = 32;
const M_FREELIST_HEAD = 36;
const M_TABLES_ROOT = 40;
const M_COLUMNS_ROOT = 44;
const M_INDEXES_ROOT = 48;
const M_NEXT_OBJECT_ID = 52;
const FREE_PAGE_NEXT = 24; // free pages store the next freelist page here

export interface MetaInfo {
  pageCount: number;
  freelistHead: number;
  tablesRoot: number;
  columnsRoot: number;
  indexesRoot: number;
  nextObjectId: number;
}

/** One storage-level action, recorded when tracing is on (Database.trace). */
export type TraceEvent =
  | { op: 'read'; page: number; hit: boolean; type: string }
  | { op: 'dirty'; page: number }
  | { op: 'wal'; page: number }
  | { op: 'commit' }
  | { op: 'fsync' }
  | { op: 'write'; page: number }
  | { op: 'spill'; page: number }
  | { op: 'checkpoint' }
  | { op: 'rollback' }
  | { op: 'index'; page: number; level: number; note: string };

export class CorruptionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CorruptionError';
  }
}

export class Frame {
  pageId = -1;
  pinCount = 0;
  usage = 0;
  dirty = false; // committed but not yet written to the data file
  txnDirty = false; // modified by the open transaction
  readonly buf: Buffer = Buffer.alloc(PAGE_SIZE);
  readonly page: Page = new Page(this.buf);
  constructor(readonly index: number) {}
}

export interface PagerOptions {
  poolSize?: number;
  checkpointBytes?: number;
  openFile?: OpenFile;
}

export class Pager {
  private readonly data: FileIO;
  private readonly wal: Wal;
  private readonly frames: Frame[];
  private readonly pageTable = new Map<number, Frame>();
  private clockHand = 0;
  private txnDirtySet = new Set<Frame>();
  /** Uncommitted pages evicted under pressure: page id → end-LSN of their WAL image. */
  private spilled = new Map<number, bigint>();
  private txnWalStart = 0;
  private _inTxn = false;
  private closed = false;
  private readonly checkpointBytes: number;
  private traceBuf: TraceEvent[] | null = null;
  startTrace(): void {
    this.traceBuf = [];
  }
  stopTrace(): TraceEvent[] {
    const t = this.traceBuf ?? [];
    this.traceBuf = null;
    return t;
  }
  /** Record an event if tracing is on. Other layers (B-tree) call this too. */
  traceEvent(e: TraceEvent): void {
    if (this.traceBuf) this.traceBuf.push(e);
  }
  /** Diagnostics for tests. */
  readonly stats = { hits: 0, misses: 0, evictions: 0, spills: 0, flushes: 0, checkpoints: 0, recoveredPages: 0 };

  constructor(readonly path: string, opts: PagerOptions = {}) {
    const open = opts.openFile ?? getDefaultFileSystem().open;
    this.checkpointBytes = opts.checkpointBytes ?? DEFAULT_CHECKPOINT_BYTES;
    const poolSize = opts.poolSize ?? DEFAULT_POOL_SIZE;
    if (poolSize < 8) throw new Error('pool too small');
    this.frames = Array.from({ length: poolSize }, (_, i) => new Frame(i));
    this.data = open(path);
    this.wal = new Wal(open(path + '-wal'));
    this.recover();
    if (this.data.size() === 0) this.initMeta();
  }

  // ------------------------------------------------------------ lifecycle

  private recover(): void {
    const records = this.wal.scan();
    let lastCommit = -1;
    for (let i = 0; i < records.length; i++) if (records[i]!.type === 2) lastCommit = i;
    if (lastCommit >= 0) {
      // Last image per page wins; write in log order, which achieves that.
      for (let i = 0; i < lastCommit; i++) {
        const r = records[i]!;
        if (r.type !== 1) continue;
        this.data.write(r.pageId * PAGE_SIZE, r.payload);
        this.stats.recoveredPages++;
      }
      this.data.fsync();
    }
    // Everything after the last commit (or the whole log if none) is a crash tail.
    this.wal.reset();
  }

  private initMeta(): void {
    this.begin();
    const f = this.acquire(0);
    Page.init(f.buf, PageType.Meta, 0);
    f.buf.writeUInt32LE(META_MAGIC, M_MAGIC);
    f.buf.writeUInt32LE(META_VERSION, M_VERSION);
    f.buf.writeUInt32LE(1, M_PAGE_COUNT);
    f.buf.writeUInt32LE(0, M_FREELIST_HEAD);
    f.buf.writeUInt32LE(1, M_NEXT_OBJECT_ID);
    this.markDirty(f);
    this.release(f);
    this.commit();
  }

  close(): void {
    if (this.closed) return;
    if (this._inTxn) this.rollback();
    this.checkpoint();
    this.wal.close();
    this.data.close();
    this.closed = true;
  }

  // ------------------------------------------------------------ transactions

  get inTxn(): boolean {
    return this._inTxn;
  }

  begin(): void {
    if (this._inTxn) throw new Error('transaction already open');
    this._inTxn = true;
    this.txnWalStart = this.wal.size();
  }

  commit(): void {
    if (!this._inTxn) throw new Error('no transaction open');
    const frames = [...this.txnDirtySet].sort((a, b) => a.pageId - b.pageId);
    // Spilled pages that were never re-dirtied already have their image in the
    // WAL; they still need to end up in the pool as committed-dirty so the
    // data file eventually receives them.
    const spilledOnly = [...this.spilled.keys()].filter((id) => !this.pageTable.get(id)?.txnDirty).sort((a, b) => a - b);
    try {
      for (const f of frames) {
        const lsn = this.wal.endLsn + BigInt(PAGE_IMAGE_RECORD_SIZE);
        f.page.lsn = lsn;
        f.page.stampChecksum();
        const got = this.wal.appendPageImage(f.pageId, f.buf);
        if (got !== lsn) throw new Error(`WAL lsn mismatch ${got} != ${lsn}`);
        this.traceEvent({ op: 'wal', page: f.pageId });
      }
      if (frames.length > 0 || this.spilled.size > 0) {
        this.wal.appendCommit();
        this.traceEvent({ op: 'commit' });
        this.wal.fsync();
        this.traceEvent({ op: 'fsync' });
      }
    } catch (e) {
      // Nothing of this transaction may survive under a later COMMIT record.
      try {
        this.wal.truncateTo(this.txnWalStart);
      } catch {
        // The original error is the one to report; rollback() retries the rewind.
      }
      throw e;
    }
    for (const f of frames) {
      f.txnDirty = false;
      f.dirty = true;
    }
    this.txnDirtySet.clear();
    this._inTxn = false;
    // Committed but only present in the WAL: pull each into the pool as dirty.
    for (const id of spilledOnly) {
      const f = this.acquire(id); // reads the image from the WAL
      f.txnDirty = false;
      this.txnDirtySet.delete(f);
      f.dirty = true;
      this.release(f);
    }
    this.spilled.clear();
    if (this.wal.size() >= this.checkpointBytes) this.checkpoint();
  }

  rollback(): void {
    if (!this._inTxn) throw new Error('no transaction open');
    for (const f of this.txnDirtySet) {
      if (f.pinCount > 0) throw new Error(`rollback with pinned page ${f.pageId}`);
      this.evictFrame(f, false);
    }
    this.txnDirtySet.clear();
    this.spilled.clear();
    this._inTxn = false;
    this.wal.truncateTo(this.txnWalStart);
    this.traceEvent({ op: 'rollback' });
  }

  checkpoint(): void {
    if (this._inTxn) throw new Error('checkpoint inside transaction');
    for (const f of this.frames) if (f.dirty) this.writeBack(f);
    this.data.fsync();
    this.wal.reset();
    this.stats.checkpoints++;
    this.traceEvent({ op: 'checkpoint' });
  }

  // ------------------------------------------------------------ buffer pool

  /** Pin a page. Caller must release(). `fresh` marks a page being allocated past the file end. */
  acquire(pageId: number, fresh = false): Frame {
    if (pageId < 0) throw new RangeError('bad page id');
    let f = this.pageTable.get(pageId);
    const hit = !!f;
    if (f) {
      this.stats.hits++;
    } else {
      this.stats.misses++;
      f = this.victim();
      // Guard the frame with a temporary pin: loading may itself need the
      // pool (meta page lookup) and must not pick this frame as a victim.
      f.pinCount = 1;
      try {
        this.readInto(f, pageId, fresh);
      } catch (e) {
        this.resetFrame(f);
        throw e;
      }
      f.pinCount = 0;
      f.pageId = pageId;
      f.txnDirty = this.spilled.has(pageId);
      if (f.txnDirty) this.txnDirtySet.add(f);
      this.pageTable.set(pageId, f);
    }
    // Inside a transaction a committed-but-unflushed frame is written back
    // before the caller can touch it, so rollback (= drop frame, reread from
    // the data file) restores the committed image. Callers mutate bytes
    // before markDirty (PG order), so this cannot wait until markDirty.
    // Allowed by WAL-before-data: the page's WAL record is already durable.
    // Done before pinning so a write failure cannot leak the pin.
    if (this._inTxn && f.dirty && !f.txnDirty) this.writeBack(f);
    f.pinCount++;
    if (f.usage < MAX_USAGE) f.usage++;
    if (this.traceBuf) this.traceBuf.push({ op: 'read', page: pageId, hit, type: PAGE_TYPE_NAME[f.page.type] ?? 'unknown' });
    return f;
  }

  release(f: Frame): void {
    if (f.pinCount <= 0) throw new Error(`release of unpinned page ${f.pageId}`);
    f.pinCount--;
  }

  /** Run fn with a pinned page, releasing afterward. */
  with<T>(pageId: number, fn: (f: Frame) => T): T {
    const f = this.acquire(pageId);
    try {
      return fn(f);
    } finally {
      this.release(f);
    }
  }

  markDirty(f: Frame): void {
    if (!this._inTxn) throw new Error('write outside transaction');
    if (f.pageId < 0) throw new Error('markDirty on empty frame');
    if (!f.txnDirty) this.traceEvent({ op: 'dirty', page: f.pageId });
    f.txnDirty = true;
    this.txnDirtySet.add(f);
  }

  /** Clock-sweep victim selection (PG freelist.c StrategyGetBuffer), with spill as a last resort. */
  private victim(): Frame {
    const n = this.frames.length;
    for (let tries = 0; tries < n * (MAX_USAGE + 1); tries++) {
      const f = this.frames[this.clockHand]!;
      this.clockHand = (this.clockHand + 1) % n;
      if (f.pinCount > 0 || f.txnDirty) continue;
      if (f.usage > 0) {
        f.usage--;
        continue;
      }
      if (f.pageId >= 0) this.evictFrame(f, true);
      return f;
    }
    // Every unpinned frame is txn-dirty: second sweep, same recency rule, spilling the victim to the WAL.
    for (let tries = 0; tries < n * (MAX_USAGE + 1); tries++) {
      const f = this.frames[this.clockHand]!;
      this.clockHand = (this.clockHand + 1) % n;
      if (f.pinCount > 0) continue;
      if (f.usage > 0) {
        f.usage--;
        continue;
      }
      if (f.txnDirty) this.spill(f);
      else if (f.pageId >= 0) this.evictFrame(f, true);
      return f;
    }
    throw new Error('buffer pool exhausted: all frames pinned');
  }

  private spill(f: Frame): void {
    const lsn = this.wal.endLsn + BigInt(PAGE_IMAGE_RECORD_SIZE);
    f.page.lsn = lsn;
    f.page.stampChecksum();
    this.wal.appendPageImage(f.pageId, f.buf);
    this.spilled.set(f.pageId, lsn);
    this.traceEvent({ op: 'spill', page: f.pageId });
    this.txnDirtySet.delete(f);
    this.pageTable.delete(f.pageId);
    this.resetFrame(f);
    this.stats.spills++;
  }

  private evictFrame(f: Frame, writeIfDirty: boolean): void {
    if (f.dirty && writeIfDirty) this.writeBack(f);
    if (f.pageId >= 0) {
      if (this.pageTable.get(f.pageId) !== f) throw new Error(`page table inconsistency on page ${f.pageId}`);
      this.pageTable.delete(f.pageId);
    }
    this.resetFrame(f);
    this.stats.evictions++;
  }

  private resetFrame(f: Frame): void {
    f.pageId = -1;
    f.pinCount = 0;
    f.dirty = false;
    f.txnDirty = false;
    f.usage = 0;
  }

  private writeBack(f: Frame): void {
    if (f.page.lsn > this.wal.durableLsn) throw new Error(`WAL-before-data violated on page ${f.pageId}`);
    this.data.write(f.pageId * PAGE_SIZE, f.buf);
    f.dirty = false;
    this.stats.flushes++;
    this.traceEvent({ op: 'write', page: f.pageId });
  }

  /** Load page bytes into a free frame. Does not touch frame metadata. */
  private readInto(f: Frame, pageId: number, fresh: boolean): void {
    const spilledLsn = this.spilled.get(pageId);
    if (spilledLsn !== undefined) {
      this.wal.readPageImage(spilledLsn).copy(f.buf);
      return;
    }
    const got = this.data.read(pageId * PAGE_SIZE, PAGE_SIZE);
    if (got.length === PAGE_SIZE && !isZeroPage(got)) {
      got.copy(f.buf);
      if (!f.page.verifyChecksum()) throw new CorruptionError(`checksum failure on page ${pageId}`);
      return;
    }
    // Short read or all zeros: legitimate only for a page that was never
    // written, i.e. one at or beyond the allocated page count.
    if (!fresh && pageId !== 0 && pageId < this.pageCount()) throw new CorruptionError(`page ${pageId} is zero-filled but allocated`);
    f.buf.fill(0);
  }

  private pageCount(): number {
    const cached = this.pageTable.get(0);
    if (cached) return cached.buf.readUInt32LE(M_PAGE_COUNT);
    return this.with(0, (m) => m.buf.readUInt32LE(M_PAGE_COUNT));
  }

  // ------------------------------------------------------------ meta + allocation

  getMeta(): MetaInfo {
    return this.with(0, (f) => ({
      pageCount: f.buf.readUInt32LE(M_PAGE_COUNT),
      freelistHead: f.buf.readUInt32LE(M_FREELIST_HEAD),
      tablesRoot: f.buf.readUInt32LE(M_TABLES_ROOT),
      columnsRoot: f.buf.readUInt32LE(M_COLUMNS_ROOT),
      indexesRoot: f.buf.readUInt32LE(M_INDEXES_ROOT),
      nextObjectId: f.buf.readUInt32LE(M_NEXT_OBJECT_ID),
    }));
  }

  setMeta(patch: Partial<MetaInfo>): void {
    this.with(0, (f) => {
      if (patch.pageCount !== undefined) f.buf.writeUInt32LE(patch.pageCount, M_PAGE_COUNT);
      if (patch.freelistHead !== undefined) f.buf.writeUInt32LE(patch.freelistHead, M_FREELIST_HEAD);
      if (patch.tablesRoot !== undefined) f.buf.writeUInt32LE(patch.tablesRoot, M_TABLES_ROOT);
      if (patch.columnsRoot !== undefined) f.buf.writeUInt32LE(patch.columnsRoot, M_COLUMNS_ROOT);
      if (patch.indexesRoot !== undefined) f.buf.writeUInt32LE(patch.indexesRoot, M_INDEXES_ROOT);
      if (patch.nextObjectId !== undefined) f.buf.writeUInt32LE(patch.nextObjectId, M_NEXT_OBJECT_ID);
      this.markDirty(f);
    });
  }

  nextObjectId(): number {
    const m = this.getMeta();
    this.setMeta({ nextObjectId: m.nextObjectId + 1 });
    return m.nextObjectId;
  }

  /** Allocate a page (freelist first, else extend). Returns a pinned, initialized frame. */
  allocPage(type: PageType, specialSize: number): Frame {
    const meta = this.getMeta();
    let id: number;
    let fresh = false;
    if (meta.freelistHead !== 0) {
      id = meta.freelistHead;
      const next = this.with(id, (f) => f.buf.readUInt32LE(FREE_PAGE_NEXT));
      this.setMeta({ freelistHead: next });
    } else {
      id = meta.pageCount;
      this.setMeta({ pageCount: id + 1 });
      fresh = true;
    }
    const f = this.acquire(id, fresh);
    Page.init(f.buf, type, specialSize);
    this.markDirty(f);
    return f;
  }

  freePage(pageId: number): void {
    if (pageId === 0) throw new Error('cannot free meta page');
    const meta = this.getMeta();
    this.with(pageId, (f) => {
      Page.init(f.buf, PageType.Free, 0);
      f.buf.writeUInt32LE(meta.freelistHead, FREE_PAGE_NEXT);
      this.markDirty(f);
    });
    this.setMeta({ freelistHead: pageId });
  }
}

const PAGE_TYPE_NAME: Record<number, string> = { [PageType.Free]: 'free', [PageType.Meta]: 'meta', [PageType.Heap]: 'heap', [PageType.BTreeMeta]: 'btree-meta', [PageType.BTreeNode]: 'btree' };

function isZeroPage(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i += 8) if (buf.readBigUInt64LE(i) !== 0n) return false;
  return true;
}
