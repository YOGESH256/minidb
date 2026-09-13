import { describe, it, expect } from 'vitest';
import { Page, PAGE_SIZE, PageType, PageFullError, LpFlags } from '../src/storage/page.js';

describe('Page', () => {
  it('adds, reads, deletes, compacts', () => {
    const p = Page.init(Buffer.alloc(PAGE_SIZE), PageType.Heap, 8);
    const a = p.addItem(Buffer.from('hello'));
    const b = p.addItem(Buffer.from('world!!'));
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(p.getItem(0)!.toString()).toBe('hello');
    expect(p.getItem(1)!.toString()).toBe('world!!');
    expect(p.special.length).toBe(8);
    p.deleteItem(0);
    expect(p.getItem(0)).toBeNull();
    expect(p.slotFlags(0)).toBe(LpFlags.Unused);
    expect(p.itemCount).toBe(2);
    const before = p.freeSpace;
    p.compact();
    expect(p.freeSpace).toBe(before + 5);
    expect(p.getItem(1)!.toString()).toBe('world!!');
    // reuse of dead slot
    const c = p.addItem(Buffer.from('x'));
    expect(c).toBe(0);
  });

  it('fills up and throws PageFullError, then reclaims after delete', () => {
    const p = Page.init(Buffer.alloc(PAGE_SIZE), PageType.Heap, 8);
    const item = Buffer.alloc(100, 1);
    let n = 0;
    try {
      for (;;) {
        p.addItem(item);
        n++;
      }
    } catch (e) {
      expect(e).toBeInstanceOf(PageFullError);
    }
    expect(n).toBe(Math.floor((PAGE_SIZE - 24 - 8) / 104));
    p.deleteItem(3);
    expect(() => p.addItem(item)).not.toThrow();
  });

  it('insertItemAt/removeItemAt keep order', () => {
    const p = Page.init(Buffer.alloc(PAGE_SIZE), PageType.BTreeNode, 16);
    p.insertItemAt(0, Buffer.from('b'));
    p.insertItemAt(0, Buffer.from('a'));
    p.insertItemAt(2, Buffer.from('c'));
    expect([...p.items()].map((i) => i.data.toString())).toEqual(['a', 'b', 'c']);
    p.removeItemAt(1);
    expect([...p.items()].map((i) => i.data.toString())).toEqual(['a', 'c']);
  });

  it('checksum round-trips and detects corruption', () => {
    const p = Page.init(Buffer.alloc(PAGE_SIZE), PageType.Heap, 8);
    p.addItem(Buffer.from('data'));
    p.stampChecksum();
    expect(p.verifyChecksum()).toBe(true);
    p.buf[100] = p.buf[100]! ^ 0xff;
    expect(p.verifyChecksum()).toBe(false);
  });
});
