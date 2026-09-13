/**
 * A pretend disk for the ladder tests.
 *
 * Real disks have a cache: write() puts bytes in the cache, and only fsync()
 * forces them onto the platter. If the power dies before fsync, the cached
 * bytes are gone. This class models exactly that, so a test can "pull the
 * plug" and see what survived.
 */
export class FakeDisk {
  private durable = new Map<string, Buffer>(); // what is really on the platter
  private cache = new Map<string, Buffer>(); // what the OS has buffered
  /** Number of read() calls, so tests can show how many pages a query touched. */
  reads = 0;

  private get(name: string): Buffer {
    if (!this.cache.has(name)) this.cache.set(name, Buffer.from(this.durable.get(name) ?? Buffer.alloc(0)));
    return this.cache.get(name)!;
  }
  read(name: string, pos = 0, len?: number): Buffer {
    this.reads++;
    const b = this.get(name);
    return Buffer.from(b.subarray(pos, len === undefined ? b.length : pos + len));
  }
  write(name: string, pos: number, data: Buffer): void {
    const cur = this.get(name);
    const end = pos + data.length;
    const next = end > cur.length ? Buffer.concat([cur, Buffer.alloc(end - cur.length)]) : cur;
    data.copy(next, pos);
    this.cache.set(name, next);
  }
  size(name: string): number {
    return this.get(name).length;
  }
  truncate(name: string, len: number): void {
    this.cache.set(name, Buffer.from(this.get(name).subarray(0, len)));
  }
  fsync(name: string): void {
    this.durable.set(name, Buffer.from(this.get(name)));
  }
  /** Power cut: everything not fsynced is lost. */
  crash(): void {
    this.cache.clear();
  }
  /** Power cut in the middle of a write: only the first `keep` bytes of the unsynced part land. */
  crashTorn(name: string, keep: number): void {
    const cached = this.get(name);
    const old = this.durable.get(name) ?? Buffer.alloc(0);
    const torn = Buffer.from(cached);
    // bytes past `keep` revert to whatever was on the platter before (or zeros)
    for (let i = keep; i < torn.length; i++) torn[i] = i < old.length ? old[i]! : 0;
    this.durable.set(name, torn);
    this.cache.clear();
  }
}
