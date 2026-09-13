import { PageType, PageFullError, PAGE_SIZE, PAGE_HEADER_SIZE, LINE_POINTER_SIZE } from './page.js';
import type { Pager } from './pager.js';

/**
 * Heap file: an unordered chain of slotted pages. Rows are addressed by
 * TID = (page, slot); slot numbers are stable across deletes and compaction.
 *
 * Special space (8 B): next u32 | last u32   (last is only meaningful on the root)
 */

export interface TID {
  page: number;
  slot: number;
}

const SPECIAL_SIZE = 8;
const S_NEXT = 0;
const S_LAST = 4;
export const MAX_TUPLE_SIZE = PAGE_SIZE - PAGE_HEADER_SIZE - SPECIAL_SIZE - LINE_POINTER_SIZE;

export function tidEquals(a: TID, b: TID): boolean {
  return a.page === b.page && a.slot === b.slot;
}

export class Heap {
  constructor(
    private readonly pager: Pager,
    readonly rootPage: number,
  ) {}

  static create(pager: Pager): number {
    const f = pager.allocPage(PageType.Heap, SPECIAL_SIZE);
    f.page.special.writeUInt32LE(0, S_NEXT);
    f.page.special.writeUInt32LE(f.pageId, S_LAST);
    const id = f.pageId;
    pager.release(f);
    return id;
  }

  insert(data: Buffer): TID {
    if (data.length > MAX_TUPLE_SIZE) throw new Error(`row too large (${data.length} > ${MAX_TUPLE_SIZE})`);
    const last = this.pager.with(this.rootPage, (f) => f.page.special.readUInt32LE(S_LAST));
    const lastFrame = this.pager.acquire(last);
    try {
      try {
        const slot = lastFrame.page.addItem(data);
        this.pager.markDirty(lastFrame);
        return { page: last, slot };
      } catch (e) {
        if (!(e instanceof PageFullError)) throw e;
      }
      // Last page is full. Before growing, look for a page with room left by
      // earlier deletes. One walk per full page, so amortised cheap.
      const reuse = this.findPageWithRoom(data.length);
      if (reuse !== null) {
        const slot = this.pager.with(reuse, (rf) => {
          const s = rf.page.addItem(data);
          this.pager.markDirty(rf);
          return s;
        });
        return { page: reuse, slot };
      }
      // Extend the chain.
      const nf = this.pager.allocPage(PageType.Heap, SPECIAL_SIZE);
      try {
        nf.page.special.writeUInt32LE(0, S_NEXT);
        nf.page.special.writeUInt32LE(0, S_LAST);
        const slot = nf.page.addItem(data);
        lastFrame.page.special.writeUInt32LE(nf.pageId, S_NEXT);
        this.pager.markDirty(lastFrame);
        this.pager.with(this.rootPage, (rf) => {
          rf.page.special.writeUInt32LE(nf.pageId, S_LAST);
          this.pager.markDirty(rf);
        });
        return { page: nf.pageId, slot };
      } finally {
        this.pager.release(nf);
      }
    } finally {
      this.pager.release(lastFrame);
    }
  }

  private findPageWithRoom(need: number): number | null {
    let pageId: number = this.rootPage;
    while (pageId !== 0) {
      const r = this.pager.with(pageId, (f) => ({ fits: f.page.freeSpaceAfterCompact >= need + LINE_POINTER_SIZE, next: f.page.special.readUInt32LE(S_NEXT) }));
      if (r.fits) return pageId;
      pageId = r.next;
    }
    return null;
  }

  /** Copy of the row bytes, or null if the slot is dead. */
  get(tid: TID): Buffer | null {
    return this.pager.with(tid.page, (f) => {
      if (f.page.type !== PageType.Heap) return null;
      const d = f.page.getItem(tid.slot);
      return d ? Buffer.from(d) : null;
    });
  }

  delete(tid: TID): void {
    this.pager.with(tid.page, (f) => {
      f.page.deleteItem(tid.slot);
      this.pager.markDirty(f);
    });
  }

  /** In-place update when the new row fits the old slot; else delete + insert. */
  update(tid: TID, data: Buffer): TID {
    const inPlace = this.pager.with(tid.page, (f) => {
      if (f.page.replaceItem(tid.slot, data)) {
        this.pager.markDirty(f);
        return true;
      }
      return false;
    });
    if (inPlace) return tid;
    this.delete(tid);
    return this.insert(data);
  }

  /** Sequential scan in TID order. Rows are copied out, so the caller may write during iteration. */
  *scan(): IterableIterator<{ tid: TID; data: Buffer }> {
    let pageId: number = this.rootPage;
    while (pageId !== 0) {
      const batch: { tid: TID; data: Buffer }[] = [];
      const next = this.pager.with(pageId, (f) => {
        for (const it of f.page.items()) batch.push({ tid: { page: pageId, slot: it.slot }, data: Buffer.from(it.data) });
        return f.page.special.readUInt32LE(S_NEXT);
      });
      yield* batch;
      pageId = next;
    }
  }

  /** Free every page of the chain. */
  drop(): void {
    let pageId: number = this.rootPage;
    while (pageId !== 0) {
      const next = this.pager.with(pageId, (f) => f.page.special.readUInt32LE(S_NEXT));
      this.pager.freePage(pageId);
      pageId = next;
    }
  }
}

