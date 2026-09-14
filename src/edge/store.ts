/**
 * The object store the edge protocol talks to. Modelled on what S3 and R2
 * actually offer: whole-object PUT with conditional headers, GET with byte
 * ranges, ETags. Nothing else. See docs/edge/PROTOCOL.md.
 */
import { createHash } from 'node:crypto';

export interface PutOptions {
  /** Succeed only if the object's current ETag equals this (S3/R2 If-Match). */
  ifMatch?: string;
  /** Succeed only if the object does not exist (If-None-Match: *). */
  ifNoneMatch?: boolean;
}

export interface ObjectStore {
  get(key: string): Promise<{ data: Buffer; etag: string } | null>;
  getRange(key: string, offset: number, length: number): Promise<Buffer | null>;
  head(key: string): Promise<{ etag: string; size: number } | null>;
  put(key: string, data: Buffer, opts?: PutOptions): Promise<{ etag: string }>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** The conditional PUT lost: someone else changed the object first. */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`precondition failed on ${key}`);
    this.name = 'PreconditionFailedError';
  }
}

export function etagOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 32);
}

export interface StoreStats {
  gets: number;
  rangeGets: number;
  heads: number;
  puts: number;
  deletes: number;
  bytesRead: number;
  bytesWritten: number;
}

export type FaultMode = 'throw' | 'apply-then-throw';

/**
 * In-memory store with S3 semantics, request accounting, and fault hooks.
 * 'apply-then-throw' models a lost acknowledgement: the write lands on the
 * server but the client sees a network error.
 */
export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, { data: Buffer; etag: string }>();
  readonly stats: StoreStats = { gets: 0, rangeGets: 0, heads: 0, puts: 0, deletes: 0, bytesRead: 0, bytesWritten: 0 };
  private faults: { op: 'get' | 'put'; keyPrefix: string; mode: FaultMode }[] = [];
  /** Simulated latency per request, for the benchmark. */
  latencyMs = 0;

  failNext(op: 'get' | 'put', keyPrefix: string, mode: FaultMode = 'throw'): void {
    this.faults.push({ op, keyPrefix, mode });
  }
  private takeFault(op: 'get' | 'put', key: string): FaultMode | null {
    const i = this.faults.findIndex((f) => f.op === op && key.startsWith(f.keyPrefix));
    if (i < 0) return null;
    return this.faults.splice(i, 1)[0]!.mode;
  }
  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  async get(key: string) {
    await this.delay();
    this.stats.gets++;
    const fault = this.takeFault('get', key);
    if (fault === 'throw') throw new Error(`injected network error on GET ${key}`);
    const o = this.objects.get(key);
    if (!o) return null;
    this.stats.bytesRead += o.data.length;
    return { data: Buffer.from(o.data), etag: o.etag };
  }
  async getRange(key: string, offset: number, length: number) {
    await this.delay();
    this.stats.rangeGets++;
    const o = this.objects.get(key);
    if (!o) return null;
    const slice = Buffer.from(o.data.subarray(offset, offset + length));
    this.stats.bytesRead += slice.length;
    return slice;
  }
  async head(key: string) {
    await this.delay();
    this.stats.heads++;
    const o = this.objects.get(key);
    return o ? { etag: o.etag, size: o.data.length } : null;
  }
  async put(key: string, data: Buffer, opts: PutOptions = {}) {
    await this.delay();
    this.stats.puts++;
    const fault = this.takeFault('put', key);
    if (fault === 'throw') throw new Error(`injected network error on PUT ${key}`);
    const cur = this.objects.get(key);
    if (opts.ifNoneMatch && cur) throw new PreconditionFailedError(key);
    if (opts.ifMatch !== undefined && (!cur || cur.etag !== opts.ifMatch)) throw new PreconditionFailedError(key);
    const etag = etagOf(data);
    this.objects.set(key, { data: Buffer.from(data), etag });
    this.stats.bytesWritten += data.length;
    if (fault === 'apply-then-throw') throw new Error(`injected lost acknowledgement on PUT ${key}`);
    return { etag };
  }
  async delete(key: string) {
    await this.delay();
    this.stats.deletes++;
    this.objects.delete(key);
  }
  async list(prefix: string) {
    await this.delay();
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** Test helper: raw view. */
  has(key: string): boolean {
    return this.objects.has(key);
  }
  resetStats(): void {
    for (const k of Object.keys(this.stats)) (this.stats as unknown as Record<string, number>)[k] = 0;
  }
}
