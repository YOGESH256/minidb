/**
 * Minimal positional file interface. Both the data file and the WAL use it,
 * so tests can swap in a fault-injecting implementation and ':memory:'
 * databases can run without touching the disk.
 *
 * This module has no Node imports on purpose. The real-disk implementation
 * lives in node-file-io.ts and registers itself via setDefaultFileSystem(),
 * which src/index.ts calls for Node users.
 */
export interface FileIO {
  read(position: number, length: number): Buffer;
  write(position: number, data: Buffer): void;
  size(): number;
  truncate(length: number): void;
  fsync(): void;
  close(): void;
}

export type OpenFile = (filePath: string) => FileIO;

/** Exclusive-ownership lock for a database path. Returns a release function. */
export type LockFile = (filePath: string) => () => void;

export interface FileSystem {
  open: OpenFile;
  lock: LockFile;
}

// ------------------------------------------------------------ in-memory files

/** One in-memory "disk": a map of path → bytes. Each Database(':memory:') gets its own. */
export class MemoryFiles {
  private files = new Map<string, { buf: Buffer; len: number }>();
  readonly open: OpenFile = (path) => new MemoryFileIO(this, path);

  _get(path: string) {
    let f = this.files.get(path);
    if (!f) {
      f = { buf: Buffer.alloc(64 * 1024), len: 0 };
      this.files.set(path, f);
    }
    return f;
  }
  _ensure(path: string, len: number) {
    const f = this._get(path);
    if (len > f.buf.length) {
      const grown = Buffer.alloc(Math.max(len, f.buf.length * 2));
      f.buf.copy(grown, 0, 0, f.len);
      f.buf = grown;
    }
    if (len > f.len) f.len = len;
  }
}

export class MemoryFileIO implements FileIO {
  constructor(
    private readonly fs: MemoryFiles,
    private readonly path: string,
  ) {}
  read(position: number, length: number): Buffer {
    const f = this.fs._get(this.path);
    return Buffer.from(f.buf.subarray(position, Math.min(f.len, position + length)));
  }
  write(position: number, data: Buffer): void {
    this.fs._ensure(this.path, position + data.length);
    data.copy(this.fs._get(this.path).buf, position);
  }
  size(): number {
    return this.fs._get(this.path).len;
  }
  truncate(length: number): void {
    const f = this.fs._get(this.path);
    this.fs._ensure(this.path, length);
    if (length < f.len) f.buf.fill(0, length, f.len);
    f.len = length;
  }
  fsync(): void {}
  close(): void {}
}

export const memoryFileSystem = (): FileSystem => ({ open: new MemoryFiles().open, lock: () => () => {} });

// ------------------------------------------------------------ default registry

let defaultFs: FileSystem | null = null;

/** Called once by the Node entry point (src/index.ts) to install real-disk I/O. */
export function setDefaultFileSystem(fs: FileSystem): void {
  defaultFs = fs;
}

export function getDefaultFileSystem(): FileSystem {
  if (!defaultFs) throw new Error('no default file system: import from "src/index.js" for Node, or pass openFile / use ":memory:"');
  return defaultFs;
}
