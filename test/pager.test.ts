import { describe, it, expect } from 'vitest';
import { Pager } from '../src/storage/pager.js';
import { PageType } from '../src/storage/page.js';
import { FaultFS } from './helpers.js';

function writeMarker(pager: Pager, pageId: number, text: string) {
  pager.with(pageId, (f) => {
    f.buf.write(text.padEnd(32, '\0'), 40);
    pager.markDirty(f);
  });
}
function readMarker(pager: Pager, pageId: number): string {
  return pager.with(pageId, (f) => f.buf.toString('utf8', 40, 72).replace(/\0+$/, ''));
}

describe('Pager', () => {
  it('commit persists across reopen; rollback discards', () => {
    const fs = new FaultFS();
    let pager = new Pager('/db', { openFile: fs.open, poolSize: 16 });
    pager.begin();
    const f = pager.allocPage(PageType.Heap, 0);
    const id = f.pageId;
    pager.release(f);
    writeMarker(pager, id, 'committed');
    pager.commit();
    pager.begin();
    writeMarker(pager, id, 'rolled back');
    pager.rollback();
    expect(readMarker(pager, id)).toBe('committed');
    pager.close();
    pager = new Pager('/db', { openFile: fs.open, poolSize: 16 });
    expect(readMarker(pager, id)).toBe('committed');
    expect(pager.getMeta().pageCount).toBe(2);
    pager.close();
  });

  it('recovers committed WAL after crash before checkpoint', () => {
    const fs = new FaultFS();
    let pager = new Pager('/db', { openFile: fs.open, poolSize: 16, checkpointBytes: 1 << 30 });
    pager.begin();
    const f = pager.allocPage(PageType.Heap, 0);
    const id = f.pageId;
    pager.release(f);
    writeMarker(pager, id, 'v1');
    pager.commit();
    // Data file has only the meta page from initMeta's checkpoint-less commit; page `id` lives in WAL only.
    fs.crash('drop');
    pager = new Pager('/db', { openFile: fs.open, poolSize: 16 });
    expect(pager.stats.recoveredPages).toBeGreaterThan(0);
    expect(readMarker(pager, id)).toBe('v1');
    pager.close();
  });

  it('discards an uncommitted / torn WAL tail', () => {
    const fs = new FaultFS();
    fs.seed(7);
    let pager = new Pager('/db', { openFile: fs.open, poolSize: 16, checkpointBytes: 1 << 30 });
    pager.begin();
    const f = pager.allocPage(PageType.Heap, 0);
    const id = f.pageId;
    pager.release(f);
    writeMarker(pager, id, 'v1');
    pager.commit();
    pager.checkpoint();
    for (let round = 0; round < 20; round++) {
      pager.begin();
      writeMarker(pager, id, 'v2-' + round);
      // Emulate crash mid-commit: write WAL records but tear before/at fsync.
      pager.commit();
      fs.crash('torn');
      pager = new Pager('/db', { openFile: fs.open, poolSize: 16, checkpointBytes: 1 << 30 });
      const m = readMarker(pager, id);
      // Either the whole commit survived or none of it did.
      expect(m === 'v1' || m === 'v2-' + round).toBe(true);
      if (m === 'v1') {
        pager.begin();
        writeMarker(pager, id, 'v1');
        pager.commit();
      } else {
        pager.begin();
        writeMarker(pager, id, 'v1');
        pager.commit();
        pager.checkpoint();
      }
    }
    pager.close();
  });

  it('evicts under pool pressure and freelist reuses pages', () => {
    const fs = new FaultFS();
    const pager = new Pager('/db', { openFile: fs.open, poolSize: 8 });
    pager.begin();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const f = pager.allocPage(PageType.Heap, 0);
      ids.push(f.pageId);
      pager.release(f);
      writeMarker(pager, f.pageId, 'p' + i);
    }
    pager.commit();
    pager.begin();
    for (let i = 0; i < 40; i++) pager.with(i + 100, () => {}); // churn: reads beyond EOF are zero pages
    pager.commit();
    expect(pager.stats.evictions).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) expect(readMarker(pager, ids[i]!)).toBe('p' + i);
    pager.begin();
    pager.freePage(ids[1]!);
    const f = pager.allocPage(PageType.Heap, 0);
    expect(f.pageId).toBe(ids[1]);
    pager.release(f);
    pager.commit();
    expect(pager.getMeta().freelistHead).toBe(0);
    pager.close();
  });

  it('spills uncommitted pages to the WAL instead of exhausting the pool', () => {
    const fs = new FaultFS();
    let pager = new Pager('/db', { openFile: fs.open, poolSize: 8, checkpointBytes: 1 << 30 });
    pager.begin();
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) {
      const f = pager.allocPage(PageType.Heap, 0);
      ids.push(f.pageId);
      pager.release(f);
      writeMarker(pager, f.pageId, 'p' + i);
    }
    expect(pager.stats.spills).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) expect(readMarker(pager, ids[i]!)).toBe('p' + i); // re-read from WAL
    pager.rollback();
    expect(pager.getMeta().pageCount).toBe(1);
    pager.begin();
    for (let i = 0; i < 40; i++) {
      const f = pager.allocPage(PageType.Heap, 0);
      pager.release(f);
      writeMarker(pager, f.pageId, 'q' + i);
    }
    pager.commit();
    fs.crash('drop');
    pager = new Pager('/db', { openFile: fs.open, poolSize: 8 });
    for (let i = 0; i < 40; i++) expect(readMarker(pager, ids[i]!)).toBe('q' + i);
    pager.close();
  });
});
