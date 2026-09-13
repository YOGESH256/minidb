/**
 * v2 — the write-ahead log. This is the whole "never lose data" trick.
 *
 * Problem with v1: writePage() overwrites 4 KB in place. If the power dies
 * halfway, the page is half old, half new. Garbage. No way to tell.
 *
 * Fix: never overwrite the real file directly. Instead:
 *
 *   1. append the NEW page contents to a second file, the log
 *   2. append a COMMIT marker
 *   3. fsync the log                      ← the row is now safe, tell the user
 *   4. (later) copy the pages into the real file, then empty the log
 *
 * On startup, read the log. Every record has a checksum. Replay records up
 * to the last COMMIT into the real file; anything after it is a crash tail
 * and gets thrown away.
 *
 *   log file:  [ page 3 image | crc ] [ page 3 image | crc ] [ COMMIT | crc ] [ half-writ...
 *                        replayed              replayed          stop here      ignored
 *
 * Rule that must never be broken: a page reaches the real file only after
 * its log record is fsynced. "Write the log ahead of the data."
 */
import type { FakeDisk } from './fake-disk.js';
import { Page, PageFile, PAGE_SIZE } from './v1-pages.js';
import type { Row } from './v0-array.js';
import type { TID } from './v1-pages.js';

const REC_PAGE = 1;
const REC_COMMIT = 2;

/** Tiny checksum. The real engine uses CRC-32; the idea is identical. */
export function checksum(b: Buffer): number {
  let h = 2166136261;
  for (const x of b) h = Math.imul(h ^ x, 16777619) >>> 0;
  return h;
}

export class Wal {
  constructor(
    private readonly disk: FakeDisk,
    private readonly file: string,
  ) {}

  private append(type: number, pageId: number, payload: Buffer): void {
    // record = type u8 | pageId u32 | len u32 | payload | checksum u32
    const head = Buffer.alloc(9);
    head.writeUInt8(type, 0);
    head.writeUInt32LE(pageId, 1);
    head.writeUInt32LE(payload.length, 5);
    const body = Buffer.concat([head, payload]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32LE(checksum(body), 0);
    this.disk.write(this.file, this.disk.size(this.file), Buffer.concat([body, tail]));
  }
  logPage(pageId: number, p: Page): void {
    this.append(REC_PAGE, pageId, p.buf);
  }
  commit(): void {
    this.append(REC_COMMIT, 0, Buffer.alloc(0));
    this.disk.fsync(this.file); // THE durability point
  }
  reset(): void {
    this.disk.truncate(this.file, 0);
    this.disk.fsync(this.file);
  }

  /** Read back every intact record, stopping at the first broken one. */
  records(): { type: number; pageId: number; payload: Buffer }[] {
    const out = [];
    const all = this.disk.read(this.file);
    let pos = 0;
    while (pos + 13 <= all.length) {
      const len = all.readUInt32LE(pos + 5);
      const end = pos + 9 + len + 4;
      if (end > all.length) break; // short record: crash tail
      const body = all.subarray(pos, pos + 9 + len);
      if (all.readUInt32LE(pos + 9 + len) !== checksum(body)) break; // corrupt: crash tail
      out.push({ type: all.readUInt8(pos), pageId: all.readUInt32LE(pos + 1), payload: Buffer.from(body.subarray(9)) });
      pos = end;
    }
    return out;
  }
}

/** PageFile that goes through the log. Same interface as v1's. */
export class LoggedPageFile extends PageFile {
  readonly wal: Wal;
  private pending = new Map<number, Page>(); // pages changed since the last commit

  constructor(disk: FakeDisk, file: string) {
    super(disk, file);
    this.wal = new Wal(disk, file + '-wal');
    this.recover();
  }

  private recover(): void {
    const recs = this.wal.records();
    const lastCommit = recs.map((r) => r.type).lastIndexOf(REC_COMMIT);
    for (let i = 0; i < lastCommit; i++) {
      const r = recs[i]!;
      if (r.type === REC_PAGE) this.disk.write(this.file, r.pageId * PAGE_SIZE, r.payload); // redo
    }
    if (lastCommit >= 0) this.disk.fsync(this.file);
    this.wal.reset(); // everything after the last COMMIT dies here
  }

  override get pageCount(): number {
    let n = this.disk.size(this.file) / PAGE_SIZE;
    for (const id of this.pending.keys()) n = Math.max(n, id + 1);
    return n;
  }
  override readPage(n: number): Page {
    return this.pending.get(n) ?? super.readPage(n); // see our own uncommitted writes
  }
  /** Changed in memory only. Nothing on disk until commit(). */
  override writePage(n: number, p: Page): void {
    this.pending.set(n, p);
  }
  commit(): void {
    for (const [id, p] of this.pending) this.wal.logPage(id, p); // 1. log
    this.wal.commit(); // 2 + 3. marker, fsync
    for (const [id, p] of this.pending) this.disk.write(this.file, id * PAGE_SIZE, p.buf); // 4. real file
    this.disk.fsync(this.file);
    this.wal.reset();
    this.pending.clear();
  }
  rollback(): void {
    this.pending.clear(); // the disk never saw them
  }
}

/** v1's PagedDb, but every insert is a transaction. */
export class DurableDb {
  readonly pages: LoggedPageFile;
  constructor(disk: FakeDisk, file: string) {
    this.pages = new LoggedPageFile(disk, file);
  }

  /** Same code as v1, but writePage is now "stage", and commit() is separate. */
  insertNoCommit(row: Row): TID {
    const data = Buffer.from(JSON.stringify(row));
    const last = this.pages.pageCount - 1;
    if (last >= 0) {
      const p = this.pages.readPage(last);
      const slot = p.add(data);
      if (slot >= 0) {
        this.pages.writePage(last, p);
        return { page: last, slot };
      }
    }
    const p = Page.empty();
    const slot = p.add(data);
    this.pages.writePage(last + 1, p);
    return { page: last + 1, slot };
  }
  insert(row: Row): TID {
    const tid = this.insertNoCommit(row);
    this.pages.commit();
    return tid;
  }

  *scan(): IterableIterator<{ tid: TID; row: Row }> {
    for (let n = 0; n < this.pages.pageCount; n++) {
      const p = this.pages.readPage(n);
      for (let s = 0; s < p.itemCount; s++) yield { tid: { page: n, slot: s }, row: JSON.parse(p.get(s).toString('utf8')) };
    }
  }
  select(where: (r: Row) => boolean): Row[] {
    const out: Row[] = [];
    for (const { row } of this.scan()) if (where(row)) out.push(row);
    return out;
  }
}
