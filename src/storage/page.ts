/**
 * Slotted page, PostgreSQL "Database Page Layout" shape.
 *
 *   +----------------------+ 0
 *   | PageHeader (24 B)    |
 *   +----------------------+ 24
 *   | line pointers (4 B)  |  grow forward, pd_lower points past the last one
 *   +----------------------+ pd_lower
 *   | free space           |
 *   +----------------------+ pd_upper
 *   | items                |  allocated backward from pd_upper
 *   +----------------------+ pd_special
 *   | special space        |  per access method (heap: next/last, btree: siblings)
 *   +----------------------+ PAGE_SIZE
 *
 * Line pointer = u32: lp_off:15 | lp_flags:2 | lp_len:15
 * Slot numbers are 0-based here (PG uses 1-based OffsetNumber).
 */

export const PAGE_SIZE = 4096;
export const PAGE_HEADER_SIZE = 24;
export const LINE_POINTER_SIZE = 4;
export const PAGE_VERSION = 1;

// Header offsets
const OFF_LSN = 0; // u64
const OFF_CHECKSUM = 8; // u16 (low 16 bits of crc32 of the page with this field zeroed)
const OFF_FLAGS = 10; // u16
const OFF_LOWER = 12; // u16
const OFF_UPPER = 14; // u16
const OFF_SPECIAL = 16; // u16
const OFF_PAGESIZE_VERSION = 18; // u16
const OFF_PAGE_TYPE = 20; // u8
// 21..23 reserved

export const enum PageType {
  Free = 0,
  Meta = 1,
  Heap = 2,
  BTreeMeta = 3,
  BTreeNode = 4,
}

export const enum LpFlags {
  Unused = 0,
  Normal = 1,
  Redirect = 2,
  Dead = 3,
}

export class PageFullError extends Error {
  constructor(need: number, have: number) {
    super(`page full: need ${need} bytes, have ${have}`);
    this.name = 'PageFullError';
  }
}

/** Thin view over a 4 KB Buffer. Stateless: all state lives in the bytes. */
export class Page {
  constructor(public readonly buf: Buffer) {
    if (buf.length !== PAGE_SIZE) throw new Error(`Page buffer must be ${PAGE_SIZE} bytes`);
  }

  static init(buf: Buffer, type: PageType, specialSize: number): Page {
    buf.fill(0);
    const p = new Page(buf);
    p.buf.writeUInt16LE(PAGE_HEADER_SIZE, OFF_LOWER);
    p.buf.writeUInt16LE(PAGE_SIZE - specialSize, OFF_UPPER);
    p.buf.writeUInt16LE(PAGE_SIZE - specialSize, OFF_SPECIAL);
    p.buf.writeUInt16LE((PAGE_SIZE & 0xff00) | PAGE_VERSION, OFF_PAGESIZE_VERSION);
    p.buf.writeUInt8(type, OFF_PAGE_TYPE);
    return p;
  }

  // ---- header accessors ----
  get lsn(): bigint {
    return this.buf.readBigUInt64LE(OFF_LSN);
  }
  set lsn(v: bigint) {
    this.buf.writeBigUInt64LE(v, OFF_LSN);
  }
  get type(): PageType {
    return this.buf.readUInt8(OFF_PAGE_TYPE) as PageType;
  }
  get flags(): number {
    return this.buf.readUInt16LE(OFF_FLAGS);
  }
  set flags(v: number) {
    this.buf.writeUInt16LE(v, OFF_FLAGS);
  }
  get lower(): number {
    return this.buf.readUInt16LE(OFF_LOWER);
  }
  private set lower(v: number) {
    this.buf.writeUInt16LE(v, OFF_LOWER);
  }
  get upper(): number {
    return this.buf.readUInt16LE(OFF_UPPER);
  }
  private set upper(v: number) {
    this.buf.writeUInt16LE(v, OFF_UPPER);
  }
  get specialOffset(): number {
    return this.buf.readUInt16LE(OFF_SPECIAL);
  }
  /** Special space as a mutable view. */
  get special(): Buffer {
    return this.buf.subarray(this.specialOffset, PAGE_SIZE);
  }

  get itemCount(): number {
    return (this.lower - PAGE_HEADER_SIZE) / LINE_POINTER_SIZE;
  }
  get freeSpace(): number {
    return this.upper - this.lower;
  }
  /** Bytes available for one new item including its line pointer. */
  get freeSpaceForItem(): number {
    return Math.max(0, this.freeSpace - LINE_POINTER_SIZE);
  }
  /** Free space after a compact(): counts bytes held by deleted items too. */
  get freeSpaceAfterCompact(): number {
    let live = 0;
    for (const it of this.items()) live += it.data.length;
    return this.specialOffset - this.lower - live;
  }

  // ---- checksum (PG pd_checksum: computed with the field zeroed) ----
  computeChecksum(): number {
    const saved = this.buf.readUInt16LE(OFF_CHECKSUM);
    this.buf.writeUInt16LE(0, OFF_CHECKSUM);
    const c = crc32(this.buf) & 0xffff;
    this.buf.writeUInt16LE(saved, OFF_CHECKSUM);
    return c;
  }
  stampChecksum(): void {
    const c = this.computeChecksum();
    this.buf.writeUInt16LE(c, OFF_CHECKSUM);
  }
  verifyChecksum(): boolean {
    return this.buf.readUInt16LE(OFF_CHECKSUM) === this.computeChecksum();
  }

  // ---- line pointers ----
  private lpOffset(slot: number): number {
    return PAGE_HEADER_SIZE + slot * LINE_POINTER_SIZE;
  }
  private readLp(slot: number): { off: number; flags: LpFlags; len: number } {
    const v = this.buf.readUInt32LE(this.lpOffset(slot));
    return { off: v & 0x7fff, flags: ((v >>> 15) & 0x3) as LpFlags, len: (v >>> 17) & 0x7fff };
  }
  private writeLp(slot: number, off: number, flags: LpFlags, len: number): void {
    this.buf.writeUInt32LE((off & 0x7fff) | ((flags & 0x3) << 15) | ((len & 0x7fff) << 17), this.lpOffset(slot));
  }

  slotFlags(slot: number): LpFlags {
    if (slot < 0 || slot >= this.itemCount) throw new RangeError(`slot ${slot} out of range`);
    return this.readLp(slot).flags;
  }

  /** Item bytes for a Normal slot, else null. Returned view aliases the page. */
  getItem(slot: number): Buffer | null {
    if (slot < 0 || slot >= this.itemCount) return null;
    const lp = this.readLp(slot);
    if (lp.flags !== LpFlags.Normal) return null;
    return this.buf.subarray(lp.off, lp.off + lp.len);
  }

  /**
   * Append an item. Reuses an Unused line pointer if one exists (heap style,
   * keeps slot numbers stable), else adds a new one. Returns the slot.
   */
  addItem(data: Buffer): number {
    // Prefer reusing a dead line pointer so slot numbers stay dense.
    const n = this.itemCount;
    let slot = -1;
    for (let i = 0; i < n; i++) {
      if (this.readLp(i).flags === LpFlags.Unused) {
        slot = i;
        break;
      }
    }
    const needLp = slot === -1 ? LINE_POINTER_SIZE : 0;
    if (this.freeSpace < data.length + needLp) {
      this.compact();
      if (this.freeSpace < data.length + needLp) throw new PageFullError(data.length + needLp, this.freeSpace);
    }
    const off = this.upper - data.length;
    data.copy(this.buf, off);
    this.upper = off;
    if (slot === -1) {
      slot = n;
      this.lower = this.lower + LINE_POINTER_SIZE;
    }
    this.writeLp(slot, off, LpFlags.Normal, data.length);
    return slot;
  }

  /**
   * Insert an item at an exact slot index, shifting later line pointers right.
   * Slot numbers after `slot` change — B-tree use only (heap must use addItem).
   */
  insertItemAt(slot: number, data: Buffer): void {
    const n = this.itemCount;
    if (slot < 0 || slot > n) throw new RangeError(`slot ${slot} out of range`);
    if (this.freeSpace < data.length + LINE_POINTER_SIZE) {
      this.compact();
      if (this.freeSpace < data.length + LINE_POINTER_SIZE)
        throw new PageFullError(data.length + LINE_POINTER_SIZE, this.freeSpace);
    }
    const off = this.upper - data.length;
    data.copy(this.buf, off);
    this.upper = off;
    // shift line pointers [slot, n) right by one
    const from = this.lpOffset(slot);
    const to = this.lpOffset(slot + 1);
    this.buf.copyWithin(to, from, this.lpOffset(n));
    this.lower = this.lower + LINE_POINTER_SIZE;
    this.writeLp(slot, off, LpFlags.Normal, data.length);
  }

  /** Mark a slot Unused (heap delete). Space reclaimed lazily by compact(). */
  deleteItem(slot: number): void {
    if (slot < 0 || slot >= this.itemCount) throw new RangeError(`slot ${slot} out of range`);
    this.writeLp(slot, 0, LpFlags.Unused, 0);
    // Trim trailing unused pointers so itemCount shrinks when possible.
    let n = this.itemCount;
    while (n > 0 && this.readLp(n - 1).flags === LpFlags.Unused) n--;
    this.lower = PAGE_HEADER_SIZE + n * LINE_POINTER_SIZE;
  }

  /** Remove a slot entirely, shifting later pointers left (B-tree use only). */
  removeItemAt(slot: number): void {
    const n = this.itemCount;
    if (slot < 0 || slot >= n) throw new RangeError(`slot ${slot} out of range`);
    this.buf.copyWithin(this.lpOffset(slot), this.lpOffset(slot + 1), this.lpOffset(n));
    this.lower = this.lower - LINE_POINTER_SIZE;
  }

  /** Replace an item in place if the new data fits in the old slot; else false. */
  replaceItem(slot: number, data: Buffer): boolean {
    const lp = this.readLp(slot);
    if (lp.flags !== LpFlags.Normal) throw new Error(`slot ${slot} not normal`);
    if (data.length > lp.len) return false;
    data.copy(this.buf, lp.off);
    this.writeLp(slot, lp.off, LpFlags.Normal, data.length);
    return true;
  }

  /** PageRepairFragmentation: pack live items toward the special space. */
  compact(): void {
    const n = this.itemCount;
    const live: { slot: number; off: number; len: number }[] = [];
    for (let i = 0; i < n; i++) {
      const lp = this.readLp(i);
      if (lp.flags === LpFlags.Normal) live.push({ slot: i, off: lp.off, len: lp.len });
    }
    // Move highest-offset items first so we never overwrite unmoved data.
    live.sort((a, b) => b.off - a.off);
    let upper = this.specialOffset;
    const tmp = Buffer.alloc(PAGE_SIZE);
    for (const it of live) {
      upper -= it.len;
      this.buf.copy(tmp, upper, it.off, it.off + it.len);
      it.off = upper;
    }
    tmp.copy(this.buf, upper, upper, this.specialOffset);
    for (const it of live) this.writeLp(it.slot, it.off, LpFlags.Normal, it.len);
    this.upper = upper;
  }

  /** All Normal items in slot order. */
  *items(): IterableIterator<{ slot: number; data: Buffer }> {
    const n = this.itemCount;
    for (let i = 0; i < n; i++) {
      const d = this.getItem(i);
      if (d) yield { slot: i, data: d };
    }
  }
}

// ---- CRC32 (IEEE), table-driven ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
