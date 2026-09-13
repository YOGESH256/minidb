import fs from 'node:fs';
import path from 'node:path';
import type { FileIO, OpenFile, LockFile, FileSystem } from './file-io.js';

/** Real-disk FileIO on top of Node's positional read/write. */
export class NodeFileIO implements FileIO {
  private fd: number;
  constructor(private readonly filePath: string) {
    // 'r+' requires existence; create with 'a+' first (never 'w+', which truncates).
    if (!fs.existsSync(filePath)) {
      const fd = fs.openSync(filePath, 'a+');
      fs.closeSync(fd);
      fsyncDir(path.dirname(filePath));
    }
    this.fd = fs.openSync(filePath, 'r+');
  }
  read(position: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    let got = 0;
    // Short reads are legal: loop until full or EOF.
    while (got < length) {
      const n = fs.readSync(this.fd, buf, got, length - got, position + got);
      if (n === 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  }
  write(position: number, data: Buffer): void {
    let done = 0;
    // writeSync does not promise a full write; loop on the return value.
    while (done < data.length) {
      const n = fs.writeSync(this.fd, data, done, data.length - done, position + done);
      if (n <= 0) throw new Error(`short write to ${this.filePath}`);
      done += n;
    }
  }
  size(): number {
    return fs.fstatSync(this.fd).size;
  }
  truncate(length: number): void {
    fs.ftruncateSync(this.fd, length);
  }
  fsync(): void {
    // On Darwin libuv issues fcntl(F_FULLFSYNC) here, so this is a real flush.
    fs.fsyncSync(this.fd);
  }
  close(): void {
    fs.closeSync(this.fd);
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some platforms refuse fsync on directories; not fatal.
  }
}

export const openNodeFile: OpenFile = (p) => new NodeFileIO(p);

// ------------------------------------------------------------ exclusive ownership

export class DatabaseLockedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DatabaseLockedError';
  }
}

const openInThisProcess = new Set<string>();

/**
 * One owner per database file. A `<file>.lock` holding our pid is created
 * with O_EXCL. A lock whose pid is no longer alive is stale and taken over.
 * This guards against the lowdb-style "two writers, one file" corruption;
 * it is not multi-process database support.
 */
export const lockNodeFile: LockFile = (filePath) => {
  const abs = path.resolve(filePath);
  if (openInThisProcess.has(abs)) throw new DatabaseLockedError(`database "${filePath}" is already open in this process`);
  const lockPath = abs + '.lock';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 1) throw e;
      const pid = Number(fs.readFileSync(lockPath, 'utf8').split('\n')[0]);
      if (pid && pidAlive(pid)) throw new DatabaseLockedError(`database "${filePath}" is locked by process ${pid}`);
      fs.rmSync(lockPath, { force: true }); // stale: owner is gone
    }
  }
  openInThisProcess.add(abs);
  return () => {
    openInThisProcess.delete(abs);
    fs.rmSync(lockPath, { force: true });
  };
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, not ours
  }
}

export const nodeFileSystem: FileSystem = { open: openNodeFile, lock: lockNodeFile };
