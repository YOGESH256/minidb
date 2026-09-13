/**
 * The nodes that actually run a query ("Volcano" model, same as Postgres).
 *
 *   Project        each node has next(); calling it on the top pulls one
 *     └─ Sort      row through the whole chain. Nothing is materialised
 *         └─ Filter   except where a node must (Sort).
 *             └─ Nested Loop
 *                 ├─ Seq Scan on a
 *                 └─ Index Scan on b   ← re-opened for every row of a, with
 *                                        that row available as parameters
 */
import type { TID } from '../storage/heap.js';
import { Heap } from '../storage/heap.js';
import { BTree } from '../storage/btree.js';
import { decodeTuple, encodeValue, compareValues, typeOfValue, TypeError_, type DataType, type Value } from '../types.js';
import type { Compiled } from './expr.js';

/**
 * Volcano executor: every node is open() / next() / close(). next() returns
 * one Row or null when exhausted. Parameterized nodes (inner side of a
 * nested loop) receive the current outer row via setParam() before open().
 */

export interface Row {
  v: Value[];
  tid: TID | null;
}

export interface PlanNode {
  open(): void;
  next(): Row | null;
  close(): void;
  setParam(row: readonly Value[]): void;
  explain(): string[];
}

const EMPTY: readonly Value[] = [];

export class OneRowNode implements PlanNode {
  private done = false;
  open(): void {
    this.done = false;
  }
  next(): Row | null {
    if (this.done) return null;
    this.done = true;
    return { v: [], tid: null };
  }
  close(): void {}
  setParam(): void {}
  explain(): string[] {
    return ['Result'];
  }
}

export class SeqScanNode implements PlanNode {
  private it: IterableIterator<{ tid: TID; data: Buffer }> | null = null;
  constructor(
    private readonly heap: Heap,
    private readonly types: readonly DataType[],
    private readonly label: string,
  ) {}
  open(): void {
    this.it = this.heap.scan();
  }
  next(): Row | null {
    const r = this.it!.next();
    if (r.done) return null;
    return { v: decodeTuple(this.types, r.value.data), tid: r.value.tid };
  }
  close(): void {
    this.it = null;
  }
  setParam(): void {}
  explain(): string[] {
    return [`Seq Scan on ${this.label}`];
  }
}

export interface IndexBounds {
  lo?: Compiled;
  loInclusive: boolean;
  hi?: Compiled;
  hiInclusive: boolean;
}

export class IndexScanNode implements PlanNode {
  private it: IterableIterator<{ key: Buffer; tid: TID }> | null = null;
  private param: readonly Value[] = EMPTY;
  constructor(
    private readonly heap: Heap,
    private readonly tree: BTree,
    private readonly keyType: DataType,
    private readonly types: readonly DataType[],
    private readonly bounds: IndexBounds,
    private readonly label: string,
    private readonly indexName: string,
    private readonly condText: string,
  ) {}
  setParam(row: readonly Value[]): void {
    this.param = row;
  }
  open(): void {
    const lo = this.bounds.lo ? this.bounds.lo.eval(this.param) : undefined;
    const hi = this.bounds.hi ? this.bounds.hi.eval(this.param) : undefined;
    // A NULL bound can never match anything (col = NULL is never true).
    if (lo === null || hi === null) {
      this.it = [][Symbol.iterator]();
      return;
    }
    // A parameter's type is only known now: refuse a mismatch like the binder would.
    for (const b of [lo, hi]) {
      if (b !== undefined && typeOfValue(b) !== this.keyType) throw new TypeError_(`operator does not exist: ${this.keyType} = ${typeOfValue(b)}`);
    }
    const opts: Parameters<BTree['scan']>[0] = { loInclusive: this.bounds.loInclusive, hiInclusive: this.bounds.hiInclusive };
    if (lo !== undefined) opts.lo = encodeValue(this.keyType, lo);
    if (hi !== undefined) opts.hi = encodeValue(this.keyType, hi);
    this.it = this.tree.scan(opts);
  }
  next(): Row | null {
    for (;;) {
      const r = this.it!.next();
      if (r.done) return null;
      const data = this.heap.get(r.value.tid);
      if (!data) continue; // stale entry: should not happen with synchronous index maintenance
      return { v: decodeTuple(this.types, data), tid: r.value.tid };
    }
  }
  close(): void {
    this.it = null;
  }
  explain(): string[] {
    return [`Index Scan using ${this.indexName} on ${this.label}`, `  Index Cond: ${this.condText}`];
  }
}

export class FilterNode implements PlanNode {
  constructor(
    private readonly child: PlanNode,
    private readonly pred: Compiled,
    private readonly text: string,
  ) {}
  open(): void {
    this.child.open();
  }
  next(): Row | null {
    for (;;) {
      const r = this.child.next();
      if (!r) return null;
      if (this.pred.eval(r.v) === true) return r;
    }
  }
  close(): void {
    this.child.close();
  }
  setParam(row: readonly Value[]): void {
    this.child.setParam(row);
  }
  explain(): string[] {
    const inner = this.child.explain();
    return [inner[0]!, `  Filter: ${this.text}`, ...inner.slice(1)];
  }
}

export class NestedLoopNode implements PlanNode {
  private outerRow: Row | null = null;
  private innerOpen = false;
  private param: readonly Value[] = EMPTY;
  constructor(
    private readonly outer: PlanNode,
    private readonly inner: PlanNode,
    private readonly joinQual: Compiled | null,
    private readonly qualText: string,
  ) {}
  setParam(row: readonly Value[]): void {
    this.param = row;
  }
  open(): void {
    this.outer.setParam(this.param);
    this.outer.open();
    this.outerRow = null;
    this.innerOpen = false;
  }
  next(): Row | null {
    for (;;) {
      if (!this.outerRow) {
        this.outerRow = this.outer.next();
        if (!this.outerRow) return null;
        this.inner.setParam([...this.param, ...this.outerRow.v]);
        this.inner.open();
        this.innerOpen = true;
      }
      const ir = this.inner.next();
      if (!ir) {
        this.inner.close();
        this.innerOpen = false;
        this.outerRow = null;
        continue;
      }
      const combined = { v: [...this.outerRow.v, ...ir.v], tid: null };
      if (this.joinQual && this.joinQual.eval(combined.v) !== true) continue;
      return combined;
    }
  }
  close(): void {
    if (this.innerOpen) this.inner.close();
    this.outer.close();
  }
  explain(): string[] {
    const lines = ['Nested Loop'];
    if (this.joinQual) lines.push(`  Join Filter: ${this.qualText}`);
    lines.push(...indentChild(this.outer.explain()), ...indentChild(this.inner.explain()));
    return lines;
  }
}

export function indentChild(lines: string[]): string[] {
  return lines.map((l, i) => (i === 0 ? '  -> ' + l : '     ' + l));
}

export class SortNode implements PlanNode {
  private rows: Row[] = [];
  private i = 0;
  private param: readonly Value[] = EMPTY;
  constructor(
    private readonly child: PlanNode,
    private readonly keys: { expr: Compiled; desc: boolean }[],
    private readonly text: string,
  ) {}
  setParam(row: readonly Value[]): void {
    this.param = row;
  }
  open(): void {
    this.child.setParam(this.param);
    this.child.open();
    this.rows = [];
    let r: Row | null;
    while ((r = this.child.next())) this.rows.push(r);
    this.child.close();
    const keyed = this.rows.map((row) => ({ row, k: this.keys.map((k) => k.expr.eval(row.v)) }));
    keyed.sort((a, b) => {
      for (let i = 0; i < this.keys.length; i++) {
        const k = this.keys[i]!;
        const x = a.k[i]!;
        const y = b.k[i]!;
        // NULL sorts as larger than every value: NULLS LAST for ASC, NULLS FIRST for DESC (PG).
        let c: number;
        if (x === null && y === null) c = 0;
        else if (x === null) c = 1;
        else if (y === null) c = -1;
        else c = compareValues(k.expr.type ?? 'INT', x, y);
        if (k.desc) c = -c;
        if (c !== 0) return c;
      }
      return 0;
    });
    this.rows = keyed.map((k) => k.row);
    this.i = 0;
  }
  next(): Row | null {
    return this.i < this.rows.length ? this.rows[this.i++]! : null;
  }
  close(): void {
    this.rows = [];
  }
  explain(): string[] {
    return [`Sort`, `  Sort Key: ${this.text}`, ...indentChild(this.child.explain())];
  }
}

export class LimitNode implements PlanNode {
  private seen = 0;
  private emitted = 0;
  constructor(
    private readonly child: PlanNode,
    private readonly limit: number | undefined,
    private readonly offset: number,
  ) {}
  setParam(row: readonly Value[]): void {
    this.child.setParam(row);
  }
  open(): void {
    this.child.open();
    this.seen = 0;
    this.emitted = 0;
  }
  next(): Row | null {
    if (this.limit !== undefined && this.emitted >= this.limit) return null;
    for (;;) {
      const r = this.child.next();
      if (!r) return null;
      if (this.seen++ < this.offset) continue;
      this.emitted++;
      return r;
    }
  }
  close(): void {
    this.child.close();
  }
  explain(): string[] {
    const head = this.limit !== undefined ? `Limit ${this.limit}${this.offset ? ` Offset ${this.offset}` : ''}` : `Offset ${this.offset}`;
    return [head, ...indentChild(this.child.explain())];
  }
}

export class ProjectNode implements PlanNode {
  constructor(
    private readonly child: PlanNode,
    private readonly exprs: Compiled[],
    readonly names: string[],
  ) {}
  setParam(row: readonly Value[]): void {
    this.child.setParam(row);
  }
  open(): void {
    this.child.open();
  }
  next(): Row | null {
    const r = this.child.next();
    if (!r) return null;
    return { v: this.exprs.map((e) => e.eval(r.v)), tid: r.tid };
  }
  close(): void {
    this.child.close();
  }
  explain(): string[] {
    return this.child.explain();
  }
}

/** Drain a plan into an array. */
export function collect(node: PlanNode): Row[] {
  node.open();
  const out: Row[] = [];
  try {
    let r: Row | null;
    while ((r = node.next())) out.push(r);
  } finally {
    node.close();
  }
  return out;
}
