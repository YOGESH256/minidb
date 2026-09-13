/**
 * The write-ahead log, in one sentence: before a page is written to the real
 * file, its full new contents go here, followed by a COMMIT marker and an
 * fsync; on startup everything up to the last COMMIT is replayed and the
 * rest is thrown away. See ladder/v2-wal.ts for the same idea in 150 lines.
 */
import { PAGE_SIZE, crc32 } from './page.js';
import type { FileIO } from './file-io.js';

/**
 * Redo-only write-ahead log with full-page images (SQLite-WAL style physical
 * logging, PG-style record framing).
 *
 * File: [header 16 B][record]*
 *   header: magic u32, version u32, reserved u64
 *   record: totLen u32 | type u8 | pageId u32 | payload | crc32 u32
 *           crc covers everything before the crc field.
 *
 * LSN = byte offset of the END of the record in this file (PG semantics).
 * Recovery replays page images only up to the last COMMIT record; a bad CRC
 * or short read ends the valid log.
 */

export const WAL_MAGIC = 0x4d444257; // 'WBDM'
export const WAL_VERSION = 1;
export const WAL_HEADER_SIZE = 16;
const REC_HEADER_SIZE = 4 + 1 + 4; // totLen, type, pageId
const REC_TRAILER_SIZE = 4; // crc
export const PAGE_IMAGE_RECORD_SIZE = REC_HEADER_SIZE + PAGE_SIZE + REC_TRAILER_SIZE;

export const enum WalRecordType {
  PageImage = 1,
  Commit = 2,
}

export interface WalRecord {
  lsn: bigint;
  type: WalRecordType;
  pageId: number;
  payload: Buffer;
}

export class Wal {
  private end: number; // next write offset == current end LSN
  private durable = 0; // end offset known to be fsynced

  constructor(private readonly file: FileIO) {
    const size = file.size();
    if (size < WAL_HEADER_SIZE) {
      const h = Buffer.alloc(WAL_HEADER_SIZE);
      h.writeUInt32LE(WAL_MAGIC, 0);
      h.writeUInt32LE(WAL_VERSION, 4);
      file.truncate(0);
      file.write(0, h);
      file.fsync();
      this.end = WAL_HEADER_SIZE;
    } else {
      const h = file.read(0, WAL_HEADER_SIZE);
      if (h.readUInt32LE(0) !== WAL_MAGIC) throw new Error('WAL: bad magic');
      if (h.readUInt32LE(4) !== WAL_VERSION) throw new Error('WAL: unsupported version');
      this.end = size; // validated lazily by scan()
    }
    this.durable = this.end;
  }

  get endLsn(): bigint {
    return BigInt(this.end);
  }
  get durableLsn(): bigint {
    return BigInt(this.durable);
  }

  appendPageImage(pageId: number, page: Buffer): bigint {
    if (page.length !== PAGE_SIZE) throw new Error('WAL: page image must be PAGE_SIZE');
    return this.append(WalRecordType.PageImage, pageId, page);
  }

  appendCommit(): bigint {
    return this.append(WalRecordType.Commit, 0, Buffer.alloc(0));
  }

  private append(type: WalRecordType, pageId: number, payload: Buffer): bigint {
    const totLen = REC_HEADER_SIZE + payload.length + REC_TRAILER_SIZE;
    const rec = Buffer.alloc(totLen);
    rec.writeUInt32LE(totLen, 0);
    rec.writeUInt8(type, 4);
    rec.writeUInt32LE(pageId, 5);
    payload.copy(rec, REC_HEADER_SIZE);
    rec.writeUInt32LE(crc32(rec.subarray(0, totLen - REC_TRAILER_SIZE)), totLen - REC_TRAILER_SIZE);
    this.file.write(this.end, rec);
    this.end += totLen;
    return BigInt(this.end);
  }

  fsync(): void {
    this.file.fsync();
    this.durable = this.end;
  }

  /**
   * Scan all records from the header forward. Stops at the first corrupt or
   * truncated record (the crash tail). Sets `end` to the last valid boundary.
   */
  scan(): WalRecord[] {
    const out: WalRecord[] = [];
    const size = this.file.size();
    let pos = WAL_HEADER_SIZE;
    while (pos + REC_HEADER_SIZE + REC_TRAILER_SIZE <= size) {
      const head = this.file.read(pos, REC_HEADER_SIZE);
      if (head.length < REC_HEADER_SIZE) break;
      const totLen = head.readUInt32LE(0);
      if (totLen < REC_HEADER_SIZE + REC_TRAILER_SIZE || pos + totLen > size) break;
      const rec = this.file.read(pos, totLen);
      if (rec.length !== totLen) break;
      const stored = rec.readUInt32LE(totLen - REC_TRAILER_SIZE);
      if (stored !== crc32(rec.subarray(0, totLen - REC_TRAILER_SIZE))) break;
      const type = rec.readUInt8(4) as WalRecordType;
      if (type !== WalRecordType.PageImage && type !== WalRecordType.Commit) break;
      pos += totLen;
      out.push({ lsn: BigInt(pos), type, pageId: rec.readUInt32LE(5), payload: rec.subarray(REC_HEADER_SIZE, totLen - REC_TRAILER_SIZE) });
    }
    this.end = pos;
    this.durable = pos;
    return out;
  }

  /** Read back a page image given the end-LSN its append returned (used for spilled pages). */
  readPageImage(endLsn: bigint): Buffer {
    const start = Number(endLsn) - PAGE_IMAGE_RECORD_SIZE;
    if (start < WAL_HEADER_SIZE || Number(endLsn) > this.end) throw new Error('WAL: page image out of range');
    const rec = this.file.read(start, PAGE_IMAGE_RECORD_SIZE);
    if (rec.length !== PAGE_IMAGE_RECORD_SIZE || rec.readUInt8(4) !== WalRecordType.PageImage) throw new Error('WAL: bad page image record');
    return Buffer.from(rec.subarray(REC_HEADER_SIZE, REC_HEADER_SIZE + PAGE_SIZE));
  }

  /**
   * Rewind to a previous end offset, discarding records appended after it
   * (a failed or rolled-back transaction). Made durable so the discarded
   * bytes can never be mistaken for a later transaction's records.
   */
  truncateTo(offset: number): void {
    if (offset < WAL_HEADER_SIZE || offset > this.end) throw new Error('WAL: bad truncate offset');
    if (offset === this.end) return;
    this.file.truncate(offset);
    this.file.fsync();
    this.end = offset;
    this.durable = Math.min(this.durable, offset);
  }

  /** Discard everything after the header (post-checkpoint). */
  reset(): void {
    this.file.truncate(WAL_HEADER_SIZE);
    this.file.fsync();
    this.end = WAL_HEADER_SIZE;
    this.durable = this.end;
  }

  size(): number {
    return this.end;
  }

  close(): void {
    this.file.close();
  }
}
