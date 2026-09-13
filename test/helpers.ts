import type { FileIO, OpenFile, FileSystem } from '../src/storage/file-io.js';

/**
 * In-memory fault-injecting file system (RocksDB FaultInjectionTestFS shape).
 * Writes land in a per-file "OS cache" and only become durable on fsync.
 * crash() throws away everything not fsynced; 'torn' mode keeps a random
 * prefix of each unsynced write to simulate a torn sector.
 */
export class FaultFS {
  private durable = new Map<string, Buffer>();
  private pending = new Map<string, { pos: number; data: Buffer }[]>();
  private cache = new Map<string, Buffer>(); // durable + pending applied (may have spare capacity)
  private lengths = new Map<string, number>(); // logical length of each cached file
  private rng = mulberry32(42);
  fsyncCount = 0;
  private faults: { op: 'read' | 'write' | 'fsync'; path: string; remaining: number; err: string }[] = [];

  /** Make the nth matching call (1-based) on a file whose path contains `path` throw. */
  failNext(op: 'read' | 'write' | 'fsync', path: string, nth = 1, err = 'EIO'): void {
    this.faults.push({ op, path, remaining: nth, err });
  }
  _maybeFail(op: 'read' | 'write' | 'fsync', path: string): void {
    for (let i = 0; i < this.faults.length; i++) {
      const f = this.faults[i]!;
      if (f.op !== op || !path.includes(f.path)) continue;
      if (--f.remaining > 0) return;
      this.faults.splice(i, 1);
      const e = new Error(`${f.err}: injected ${op} failure on ${path}`) as Error & { code: string };
      e.code = f.err;
      throw e;
    }
  }
  /** Overwrite bytes in the durable copy (simulates on-disk corruption after a crash). */
  corruptDurable(path: string, pos: number, data: Buffer): void {
    const cur = Buffer.from(this.durable.get(path) ?? Buffer.alloc(0));
    data.copy(cur, pos);
    this.durable.set(path, cur);
    this.cache.delete(path);
    this.lengths.delete(path);
    this.pending.delete(path);
  }

  readonly open: OpenFile = (path) => new FaultFile(this, path);
  /** As a FileSystem for Database({ fs }). No locking: tests open the same fake path many times. */
  readonly fs: FileSystem = { open: this.open, lock: () => () => {} };

  seed(n: number): void {
    this.rng = mulberry32(n);
  }

  // called by FaultFile
  /** Logical file contents (a view; do not retain across writes). */
  _get(path: string): Buffer {
    if (!this.cache.has(path)) {
      const d = this.durable.get(path) ?? Buffer.alloc(0);
      const cap = Math.max(64 * 1024, d.length * 2);
      const buf = Buffer.alloc(cap);
      d.copy(buf);
      this.cache.set(path, buf);
      this.lengths.set(path, d.length);
      this.pending.set(path, []);
    }
    return this.cache.get(path)!.subarray(0, this.lengths.get(path)!);
  }
  private ensure(path: string, len: number): void {
    this._get(path);
    let buf = this.cache.get(path)!;
    if (len > buf.length) {
      const grown = Buffer.alloc(Math.max(len, buf.length * 2));
      buf.copy(grown, 0, 0, this.lengths.get(path)!);
      buf = grown;
      this.cache.set(path, buf);
    }
    if (len > this.lengths.get(path)!) this.lengths.set(path, len);
  }
  _write(path: string, pos: number, data: Buffer): void {
    this.ensure(path, pos + data.length);
    data.copy(this.cache.get(path)!, pos);
    this.pending.get(path)!.push({ pos, data: Buffer.from(data) });
  }
  _truncate(path: string, len: number): void {
    this.ensure(path, len);
    const buf = this.cache.get(path)!;
    if (len < this.lengths.get(path)!) buf.fill(0, len, this.lengths.get(path)!);
    this.lengths.set(path, len);
    this.pending.get(path)!.push({ pos: -1, data: Buffer.alloc(len) }); // marker: truncate to len
  }
  _fsync(path: string): void {
    this.fsyncCount++;
    this.durable.set(path, Buffer.from(this._get(path)));
    this.pending.set(path, []);
  }

  /** Simulate power loss. */
  crash(mode: 'drop' | 'torn' = 'drop'): void {
    for (const [path, ops] of this.pending) {
      let buf = Buffer.from(this.durable.get(path) ?? Buffer.alloc(0));
      if (mode === 'torn') {
        // Apply a random prefix of the unsynced ops, and tear the last one.
        const keep = Math.floor(this.rng() * (ops.length + 1));
        for (let i = 0; i < keep; i++) {
          const op = ops[i]!;
          const partial = i === keep - 1 ? Math.floor(this.rng() * op.data.length) : op.data.length;
          if (op.pos === -1) {
            const len = op.data.length;
            buf = len < buf.length ? Buffer.from(buf.subarray(0, len)) : Buffer.concat([buf, Buffer.alloc(len - buf.length)]);
            continue;
          }
          const end = op.pos + partial;
          if (end > buf.length) buf = Buffer.concat([buf, Buffer.alloc(end - buf.length)]);
          op.data.copy(buf, op.pos, 0, partial);
        }
      }
      this.durable.set(path, buf);
    }
    this.cache.clear();
    this.lengths.clear();
    this.pending.clear();
  }

  durableSize(path: string): number {
    return (this.durable.get(path) ?? Buffer.alloc(0)).length;
  }
}

class FaultFile implements FileIO {
  constructor(
    private readonly fs: FaultFS,
    private readonly path: string,
  ) {
    fs._get(path);
  }
  read(position: number, length: number): Buffer {
    this.fs._maybeFail('read', this.path);
    const buf = this.fs._get(this.path);
    return Buffer.from(buf.subarray(position, Math.min(buf.length, position + length)));
  }
  write(position: number, data: Buffer): void {
    this.fs._maybeFail('write', this.path);
    this.fs._write(this.path, position, data);
  }
  size(): number {
    return this.fs._get(this.path).length;
  }
  truncate(length: number): void {
    this.fs._truncate(this.path, length);
  }
  fsync(): void {
    this.fs._maybeFail('fsync', this.path);
    this.fs._fsync(this.path);
  }
  close(): void {}
}

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
