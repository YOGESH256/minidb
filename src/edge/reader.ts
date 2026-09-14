/**
 * Async read-only path over a published snapshot. No executor, no SQL:
 * open the manifest once (that is the snapshot), then answer point lookups
 * and scans by fetching only the chunks touched. Reuses the on-disk page,
 * B-tree node and tuple decoders unchanged.
 */
import { Page, PAGE_SIZE } from '../storage/page.js';
import { ITEM_HEADER, META_ROOT, readNode, decodeItem, TID_MIN } from '../storage/btree.js';
import type { TID } from '../storage/heap.js';
import { SYS_TABLES_COLS, SYS_COLUMNS_COLS, SYS_INDEXES_COLS, type TableDef, type ColumnDef } from '../catalog.js';
import { decodeTuple, encodeValue, compareEncoded, type DataType, type Value } from '../types.js';
import type { ObjectStore } from './store.js';
import { CHUNK_PAGES, keys, decodeManifest, chunkStart, type Manifest } from './manifest.js';

const HEAP_NEXT = 0; // heap special: next u32 | last u32

export interface ReaderStats {
  manifestGets: number;
  chunkGets: number;
  bytes: number;
  pagesServedFromManifest: number;
  pagesServedFromCache: number;
}

export class RemoteSnapshot {
  readonly stats: ReaderStats = { manifestGets: 0, chunkGets: 0, bytes: 0, pagesServedFromManifest: 0, pagesServedFromCache: 0 };
  private chunkCache = new Map<number, Buffer>();
  private tables = new Map<string, TableDef>();

  private constructor(
    private readonly store: ObjectStore,
    private readonly prefix: string,
    readonly manifest: Manifest,
    readonly etag: string,
    private readonly maxCachedChunks: number,
  ) {}

  /** One GET. Everything after this reads from the pinned snapshot. */
  static async open(store: ObjectStore, prefix: string, opts: { maxCachedChunks?: number } = {}): Promise<RemoteSnapshot> {
    const got = await store.get(keys.manifest(prefix));
    if (!got) throw new Error(`no database at ${prefix}`);
    const snap = new RemoteSnapshot(store, prefix, decodeManifest(got.data), got.etag, opts.maxCachedChunks ?? 64);
    snap.stats.manifestGets = 1;
    snap.stats.bytes += got.data.length;
    await snap.loadCatalog();
    return snap;
  }

  // ------------------------------------------------------------ pages

  async page(id: number): Promise<Page> {
    if (id < 0 || id >= this.manifest.pageCount) throw new RangeError(`page ${id} beyond snapshot (${this.manifest.pageCount} pages)`);
    const hot = this.manifest.hot[String(id)];
    if (hot !== undefined) {
      this.stats.pagesServedFromManifest++;
      return this.verified(id, Buffer.from(hot, 'base64'));
    }
    const start = chunkStart(id);
    let chunk = this.chunkCache.get(start);
    if (!chunk) {
      const chunkId = this.manifest.chunks[String(start)];
      if (!chunkId) throw new Error(`manifest has no chunk for page ${id}`);
      const n = Math.min(CHUNK_PAGES, this.manifest.pageCount - start);
      const got = await this.store.getRange(keys.chunk(this.prefix, chunkId), 0, n * PAGE_SIZE);
      if (!got) throw new Error(`chunk ${chunkId} missing (garbage-collected under a stale snapshot?)`);
      this.stats.chunkGets++;
      this.stats.bytes += got.length;
      chunk = got;
      if (this.chunkCache.size >= this.maxCachedChunks) this.chunkCache.delete(this.chunkCache.keys().next().value!);
      this.chunkCache.set(start, chunk);
    } else {
      this.stats.pagesServedFromCache++;
    }
    const off = (id - start) * PAGE_SIZE;
    return this.verified(id, Buffer.from(chunk.subarray(off, off + PAGE_SIZE)));
  }

  /**
   * Fetch the chunks for a set of pages concurrently (bounded), so a lookup
   * that lands on many heap pages costs one round trip, not one per page.
   */
  async prefetch(pages: Iterable<number>, concurrency = 16): Promise<void> {
    const starts = [...new Set([...pages].filter((p) => this.manifest.hot[String(p)] === undefined).map(chunkStart))].filter((s) => !this.chunkCache.has(s));
    for (let i = 0; i < starts.length; i += concurrency) {
      await Promise.all(starts.slice(i, i + concurrency).map((s) => this.page(s)));
    }
  }

  /** Forget fetched chunks (memory control; the pinned manifest is kept). */
  dropCache(): void {
    this.chunkCache.clear();
  }

  private verified(id: number, buf: Buffer): Page {
    const p = new Page(buf);
    if (!p.verifyChecksum()) throw new Error(`checksum failure on page ${id}`);
    return p;
  }

  // ------------------------------------------------------------ catalog

  private async loadCatalog(): Promise<void> {
    const meta = await this.page(0);
    const tablesRoot = meta.buf.readUInt32LE(40);
    const columnsRoot = meta.buf.readUInt32LE(44);
    const indexesRoot = meta.buf.readUInt32LE(48);
    const byId = new Map<number, TableDef>();
    const types = (cols: ColumnDef[]) => cols.map((c) => c.type);
    for await (const r of this.heapScan(tablesRoot)) {
      const [id, name, root] = decodeTuple(types(SYS_TABLES_COLS), r.data) as [number, string, number];
      const t: TableDef = { id, name, rootPage: root, columns: [], indexes: [], system: false };
      byId.set(id, t);
      this.tables.set(name, t);
    }
    const cols: { tid: number; ord: number; def: ColumnDef }[] = [];
    for await (const r of this.heapScan(columnsRoot)) {
      const [tid, ord, name, type, notNull, pk] = decodeTuple(types(SYS_COLUMNS_COLS), r.data) as [number, number, string, DataType, boolean, boolean];
      cols.push({ tid, ord, def: { name, type, notNull, pk } });
    }
    cols.sort((a, b) => a.tid - b.tid || a.ord - b.ord);
    for (const c of cols) byId.get(c.tid)?.columns.push(c.def);
    for await (const r of this.heapScan(indexesRoot)) {
      const [id, name, tableId, column, metaPage, unique] = decodeTuple(types(SYS_INDEXES_COLS), r.data) as [number, string, number, string, number, boolean];
      const t = byId.get(tableId);
      if (!t) continue;
      t.indexes.push({ id, name, tableId, column, columnIndex: t.columns.findIndex((c) => c.name === column), metaPage, unique });
    }
  }

  table(name: string): TableDef {
    const t = this.tables.get(name);
    if (!t) throw new Error(`relation "${name}" does not exist`);
    return t;
  }
  tableNames(): string[] {
    return [...this.tables.keys()];
  }

  // ------------------------------------------------------------ heap

  private async *heapScan(root: number): AsyncGenerator<{ tid: TID; data: Buffer }> {
    let id = root;
    while (id !== 0) {
      const p = await this.page(id);
      for (const it of p.items()) yield { tid: { page: id, slot: it.slot }, data: Buffer.from(it.data) };
      id = p.special.readUInt32LE(HEAP_NEXT);
    }
  }

  /** Walk the chain once to learn its pages, fetch their chunks concurrently, then stream rows from cache. */
  private async *heapScanParallel(root: number): AsyncGenerator<{ tid: TID; data: Buffer }> {
    // Chain links live in page headers, so discovering the chain needs the pages themselves;
    // chunks are 16 consecutive pages, and a table's pages are mostly consecutive, so
    // prefetching the next few chunks ahead of the walk removes nearly all sequential waits.
    let id = root;
    let ahead = 0;
    while (id !== 0) {
      if (id >= ahead) {
        const start = chunkStart(id);
        await this.prefetch(Array.from({ length: CHUNK_PAGES * 8 }, (_, i) => start + i).filter((p) => p < this.manifest.pageCount));
        ahead = start + CHUNK_PAGES * 8;
      }
      const p = await this.page(id);
      for (const it of p.items()) yield { tid: { page: id, slot: it.slot }, data: Buffer.from(it.data) };
      id = p.special.readUInt32LE(HEAP_NEXT);
    }
  }

  async row(t: TableDef, tid: TID): Promise<Value[] | null> {
    const p = await this.page(tid.page);
    const d = p.getItem(tid.slot);
    return d ? decodeTuple(t.columns.map((c) => c.type), d) : null;
  }

  /** Every row of a table, in storage order. */
  async *scan(table: string): AsyncGenerator<Value[]> {
    const t = this.table(table);
    const types = t.columns.map((c) => c.type);
    for await (const r of this.heapScanParallel(t.rootPage)) yield decodeTuple(types, r.data);
  }

  // ------------------------------------------------------------ index lookup

  /** Rows whose indexed column equals `key`. Uses the primary key index by default. */
  async lookup(table: string, key: Value, indexName?: string): Promise<Value[][]> {
    const t = this.table(table);
    const idx = indexName ? t.indexes.find((i) => i.name === indexName) : t.indexes.find((i) => i.name === `${table}_pkey`) ?? t.indexes[0];
    if (!idx) throw new Error(`no index on ${table}`);
    const type = t.columns[idx.columnIndex]!.type;
    const cmp = (a: Buffer, b: Buffer) => compareEncoded(type, a, b);
    const k = encodeValue(type, key);
    const cmpItem = (item: Buffer): number => {
      const c = cmp(item.subarray(ITEM_HEADER), k);
      if (c !== 0) return c;
      const tp = item.readUInt32LE(4);
      const ts = item.readUInt16LE(8);
      return tp - TID_MIN.page || ts - TID_MIN.slot;
    };
    // descend
    let id = (await this.page(idx.metaPage)).buf.readUInt32LE(META_ROOT);
    for (;;) {
      const p = await this.page(id);
      const view = readNode(p);
      // first data slot with item >= (key, TID_MIN)
      let lo = view.dataStart;
      let hi = p.itemCount;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cmpItem(p.getItem(mid)!) < 0) lo = mid + 1;
        else hi = mid;
      }
      if (view.level > 0) {
        const slot = lo < p.itemCount && cmpItem(p.getItem(lo)!) === 0 ? lo : Math.max(view.dataStart, lo - 1);
        id = p.getItem(slot)!.readUInt32LE(0);
        continue;
      }
      // leaf: collect the matching row addresses (following the right link), then fetch their chunks together
      const tids: TID[] = [];
      let page = p;
      let s = lo;
      collect: for (;;) {
        for (; s < page.itemCount; s++) {
          const it = decodeItem(page.getItem(s)!);
          if (cmp(it.key, k) !== 0) break collect;
          tids.push(it.tid);
        }
        const next = readNode(page).next;
        if (next === 0) break;
        page = await this.page(next);
        s = readNode(page).dataStart;
      }
      // Fetch in windows that fit the chunk cache, so prefetching never evicts what it just fetched.
      tids.sort((a, b) => a.page - b.page || a.slot - b.slot);
      const out: Value[][] = [];
      let i = 0;
      while (i < tids.length) {
        const window: TID[] = [];
        const starts = new Set<number>();
        while (i < tids.length) {
          const st = chunkStart(tids[i]!.page);
          if (!starts.has(st) && starts.size >= this.maxCachedChunks) break;
          starts.add(st);
          window.push(tids[i++]!);
        }
        await this.prefetch(window.map((x) => x.page));
        for (const tid of window) {
          const r = await this.row(t, tid);
          if (r) out.push(r);
        }
      }
      return out;
    }
  }
}
