import { Page, PageType, PageFullError, PAGE_SIZE, PAGE_HEADER_SIZE, LINE_POINTER_SIZE } from './page.js';
import type { Pager } from './pager.js';
import type { TID } from './heap.js';

/**
 * On-disk B+tree, PostgreSQL nbtree shape (single writer, no concurrency):
 *
 *  - Meta page holds the current root (so a root split never changes the id
 *    the catalog stores).
 *  - Node special space (16 B): prev u32 | next u32 | level u16 | flags u16.
 *    level 0 = leaf. next == 0 means rightmost (page 0 is the DB meta page and
 *    can never be a node).
 *  - Every item has the same shape: ptr u32 | tidPage u32 | tidSlot u16 | key.
 *    Leaf: ptr unused, tid = heap row. Internal: ptr = child page; the
 *    (tid,key) is the separator = first item of that child at split time.
 *  - Non-rightmost pages carry a HIGH KEY as item 0 (upper bound of the page);
 *    data items start at 1. Rightmost pages start data at 0.
 *  - The first data item of an internal page acts as "-infinity": descent
 *    picks the last data item <= search key, defaulting to the first.
 *  - Items are ordered by (key, tid). Searching with tid = (0,0) lands before
 *    every duplicate of a key; tid = (MAX,MAX) lands after. That is what makes
 *    duplicates and exclusive bounds work without special cases.
 *  - Split point chosen by cumulative bytes. No page merging on delete
 *    (PG does not merge either; empty leaves are harmless).
 */

const SPECIAL_SIZE = 16;
const S_PREV = 0;
const S_NEXT = 4;
const S_LEVEL = 8;
const S_FLAGS = 10;
const F_LEAF = 1;
const F_ROOT = 2;

const ITEM_HEADER = 10; // ptr u32 + tidPage u32 + tidSlot u16
const META_ROOT = 24; // meta page body: root page id u32
const USABLE = PAGE_SIZE - PAGE_HEADER_SIZE - SPECIAL_SIZE;
/** Max key: keeps every item under a quarter page so a byte-budgeted split always has a feasible point. */
export const MAX_KEY_SIZE = Math.floor(USABLE / 4) - ITEM_HEADER - LINE_POINTER_SIZE;

export type KeyComparator = (a: Buffer, b: Buffer) => number;

export const TID_MIN: TID = { page: 0, slot: 0 };
export const TID_MAX: TID = { page: 0xffffffff, slot: 0xffff };

interface Item {
  ptr: number;
  tid: TID;
  key: Buffer;
}

function encodeItem(it: Item): Buffer {
  const b = Buffer.alloc(ITEM_HEADER + it.key.length);
  b.writeUInt32LE(it.ptr, 0);
  b.writeUInt32LE(it.tid.page, 4);
  b.writeUInt16LE(it.tid.slot, 8);
  it.key.copy(b, ITEM_HEADER);
  return b;
}

function decodeItem(b: Buffer): Item {
  return {
    ptr: b.readUInt32LE(0),
    tid: { page: b.readUInt32LE(4), slot: b.readUInt16LE(8) },
    key: Buffer.from(b.subarray(ITEM_HEADER)),
  };
}

function compareTid(a: TID, b: TID): number {
  return a.page - b.page || a.slot - b.slot;
}

interface NodeView {
  prev: number;
  next: number;
  level: number;
  flags: number;
  hasHighKey: boolean;
  dataStart: number; // slot of first data item
}

function readNode(page: Page): NodeView {
  const s = page.special;
  const next = s.readUInt32LE(S_NEXT);
  const hasHighKey = next !== 0;
  return {
    prev: s.readUInt32LE(S_PREV),
    next,
    level: s.readUInt16LE(S_LEVEL),
    flags: s.readUInt16LE(S_FLAGS),
    hasHighKey,
    dataStart: hasHighKey ? 1 : 0,
  };
}

function writeNodeHeader(page: Page, prev: number, next: number, level: number, flags: number): void {
  const s = page.special;
  s.writeUInt32LE(prev, S_PREV);
  s.writeUInt32LE(next, S_NEXT);
  s.writeUInt16LE(level, S_LEVEL);
  s.writeUInt16LE(flags, S_FLAGS);
}

export class BTree {
  constructor(
    private readonly pager: Pager,
    readonly metaPage: number,
    private readonly cmp: KeyComparator,
  ) {}

  static create(pager: Pager): number {
    const root = pager.allocPage(PageType.BTreeNode, SPECIAL_SIZE);
    writeNodeHeader(root.page, 0, 0, 0, F_LEAF | F_ROOT);
    const rootId = root.pageId;
    pager.release(root);
    const meta = pager.allocPage(PageType.BTreeMeta, 0);
    meta.buf.writeUInt32LE(rootId, META_ROOT);
    const metaId = meta.pageId;
    pager.release(meta);
    return metaId;
  }

  private rootId(): number {
    return this.pager.with(this.metaPage, (f) => f.buf.readUInt32LE(META_ROOT));
  }

  private setRoot(id: number): void {
    this.pager.with(this.metaPage, (f) => {
      f.buf.writeUInt32LE(id, META_ROOT);
      this.pager.markDirty(f);
    });
  }

  /** Compare an item against a (key, tid) search target. */
  private cmpItem(item: Buffer, key: Buffer, tid: TID): number {
    const c = this.cmp(item.subarray(ITEM_HEADER), key);
    if (c !== 0) return c;
    return compareTid({ page: item.readUInt32LE(4), slot: item.readUInt16LE(8) }, tid);
  }

  /** First data slot whose item >= (key, tid); page.itemCount if none. Binary search. */
  private lowerBound(page: Page, view: NodeView, key: Buffer, tid: TID): number {
    let lo = view.dataStart;
    let hi = page.itemCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cmpItem(page.getItem(mid)!, key, tid) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Data slot of the child to follow: last item <= (key, tid), else the first. */
  private childSlot(page: Page, view: NodeView, key: Buffer, tid: TID): number {
    const lb = this.lowerBound(page, view, key, tid);
    // lb is first item > target (or == target). We want last item <= target.
    if (lb < page.itemCount && this.cmpItem(page.getItem(lb)!, key, tid) === 0) return lb;
    return Math.max(view.dataStart, lb - 1);
  }

  /** Descend to the leaf for (key, tid), recording the path of (pageId, dataSlot). */
  private descend(key: Buffer, tid: TID): { leaf: number; path: { pageId: number; slot: number }[] } {
    const path: { pageId: number; slot: number }[] = [];
    let pageId = this.rootId();
    for (;;) {
      const r = this.pager.with(pageId, (f) => {
        const view = readNode(f.page);
        this.pager.traceEvent({ op: 'index', page: pageId, level: view.level, note: view.level === 0 ? 'leaf' : `internal, ${f.page.itemCount - view.dataStart} children` });
        if (view.level === 0) return null;
        const slot = this.childSlot(f.page, view, key, tid);
        return { slot, child: f.page.getItem(slot)!.readUInt32LE(0) };
      });
      if (r === null) return { leaf: pageId, path };
      path.push({ pageId, slot: r.slot });
      pageId = r.child;
    }
  }

  private leftmostLeaf(): number {
    let pageId = this.rootId();
    for (;;) {
      const r = this.pager.with(pageId, (f) => {
        const view = readNode(f.page);
        if (view.level === 0) return null;
        return f.page.getItem(view.dataStart)!.readUInt32LE(0);
      });
      if (r === null) return pageId;
      pageId = r;
    }
  }

  // ------------------------------------------------------------ insert

  insert(key: Buffer, tid: TID): void {
    if (key.length > MAX_KEY_SIZE) throw new Error(`index key too large (${key.length} > ${MAX_KEY_SIZE})`);
    const { leaf, path } = this.descend(key, tid);
    const item = encodeItem({ ptr: 0, tid, key });
    this.insertIntoPage(leaf, item, path, (page, view) => this.lowerBound(page, view, key, tid));
  }

  /**
   * Insert an encoded item into a page at the slot chosen by `slotFn`;
   * split and propagate upward if it does not fit.
   */
  private insertIntoPage(
    pageId: number,
    item: Buffer,
    path: { pageId: number; slot: number }[],
    slotFn: (page: Page, view: NodeView) => number,
  ): void {
    const f = this.pager.acquire(pageId);
    let split: { view: NodeView; items: Item[]; highKey: Item | null } | null = null;
    try {
      const view = readNode(f.page);
      const slot = slotFn(f.page, view);
      try {
        f.page.insertItemAt(slot, item);
        this.pager.markDirty(f);
        return;
      } catch (e) {
        if (!(e instanceof PageFullError)) throw e;
      }
      // Gather everything for the split.
      const items: Item[] = [];
      for (let i = view.dataStart; i < f.page.itemCount; i++) items.push(decodeItem(f.page.getItem(i)!));
      items.splice(slot - view.dataStart, 0, decodeItem(item));
      const highKey = view.hasHighKey ? decodeItem(f.page.getItem(0)!) : null;
      split = { view, items, highKey };
    } finally {
      this.pager.release(f);
    }
    this.splitPage(pageId, split.view, split.items, split.highKey, path);
  }

  private splitPage(
    leftId: number,
    view: NodeView,
    items: Item[],
    oldHighKey: Item | null,
    path: { pageId: number; slot: number }[],
  ): void {
    // Split point by cumulative bytes. The left page must also hold the
    // separator as its new high key and the right page the old high key, so
    // both are budgeted; among feasible points pick the most balanced.
    const size = (it: Item) => ITEM_HEADER + it.key.length + LINE_POINTER_SIZE;
    const sizes = items.map(size);
    const total = sizes.reduce((a, b) => a + b, 0);
    const oldHkSize = oldHighKey ? size(oldHighKey) : 0;
    let splitAt = -1;
    let bestDiff = Infinity;
    let acc = 0;
    for (let s = 1; s < items.length; s++) {
      acc += sizes[s - 1]!;
      const left = acc + sizes[s]!; // + separator copy as high key
      const right = total - acc + oldHkSize;
      if (left > USABLE || right > USABLE) continue;
      const diff = Math.abs(left - right);
      if (diff < bestDiff) {
        bestDiff = diff;
        splitAt = s;
      }
    }
    if (splitAt < 0) throw new Error('index page split failed: items too large');
    const leftItems = items.slice(0, splitAt);
    const rightItems = items.slice(splitAt);
    const separator = rightItems[0]!;

    // New right sibling.
    const rf = this.pager.allocPage(PageType.BTreeNode, SPECIAL_SIZE);
    const rightId = rf.pageId;
    try {
      writeNodeHeader(rf.page, leftId, view.next, view.level, view.flags & ~F_ROOT);
      if (oldHighKey) rf.page.insertItemAt(0, encodeItem(oldHighKey));
      for (const it of rightItems) rf.page.insertItemAt(rf.page.itemCount, encodeItem(it));
    } finally {
      this.pager.release(rf);
    }
    if (view.next !== 0) {
      this.pager.with(view.next, (nf) => {
        nf.page.special.writeUInt32LE(rightId, S_PREV);
        this.pager.markDirty(nf);
      });
    }

    // Rewrite left: new high key = separator, then left items.
    this.pager.with(leftId, (lf) => {
      Page.init(lf.buf, PageType.BTreeNode, SPECIAL_SIZE);
      writeNodeHeader(lf.page, view.prev, rightId, view.level, view.flags & ~F_ROOT);
      lf.page.insertItemAt(0, encodeItem({ ...separator, ptr: 0 }));
      for (const it of leftItems) lf.page.insertItemAt(lf.page.itemCount, encodeItem(it));
      if (lf.page.freeSpace < 0) throw new Error('index split invariant violated');
      this.pager.markDirty(lf);
    });

    const downlink = encodeItem({ ptr: rightId, tid: separator.tid, key: separator.key });
    const parent = path.pop();
    if (!parent) {
      // Root split: new root with two downlinks (first acts as -infinity).
      const nr = this.pager.allocPage(PageType.BTreeNode, SPECIAL_SIZE);
      try {
        writeNodeHeader(nr.page, 0, 0, view.level + 1, F_ROOT);
        nr.page.insertItemAt(0, encodeItem({ ptr: leftId, tid: leftItems[0]!.tid, key: leftItems[0]!.key }));
        nr.page.insertItemAt(1, downlink);
        this.setRoot(nr.pageId);
      } finally {
        this.pager.release(nr);
      }
      return;
    }
    // Insert the downlink right after the left child's slot in the parent.
    this.insertIntoPage(parent.pageId, downlink, path, () => parent.slot + 1);
  }

  // ------------------------------------------------------------ delete

  /** Remove the exact (key, tid) entry. Returns false if absent. */
  remove(key: Buffer, tid: TID): boolean {
    const { leaf } = this.descend(key, tid);
    return this.pager.with(leaf, (f) => {
      const view = readNode(f.page);
      const slot = this.lowerBound(f.page, view, key, tid);
      if (slot >= f.page.itemCount) return false;
      if (this.cmpItem(f.page.getItem(slot)!, key, tid) !== 0) return false;
      f.page.removeItemAt(slot);
      this.pager.markDirty(f);
      return true;
    });
  }

  // ------------------------------------------------------------ scan

  /**
   * Ordered range scan. Bounds are keys (no tid). Leaf contents are copied out
   * page by page, so the caller may modify the tree between yields.
   */
  *scan(opts: { lo?: Buffer; loInclusive?: boolean; hi?: Buffer; hiInclusive?: boolean } = {}): IterableIterator<{ key: Buffer; tid: TID }> {
    const loInc = opts.loInclusive ?? true;
    const hiInc = opts.hiInclusive ?? true;
    const loTid = loInc ? TID_MIN : TID_MAX;
    let lo: Buffer | undefined = opts.lo;
    let pageId = lo ? this.descend(lo, loTid).leaf : this.leftmostLeaf();
    while (pageId !== 0) {
      const batch: { key: Buffer; tid: TID }[] = [];
      let done = false;
      const next = this.pager.with(pageId, (f) => {
        const view = readNode(f.page);
        let s = lo ? this.lowerBound(f.page, view, lo, loTid) : view.dataStart;
        for (; s < f.page.itemCount; s++) {
          const it = decodeItem(f.page.getItem(s)!);
          if (opts.hi) {
            const c = this.cmp(it.key, opts.hi);
            if (c > 0 || (c === 0 && !hiInc)) {
              done = true;
              break;
            }
          }
          batch.push({ key: it.key, tid: it.tid });
        }
        return view.next;
      });
      yield* batch;
      if (done) return;
      pageId = next;
      lo = undefined; // later leaves start at their first data item
    }
  }

  /** Equality lookup convenience. */
  *lookup(key: Buffer): IterableIterator<TID> {
    for (const e of this.scan({ lo: key, hi: key })) yield e.tid;
  }

  // ------------------------------------------------------------ drop / debug

  /** Free every page of the tree including the meta page. */
  drop(): void {
    const root = this.rootId();
    const stack = [root];
    const all: number[] = [];
    while (stack.length) {
      const id = stack.pop()!;
      all.push(id);
      this.pager.with(id, (f) => {
        const view = readNode(f.page);
        if (view.level === 0) return;
        for (let i = view.dataStart; i < f.page.itemCount; i++) stack.push(f.page.getItem(i)!.readUInt32LE(0));
      });
    }
    for (const id of all) this.pager.freePage(id);
    this.pager.freePage(this.metaPage);
  }

  /** Structural check for tests: ordering within pages, high keys, sibling links. Returns entry count. */
  verify(): number {
    let count = 0;
    let pageId = this.leftmostLeaf();
    let prevLast: Buffer | null = null;
    let prevId = 0;
    while (pageId !== 0) {
      const next = this.pager.with(pageId, (f) => {
        const view = readNode(f.page);
        if (view.level !== 0) throw new Error(`verify: page ${pageId} not a leaf`);
        if (view.prev !== prevId) throw new Error(`verify: page ${pageId} prev=${view.prev} expected ${prevId}`);
        for (let s = view.dataStart; s < f.page.itemCount; s++) {
          const it = f.page.getItem(s)!;
          const key = it.subarray(ITEM_HEADER);
          if (prevLast && this.cmp(prevLast, key) > 0) throw new Error(`verify: order violation on page ${pageId} slot ${s}`);
          if (view.hasHighKey && this.cmp(key, f.page.getItem(0)!.subarray(ITEM_HEADER)) > 0)
            throw new Error(`verify: key above high key on page ${pageId}`);
          prevLast = Buffer.from(key);
          count++;
        }
        return view.next;
      });
      prevId = pageId;
      pageId = next;
    }
    return count;
  }

  /** Height (levels) for tests. */
  height(): number {
    return this.pager.with(this.rootId(), (f) => readNode(f.page).level + 1);
  }
}

