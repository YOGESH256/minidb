/**
 * v0 — the simplest thing that could be called a database.
 *
 *   rows live in an array
 *   save() writes the whole array as JSON
 *   select() walks every row
 *
 * It works. It is also what every "let's just use a JSON file" project is.
 * The test at the bottom of ladder.test.ts shows the two problems that the
 * rest of the ladder exists to solve:
 *
 *   1. every change rewrites the whole file  (v1 fixes this with pages)
 *   2. a crash mid-write corrupts everything  (v2 fixes this with a log)
 */
import type { FakeDisk } from './fake-disk.js';

export type Row = Record<string, number | string | boolean | null>;

export class ArrayDb {
  rows: Row[] = [];

  constructor(
    private readonly disk: FakeDisk,
    private readonly file: string,
  ) {
    const bytes = disk.read(file);
    if (bytes.length) this.rows = JSON.parse(bytes.toString('utf8')); // throws if the file is half-written
  }

  insert(row: Row): void {
    this.rows.push(row);
    this.save();
  }

  select(where: (r: Row) => boolean): Row[] {
    return this.rows.filter(where); // reads every row, always
  }

  private save(): void {
    const json = Buffer.from(JSON.stringify(this.rows));
    this.disk.truncate(this.file, 0);
    this.disk.write(this.file, 0, json); // the WHOLE file, every time
    this.disk.fsync(this.file);
  }
}
