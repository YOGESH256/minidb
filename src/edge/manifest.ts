/**
 * The manifest: the one mutable object. Names the immutable chunk objects
 * that make up the current database and embeds the pages every query needs
 * first (page 0 and the index metas/roots/internal nodes).
 */
import { PAGE_SIZE } from '../storage/page.js';

export const MANIFEST_FORMAT = 1;
/** Pages per chunk object. 16 × 4 KB = 64 KB per range GET. */
export const CHUNK_PAGES = 16;
export const CHUNK_BYTES = CHUNK_PAGES * PAGE_SIZE;

export interface Manifest {
  format: number;
  /** Increases by exactly one per publish. */
  version: number;
  /** Lease generation of the writer that published this version. */
  generation: number;
  pageCount: number;
  /** Base64 of pages served from the manifest itself: page 0 + index hot set. */
  hot: Record<string, string>;
  /** First page id of each chunk → chunk object id (content hash). */
  chunks: Record<string, string>;
  publishedAt: string;
}

export const keys = {
  manifest: (prefix: string) => `${prefix}/manifest`,
  lease: (prefix: string) => `${prefix}/lease`,
  chunk: (prefix: string, id: string) => `${prefix}/chunks/${id}.pages`,
  chunkPrefix: (prefix: string) => `${prefix}/chunks/`,
};

export function encodeManifest(m: Manifest): Buffer {
  return Buffer.from(JSON.stringify(m));
}

export function decodeManifest(b: Buffer): Manifest {
  const m = JSON.parse(b.toString('utf8')) as Manifest;
  if (m.format !== MANIFEST_FORMAT) throw new Error(`unsupported manifest format ${m.format}`);
  return m;
}

export function chunkStart(page: number): number {
  return Math.floor(page / CHUNK_PAGES) * CHUNK_PAGES;
}

export interface Lease {
  owner: string;
  generation: number;
  /** ISO timestamp after which the lease may be taken over. */
  expires: string;
}
