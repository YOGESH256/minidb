import { describe, it, expect } from 'vitest';
import { Pager } from '../src/storage/pager.js';
import { Heap } from '../src/storage/heap.js';
import { BTree, MAX_KEY_SIZE } from '../src/storage/btree.js';
import { encodeValue, compareEncoded } from '../src/types.js';
import { FaultFS, mulberry32 } from './helpers.js';

const intCmp = (a: Buffer, b: Buffer) => compareEncoded('INT', a, b);
const textCmp = (a: Buffer, b: Buffer) => compareEncoded('TEXT', a, b);
const K = (n: number) => encodeValue('INT', n);

describe('Heap', () => {
  it('insert/get/delete/scan across many pages', () => {
    const fs = new FaultFS();
    const pager = new Pager('/db', { openFile: fs.open, poolSize: 64 });
    pager.begin();
    const heap = new Heap(pager, Heap.create(pager));
    const tids = [];
    for (let i = 0; i < 2000; i++) tids.push(heap.insert(Buffer.from('row-' + i)));
    pager.commit();
    expect(heap.get(tids[1234]!)!.toString()).toBe('row-1234');
    pager.begin();
    heap.delete(tids[5]!);
    pager.commit();
    expect(heap.get(tids[5]!)).toBeNull();
    const all = [...heap.scan()].map((r) => r.data.toString());
    expect(all.length).toBe(1999);
    expect(all[0]).toBe('row-0');
    expect(all.includes('row-5')).toBe(false);
    expect(pager.getMeta().pageCount).toBeGreaterThan(5);
    pager.begin();
    heap.drop();
    pager.commit();
    expect(pager.getMeta().freelistHead).not.toBe(0);
    pager.close();
  });
});

describe('BTree', () => {
  it('random inserts/deletes match a reference, with splits and duplicates', () => {
    const fs = new FaultFS();
    const pager = new Pager('/db', { openFile: fs.open, poolSize: 256 });
    pager.begin();
    const tree = new BTree(pager, BTree.create(pager), intCmp);
    const ref = new Map<number, Set<string>>();
    const rng = mulberry32(1);
    const N = 6000;
    for (let i = 0; i < N; i++) {
      const key = Math.floor(rng() * 1500); // heavy duplicates
      const tid = { page: i, slot: i % 7 };
      tree.insert(K(key), tid);
      if (!ref.has(key)) ref.set(key, new Set());
      ref.get(key)!.add(`${tid.page}:${tid.slot}`);
    }
    pager.commit();
    expect(tree.height()).toBeGreaterThan(1);
    expect(tree.verify()).toBe(N);
    // full scan ordered
    const all = [...tree.scan()];
    expect(all.length).toBe(N);
    for (let i = 1; i < all.length; i++) expect(intCmp(all[i - 1]!.key, all[i]!.key)).toBeLessThanOrEqual(0);
    // point lookups
    for (const [key, set] of ref) {
      const got = [...tree.lookup(K(key))].map((t) => `${t.page}:${t.slot}`);
      expect(new Set(got)).toEqual(set);
    }
    // range [100, 200)
    const range = [...tree.scan({ lo: K(100), hi: K(200), hiInclusive: false })];
    let expected = 0;
    for (const [k, s] of ref) if (k >= 100 && k < 200) expected += s.size;
    expect(range.length).toBe(expected);
    const excl = [...tree.scan({ lo: K(100), loInclusive: false, hi: K(200), hiInclusive: false })];
    expect(excl.length).toBe(expected - (ref.get(100)?.size ?? 0));
    // delete half
    pager.begin();
    let removed = 0;
    for (const [key, set] of ref) {
      for (const s of [...set]) {
        if (rng() < 0.5) {
          const [p, sl] = s.split(':').map(Number);
          expect(tree.remove(K(key), { page: p!, slot: sl! })).toBe(true);
          set.delete(s);
          removed++;
        }
      }
    }
    pager.commit();
    expect(tree.verify()).toBe(N - removed);
    expect(tree.remove(K(999999), { page: 0, slot: 0 })).toBe(false);
    for (const [key, set] of ref) {
      const got = [...tree.lookup(K(key))].map((t) => `${t.page}:${t.slot}`);
      expect(new Set(got)).toEqual(set);
    }
    pager.begin();
    tree.drop();
    pager.commit();
    pager.close();
  });

  it('variable-length text keys, sequential and reverse inserts', () => {
    const fs = new FaultFS();
    const pager = new Pager('/db', { openFile: fs.open, poolSize: 256 });
    pager.begin();
    const tree = new BTree(pager, BTree.create(pager), textCmp);
    const keys: string[] = [];
    for (let i = 0; i < 3000; i++) keys.push('k' + String(i).padStart(5, '0') + 'x'.repeat(i % 50));
    for (let i = keys.length - 1; i >= 0; i--) tree.insert(encodeValue('TEXT', keys[i]!), { page: i, slot: 0 });
    pager.commit();
    expect(tree.verify()).toBe(keys.length);
    const all = [...tree.scan()].map((e) => e.tid.page);
    expect(all).toEqual(keys.map((_, i) => i));
    expect(() => tree.insert(Buffer.alloc(MAX_KEY_SIZE + 1), { page: 0, slot: 0 })).toThrow(/too large/);
    pager.close();
  });

  it('survives crash between commits', () => {
    const fs = new FaultFS();
    let pager = new Pager('/db', { openFile: fs.open, poolSize: 64, checkpointBytes: 1 << 30 });
    pager.begin();
    const metaId = BTree.create(pager);
    let tree = new BTree(pager, metaId, intCmp);
    for (let i = 0; i < 500; i++) tree.insert(K(i), { page: i, slot: 0 });
    pager.commit();
    pager.begin();
    for (let i = 500; i < 1000; i++) tree.insert(K(i), { page: i, slot: 0 });
    // no commit
    fs.crash('drop');
    pager = new Pager('/db', { openFile: fs.open, poolSize: 64 });
    tree = new BTree(pager, metaId, intCmp);
    expect(tree.verify()).toBe(500);
    pager.close();
  });
});
