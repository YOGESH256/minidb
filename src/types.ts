/**
 * Values and their bytes.
 *
 * Three types (INT, TEXT, BOOL) plus NULL. A row on disk is:
 *
 *   [null bitmap: 1 bit per column] [value] [value] [value] ...
 *      INT  → 8 bytes, little-endian
 *      TEXT → 4-byte length + UTF-8 bytes
 *      BOOL → 1 byte
 *
 * compareValues is the single definition of ordering (TEXT compares raw
 * bytes, never a locale), so indexes and ORDER BY can never disagree.
 */
/** Value model + on-disk encoding. Strict types, PG-style (no cross-type coercion). */

export type DataType = 'INT' | 'TEXT' | 'BOOL';
export type Value = number | string | boolean | null;

export const DATA_TYPES: readonly DataType[] = ['INT', 'TEXT', 'BOOL'];

export function isDataType(s: string): s is DataType {
  return (DATA_TYPES as readonly string[]).includes(s);
}

export class TypeError_ extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TypeError';
  }
}

export function typeOfValue(v: Value): DataType | null {
  if (v === null) return null;
  if (typeof v === 'number') return 'INT';
  if (typeof v === 'string') return 'TEXT';
  return 'BOOL';
}

export function checkInt(n: number): number {
  if (!Number.isSafeInteger(n)) throw new TypeError_(`integer out of range: ${n}`);
  return n;
}

/** Byte-wise UTF-8 comparison (PG "C" collation / SQLite BINARY). */
export function compareText(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Compare two non-null values of the same type. */
export function compareValues(type: DataType, a: Value, b: Value): number {
  switch (type) {
    case 'INT':
      return (a as number) < (b as number) ? -1 : a === b ? 0 : 1;
    case 'TEXT':
      return compareText(a as string, b as string);
    case 'BOOL':
      return a === b ? 0 : a === false ? -1 : 1;
  }
}

// ---- single-value encoding (used for index keys) ----

export function encodeValue(type: DataType, v: Value): Buffer {
  if (v === null) throw new TypeError_('cannot encode NULL');
  switch (type) {
    case 'INT': {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(checkInt(v as number)));
      return b;
    }
    case 'TEXT': {
      const s = Buffer.from(v as string, 'utf8');
      const b = Buffer.alloc(4 + s.length);
      b.writeUInt32LE(s.length, 0);
      s.copy(b, 4);
      return b;
    }
    case 'BOOL':
      return Buffer.from([v ? 1 : 0]);
  }
}

export function decodeValue(type: DataType, buf: Buffer, off: number): { value: Value; next: number } {
  switch (type) {
    case 'INT':
      return { value: Number(buf.readBigInt64LE(off)), next: off + 8 };
    case 'TEXT': {
      const len = buf.readUInt32LE(off);
      return { value: buf.toString('utf8', off + 4, off + 4 + len), next: off + 4 + len };
    }
    case 'BOOL':
      return { value: buf.readUInt8(off) === 1, next: off + 1 };
  }
}

/** Compare two encoded keys of the same type. */
export function compareEncoded(type: DataType, a: Buffer, b: Buffer): number {
  switch (type) {
    case 'INT': {
      const x = a.readBigInt64LE(0);
      const y = b.readBigInt64LE(0);
      return x < y ? -1 : x === y ? 0 : 1;
    }
    case 'TEXT':
      return Buffer.compare(a.subarray(4), b.subarray(4));
    case 'BOOL':
      return a[0]! - b[0]!;
  }
}

// ---- tuple encoding (heap rows): null bitmap + values ----

export function encodeTuple(types: readonly DataType[], values: readonly Value[]): Buffer {
  if (values.length !== types.length) throw new Error('tuple arity mismatch');
  const bitmapLen = Math.ceil(types.length / 8);
  const parts: Buffer[] = [];
  const bitmap = Buffer.alloc(bitmapLen);
  for (let i = 0; i < types.length; i++) {
    const v = values[i]!;
    if (v === null) {
      bitmap[i >> 3]! |= 1 << (i & 7);
      continue;
    }
    parts.push(encodeValue(types[i]!, v));
  }
  return Buffer.concat([bitmap, ...parts]);
}

export function decodeTuple(types: readonly DataType[], buf: Buffer): Value[] {
  const bitmapLen = Math.ceil(types.length / 8);
  const out: Value[] = new Array(types.length);
  let off = bitmapLen;
  for (let i = 0; i < types.length; i++) {
    if (buf[i >> 3]! & (1 << (i & 7))) {
      out[i] = null;
      continue;
    }
    const r = decodeValue(types[i]!, buf, off);
    out[i] = r.value;
    off = r.next;
  }
  return out;
}

export function formatValue(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return v;
  return String(v);
}
