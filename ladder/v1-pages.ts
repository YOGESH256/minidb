/**
 * v1 — pages.
 *
 * Instead of one JSON blob, the file is cut into 4 KB blocks called pages.
 * A row lives on exactly one page, so inserting a row rewrites one page,
 * not the whole file. A row's address is (page number, slot number).
 *
 *   ┌──────────────────────────────── one 4 KB page ─────────────────────────┐
 *   │ header: itemCount, lower, upper                                        │
 *   │ slots: [offset,len] [offset,len] [offset,len]  ──► grow downward       │
 *   │                                                                        │
 *   │                       free space                                       │
 *   │                                                                        │
 *   │              ◄── row 2 bytes ── row 1 bytes ── row 0 bytes  (grow up)  │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * Rows are still JSON strings; that is fine for now (the real engine packs
 * bytes by type in src/types.ts). Still no crash safety: v2 adds that.
 */
import type { FakeDisk } from './fake-disk.js';
import type { Row } from './v0-array.js';

export const PAGE_SIZE = 4096;
const HEADER = 6; // itemCount u16, lower u16, upper u16
const SLOT = 4; // offset u16, len u16

export interface TID {
  page: number;
  slot: number;
}

/** Slotted page: a view over 4096 bytes. */
export class Page {
  constructor(readonly buf: Buffer) {}

  static empty(): Page {
    const p = new Page(Buffer.alloc(PAGE_SIZE));
    p.buf.writeUInt16LE(0, 0); // itemCount
    p.buf.writeUInt16LE(HEADER, 2); // lower: end of the slot array
    p.buf.writeUInt16LE(PAGE_SIZE, 4); // upper: start of the row bytes
    return p;
  }
  get itemCount(): number {
    return this.buf.readUInt16LE(0);
  }
  get freeSpace(): number {
    return this.buf.readUInt16LE(4) - this.buf.readUInt16LE(2);
  }

  /** Put bytes on the page. Returns the slot number, or -1 if it does not fit. */
  add(data: Buffer): number {
    if (this.freeSpace < data.length + SLOT) return -1;
    const upper = this.buf.readUInt16LE(4) - data.length;
    data.copy(this.buf, upper);
    const slot = this.itemCount;
    this.buf.writeUInt16LE(upper, HEADER + slot * SLOT);
    this.buf.writeUInt16LE(data.length, HEADER + slot * SLOT + 2);
    this.buf.writeUInt16LE(slot + 1, 0);
    this.buf.writeUInt16LE(HEADER + (slot + 1) * SLOT, 2);
    this.buf.writeUInt16LE(upper, 4);
    return slot;
  }

  get(slot: number): Buffer {
    const off = this.buf.readUInt16LE(HEADER + slot * SLOT);
    const len = this.buf.readUInt16LE(HEADER + slot * SLOT + 2);
    return this.buf.subarray(off, off + len);
  }
}

/** A file made of pages. Knows nothing about rows. */
export class PageFile {
  constructor(
    protected readonly disk: FakeDisk,
    protected readonly file: string,
  ) {}
  get pageCount(): number {
    return this.disk.size(this.file) / PAGE_SIZE;
  }
  readPage(n: number): Page {
    return new Page(this.disk.read(this.file, n * PAGE_SIZE, PAGE_SIZE));
  }
  writePage(n: number, p: Page): void {
    this.disk.write(this.file, n * PAGE_SIZE, p.buf); // only 4 KB touched
    this.disk.fsync(this.file);
  }
}

/** A table = every page in the file, rows as JSON strings. */
export class PagedDb {
  protected pages: PageFile;
  constructor(disk: FakeDisk, file: string) {
    this.pages = new PageFile(disk, file);
  }

  insert(row: Row): TID {
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

  get(tid: TID): Row {
    return JSON.parse(this.pages.readPage(tid.page).get(tid.slot).toString('utf8'));
  }

  /** Still a full scan: every page, every slot. v3 fixes this. */
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
