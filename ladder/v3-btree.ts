/**
 * v3 — an index, so `id = 4321` reads 2 pages instead of 500.
 *
 * A B+tree is a sorted tree of pages. Leaves hold (key → row address) in
 * order and are chained left to right. Internal pages hold (key → child)
 * and say "keys smaller than this go left".
 *
 *                     ┌───────── root (internal) ─────────┐
 *                     │  -inf → A      2000 → B      4000 → C │
 *                     └───┬───────────────┬───────────────┬──┘
 *                 ┌───────┘               │               └────────┐
 *        ┌────────▼────────┐    ┌─────────▼────────┐    ┌──────────▼───────┐
 *        │ leaf A: 1..1999 │──► │ leaf B: 2000..3999│──► │ leaf C: 4000..  │
 *        └─────────────────┘    └──────────────────┘    └──────────────────┘
 *
 * Lookup = root → pick child → leaf → binary search. Two or three page reads
 * no matter how many rows. When a page fills up it splits in two and the
 * middle key is pushed up to the parent. When the root splits the tree
 * grows one level. That is the whole algorithm.
 *
 * Simplifications versus src/storage/btree.ts: keys are integers (fixed
 * 8 bytes), the index is unique, the root stays at page 0, and the index
 * gets its own file. The real engine handles variable-length keys,
 * duplicates (by adding the row address to the key), and shares one file
 * and one commit with the table.
 */
import type { FakeDisk } from './fake-disk.js';
import { Page, PAGE_SIZE, type TID } from './v1-pages.js';
import { LoggedPageFile, DurableDb } from './v2-wal.js';
import type { Row } from './v0-array.js';

// node layout: isLeaf u8 | count u16 | next u32 | entries...
// entry (14 bytes): key i64 | page u32 | slot u16   (internal nodes use `page` as the child id)
const HEAD = 7;
const ENTRY = 14;
export const CAPACITY = Math.floor((PAGE_SIZE - HEAD) / ENTRY); // 292 entries per page

interface Entry {
  key: number;
  page: number;
  slot: number;
}

function readNode(p: Page) {
  const b = p.buf;
  const isLeaf = b.readUInt8(0) === 1;
  const count = b.readUInt16LE(1);
  const next = b.readUInt32LE(3);
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEAD + i * ENTRY;
    entries.push({ key: Number(b.readBigInt64LE(o)), page: b.readUInt32LE(o + 8), slot: b.readUInt16LE(o + 12) });
  }
  return { isLeaf, next, entries };
}

function writeNode(isLeaf: boolean, next: number, entries: Entry[]): Page {
  if (entries.length > CAPACITY) throw new Error('node overflow');
  const p = new Page(Buffer.alloc(PAGE_SIZE));
  p.buf.writeUInt8(isLeaf ? 1 : 0, 0);
  p.buf.writeUInt16LE(entries.length, 1);
  p.buf.writeUInt32LE(next, 3);
  entries.forEach((e, i) => {
    const o = HEAD + i * ENTRY;
    p.buf.writeBigInt64LE(BigInt(e.key), o);
    p.buf.writeUInt32LE(e.page, o + 8);
    p.buf.writeUInt16LE(e.slot, o + 12);
  });
  return p;
}

export class BTree {
  constructor(readonly pages: LoggedPageFile) {
    if (pages.pageCount === 0) pages.writePage(0, writeNode(true, 0, [])); // root = page 0, starts as an empty leaf
  }

  /** Walk root → leaf for `key`, remembering the path (page id + which child we took). */
  private descend(key: number): { leaf: number; node: ReturnType<typeof readNode>; path: { page: number; idx: number }[] } {
    const path: { page: number; idx: number }[] = [];
    let id = 0;
    for (;;) {
      const n = readNode(this.pages.readPage(id));
      if (n.isLeaf) return { leaf: id, node: n, path };
      let idx = 0; // entry 0 is "-infinity": always a valid choice
      for (let i = 1; i < n.entries.length; i++) if (n.entries[i]!.key <= key) idx = i;
      path.push({ page: id, idx });
      id = n.entries[idx]!.page;
    }
  }

  lookup(key: number): TID | null {
    const { node } = this.descend(key);
    const e = node.entries.find((x) => x.key === key); // a real engine binary-searches here
    return e ? { page: e.page, slot: e.slot } : null;
  }

  insert(key: number, tid: TID): void {
    if (this.lookup(key)) throw new Error(`duplicate key ${key}`);
    const { leaf, path } = this.descend(key);
    this.insertInto(leaf, { key, page: tid.page, slot: tid.slot }, path, true);
  }

  /** Put one entry into a node; split upward if it overflows. */
  private insertInto(id: number, entry: Entry, path: { page: number; idx: number }[], isLeaf: boolean): void {
    const n = readNode(this.pages.readPage(id));
    const entries = [...n.entries, entry].sort((a, b) => a.key - b.key);
    if (entries.length <= CAPACITY) {
      this.pages.writePage(id, writeNode(isLeaf, n.next, entries));
      return;
    }
    // ---- split ----
    const mid = Math.ceil(entries.length / 2);
    const leftEntries = entries.slice(0, mid);
    const rightEntries = entries.slice(mid);
    const separator = rightEntries[0]!.key; // smallest key on the right, pushed up

    if (id === 0) {
      // Root split: the root must stay page 0, so both halves become NEW pages
      // and page 0 turns into an internal node pointing at them. Tree grows one level.
      const leftId = this.pages.pageCount;
      const rightId = leftId + 1;
      this.pages.writePage(leftId, writeNode(isLeaf, rightId, leftEntries));
      this.pages.writePage(rightId, writeNode(isLeaf, n.next, rightEntries));
      this.pages.writePage(0, writeNode(false, 0, [{ key: 0, page: leftId, slot: 0 }, { key: separator, page: rightId, slot: 0 }]));
      return;
    }
    const rightId = this.pages.pageCount;
    this.pages.writePage(rightId, writeNode(isLeaf, n.next, rightEntries));
    this.pages.writePage(id, writeNode(isLeaf, rightId, leftEntries));
    const parent = path.pop()!;
    this.insertInto(parent.page, { key: separator, page: rightId, slot: 0 }, path, false);
  }

  /** Height in levels (tests). */
  height(): number {
    let h = 1;
    let id = 0;
    for (;;) {
      const n = readNode(this.pages.readPage(id));
      if (n.isLeaf) return h;
      id = n.entries[0]!.page;
      h++;
    }
  }
}

/** v2's DurableDb plus a primary-key index on the `id` column. */
export class IndexedDb extends DurableDb {
  readonly index: BTree;
  constructor(disk: FakeDisk, file: string) {
    super(disk, file);
    this.index = new BTree(new LoggedPageFile(disk, file + '-idx'));
  }

  override insert(row: Row): TID {
    const id = row['id'];
    if (typeof id !== 'number') throw new Error('rows need an integer id');
    const tid = this.insertNoCommit(row);
    this.index.insert(id, tid); // keep the index in step with the table
    this.pages.commit();
    this.index.pages.commit(); // (two files, two commits: the real engine uses one file so this is atomic)
    return tid;
  }

  /** The fast path: index → one page read. */
  findById(id: number): Row | null {
    const tid = this.index.lookup(id);
    if (!tid) return null;
    return JSON.parse(this.pages.readPage(tid.page).get(tid.slot).toString('utf8'));
  }
}
