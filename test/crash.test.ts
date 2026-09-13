import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/index.js';

/**
 * Real-disk crash test (SQLite crash.test shape): a child process commits
 * batches in a loop against a real file; we SIGKILL it at a random moment,
 * reopen, and check every batch is all-or-nothing. Repeated several rounds so
 * kills land during WAL appends, fsyncs, and checkpoints.
 */
function runChildFor(dbPath: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'crash-child.ts'), dbPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    let started = false;
    child.stdout.on('data', (d: Buffer) => {
      if (!started && d.toString().includes('ready')) {
        started = true;
        setTimeout(() => child.kill('SIGKILL'), ms);
      }
    });
    child.on('exit', () => resolve());
    child.on('error', reject);
  });
}

describe('crash recovery on a real file', () => {
  it('every committed batch is complete after repeated SIGKILLs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minidb-crash-'));
    const dbPath = path.join(dir, 'crash.db');
    let lastCount = 0;
    for (let round = 0; round < 6; round++) {
      await runChildFor(dbPath, 150 + Math.floor(Math.random() * 250));
      const db = new Database(dbPath);
      const rows = db.query('SELECT batch FROM log ORDER BY batch').rows.map((r) => r[0] as number);
      expect(rows.length % 10).toBe(0);
      const perBatch = new Map<number, number>();
      for (const b of rows) perBatch.set(b, (perBatch.get(b) ?? 0) + 1);
      for (const [b, n] of perBatch) expect(n, `batch ${b}`).toBe(10);
      // batches are contiguous from 0
      expect([...perBatch.keys()]).toEqual([...perBatch.keys()].map((_, i) => i));
      // index agrees with heap
      const viaIndex = db.query('SELECT id FROM log WHERE batch = 0').rows.length;
      expect(viaIndex).toBe(perBatch.size ? 10 : 0);
      expect(rows.length).toBeGreaterThanOrEqual(lastCount);
      lastCount = rows.length;
      db.close();
    }
    expect(lastCount).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);
});
