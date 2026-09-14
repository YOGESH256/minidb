/**
 * Turn a local minidb database into objects: chunk every page, embed the hot
 * pages in a manifest, publish. Used for the first upload of a database and,
 * by the Publisher, for the incremental case (unchanged chunks keep their
 * content hash and are not re-uploaded).
 */
import type { Database } from '../database.js';
import { PAGE_SIZE, Page } from '../storage/page.js';
import { META_ROOT, readNode } from '../storage/btree.js';
import { etagOf, type ObjectStore } from './store.js';
import { CHUNK_PAGES, MANIFEST_FORMAT, keys, encodeManifest, type Manifest } from './manifest.js';


/** Every page id of every index that a lookup touches before reaching a leaf: meta page, root, internal nodes. */
export function hotPages(db: Database): Set<number> {
  const hot = new Set<number>([0]);
  for (const t of db.catalog.allTables()) {
    for (const idx of t.indexes) {
      hot.add(idx.metaPage);
      const root = db.pager.with(idx.metaPage, (f) => f.buf.readUInt32LE(META_ROOT));
      const stack = [root];
      while (stack.length) {
        const id = stack.pop()!;
        const children = db.pager.with(id, (f) => {
          const view = readNode(f.page);
          if (view.level === 0) return null;
          const out: number[] = [];
          for (let i = view.dataStart; i < f.page.itemCount; i++) out.push(f.page.getItem(i)!.readUInt32LE(0));
          return out;
        });
        if (children === null) continue; // a leaf: not hot
        hot.add(id);
        stack.push(...children);
      }
    }
  }
  return hot;
}

export function readPage(db: Database, page: number): Buffer {
  return db.pager.with(page, (f) => Buffer.from(f.buf));
}

export interface SnapshotResult {
  manifest: Manifest;
  etag: string;
  chunksUploaded: number;
  chunksReused: number;
}

/**
 * Publish the database's current state. `base` is the manifest (and its ETag)
 * the caller started from: chunks whose content hash is unchanged are reused,
 * and the manifest PUT is conditional on that ETag so a concurrent publish
 * is detected, not overwritten. Pass `base = null` for a brand-new database.
 */
export async function writeSnapshot(
  db: Database,
  store: ObjectStore,
  prefix: string,
  base: { manifest: Manifest; etag: string } | null,
  generation: number,
): Promise<SnapshotResult> {
  if (db.pager.inTxn) throw new Error('cannot snapshot inside a transaction');
  db.pager.checkpoint(); // everything committed is now in the data pages
  const pageCount = db.pager.getMeta().pageCount;
  const hotSet = hotPages(db);

  const hot: Record<string, string> = {};
  for (const p of hotSet) hot[String(p)] = readPage(db, p).toString('base64');

  const chunks: Record<string, string> = {};
  let uploaded = 0;
  let reused = 0;
  for (let start = 0; start < pageCount; start += CHUNK_PAGES) {
    const n = Math.min(CHUNK_PAGES, pageCount - start);
    const buf = Buffer.alloc(n * PAGE_SIZE);
    for (let i = 0; i < n; i++) readPage(db, start + i).copy(buf, i * PAGE_SIZE);
    const id = etagOf(buf);
    chunks[String(start)] = id;
    if (base?.manifest.chunks[String(start)] === id) {
      reused++;
      continue;
    }
    await store.put(keys.chunk(prefix, id), buf); // content-addressed: idempotent, safe to retry
    uploaded++;
  }

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    version: (base?.manifest.version ?? 0) + 1,
    generation,
    pageCount,
    hot,
    chunks,
    publishedAt: new Date().toISOString(),
  };
  // The commit point. Conditional on the manifest we started from.
  const { etag } = await store.put(keys.manifest(prefix), encodeManifest(manifest), base ? { ifMatch: base.etag } : { ifNoneMatch: true });
  return { manifest, etag, chunksUploaded: uploaded, chunksReused: reused };
}

