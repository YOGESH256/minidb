/**
 * Deciding HOW to run a SELECT.
 *
 * Input: the parsed statement. Output: a tree of executor nodes.
 * For each table: is there a WHERE / ON condition like `col = value` or
 * `col > value` on an indexed column, where `value` depends only on
 * constants or tables already to the left? Then Index Scan, else Seq Scan.
 * Remaining conditions become Filters as low in the tree as possible.
 * Joins are nested loops in FROM order. Then Sort, Limit, Project.
 * EXPLAIN prints this tree.
 */
import type { Expr, SelectStmt, TableRef } from './ast.js';
import type { Catalog, TableDef, IndexDef } from '../catalog.js';
import type { Pager } from '../storage/pager.js';
import { Heap } from '../storage/heap.js';
import { BTree } from '../storage/btree.js';
import { compareEncoded, TypeError_, type DataType } from '../types.js';
import { Scope, compile, conjuncts, andAll, type Compiled } from './expr.js';

/** Compile a predicate and insist it is boolean (PG: "argument of WHERE must be type boolean"). */
function compileBool(e: Expr, scope: Scope, what: string): Compiled {
  const c = compile(e, scope);
  if (c.type !== null && c.type !== 'BOOL') throw new TypeError_(`argument of ${what} must be type BOOL, not type ${c.type}`);
  return c;
}
import {
  type PlanNode,
  OneRowNode,
  SeqScanNode,
  IndexScanNode,
  FilterNode,
  NestedLoopNode,
  SortNode,
  LimitNode,
  ProjectNode,
  type IndexBounds,
} from './executor.js';

/**
 * Planner: left-deep nested-loop joins in FROM order; each table becomes a
 * Seq Scan or, when a conjunct constrains an indexed column by a constant or
 * by columns of tables already to the left, an Index Scan (PG's parameterized
 * index nested loop). Remaining conjuncts become Filters at the lowest level
 * where all their tables are available.
 */

export interface SelectPlan {
  root: ProjectNode;
  columns: string[];
}

export function openTree(pager: Pager, idx: IndexDef, keyType: DataType): BTree {
  return new BTree(pager, idx.metaPage, (a, b) => compareEncoded(keyType, a, b));
}

export function planSelect(stmt: SelectStmt, catalog: Catalog, pager: Pager): SelectPlan {
  const scope = new Scope();
  const tableRefs: TableRef[] = stmt.from ? [stmt.from, ...stmt.joins.map((j) => j.table)] : [];
  const defs: TableDef[] = [];
  for (const ref of tableRefs) {
    const t = catalog.mustGetTable(ref.name);
    scope.add(ref.alias ?? ref.name, t);
    defs.push(t);
  }
  if (tableRefs.length === 0 && stmt.joins.length > 0) throw new TypeError_('JOIN without FROM');

  // All conjuncts (WHERE + every INNER JOIN ON) with the set of tables each references.
  const preds = [...conjuncts(stmt.where), ...stmt.joins.flatMap((j) => conjuncts(j.on))].map((e) => ({ e, refs: scope.refs(e), used: false }));

  let root: PlanNode;
  if (tableRefs.length === 0) {
    root = new OneRowNode();
    const rest = preds.filter((p) => !p.used).map((p) => p.e);
    const w = andAll(rest);
    if (w) {
      for (const p of preds) p.used = true;
      root = new FilterNode(root, compileBool(w, scope, 'WHERE'), exprText(w));
    }
  } else {
    root = planScan(0, scope, defs, preds, pager);
    for (let i = 1; i < tableRefs.length; i++) {
      const inner = planScan(i, scope, defs, preds, pager);
      const joinPreds = preds.filter((p) => !p.used && [...p.refs].every((r) => r <= i) && p.refs.has(i));
      for (const p of joinPreds) p.used = true;
      const q = andAll(joinPreds.map((p) => p.e));
      const combined = subScope(scope, i + 1);
      root = new NestedLoopNode(root, inner, q ? compileBool(q, combined, 'JOIN/ON') : null, q ? exprText(q) : '');
    }
  }
  const leftovers = preds.filter((p) => !p.used).map((p) => p.e);
  if (leftovers.length) {
    const w = andAll(leftovers)!;
    root = new FilterNode(root, compileBool(w, scope, 'WHERE'), exprText(w));
  }

  // Select list is compiled before ORDER BY so ordinals and output aliases can refer to it.
  const exprs: Compiled[] = [];
  const columns: string[] = [];
  const aliases = new Map<string, number[]>();
  for (const item of stmt.columns) {
    if (item.kind === 'star') {
      const entries = item.table === undefined ? scope.entries : scope.entries.filter((e) => e.alias === item.table);
      if (item.table !== undefined && entries.length === 0) throw new TypeError_(`missing FROM-clause entry for table "${item.table}"`);
      if (entries.length === 0) throw new TypeError_('SELECT * with no tables specified is not valid');
      for (const e of entries) {
        e.table.columns.forEach((c, ci) => {
          const idx = e.offset + ci;
          exprs.push({ type: c.type, eval: (row) => row[idx]!, isConst: false, columnIndex: idx });
          columns.push(c.name);
        });
      }
    } else {
      exprs.push(compile(item.expr, scope));
      columns.push(item.alias ?? (item.expr.kind === 'column' ? item.expr.name : '?column?'));
      if (item.alias !== undefined) aliases.set(item.alias, [...(aliases.get(item.alias) ?? []), exprs.length - 1]);
    }
  }

  if (stmt.orderBy.length) {
    const keys = stmt.orderBy.map((o) => ({ expr: resolveOrderBy(o.expr, exprs, aliases, scope), desc: o.desc }));
    root = new SortNode(root, keys, stmt.orderBy.map((o) => exprText(o.expr) + (o.desc ? ' DESC' : '')).join(', '));
  }
  if (stmt.limit !== undefined || stmt.offset !== undefined) root = new LimitNode(root, stmt.limit, stmt.offset ?? 0);

  return { root: new ProjectNode(root, exprs, columns), columns };
}

/** PG rules: an integer literal is a 1-based select-list ordinal; a bare name matching an output alias refers to it; else a FROM-scope expression. */
function resolveOrderBy(e: Expr, exprs: Compiled[], aliases: Map<string, number[]>, scope: Scope): Compiled {
  if (e.kind === 'literal' && typeof e.value === 'number') {
    const n = e.value;
    if (!Number.isInteger(n) || n < 1 || n > exprs.length) throw new TypeError_(`ORDER BY position ${n} is not in select list`);
    return exprs[n - 1]!;
  }
  if (e.kind === 'literal') throw new TypeError_('non-integer constant in ORDER BY');
  if (e.kind === 'column' && e.table === undefined) {
    const hits = aliases.get(e.name);
    if (hits && hits.length > 1) throw new TypeError_(`ORDER BY "${e.name}" is ambiguous`);
    if (hits) return exprs[hits[0]!]!;
  }
  return compile(e, scope);
}

/** A scope containing only the first n entries (same offsets). */
function subScope(scope: Scope, n: number): Scope {
  const s = new Scope();
  for (const e of scope.entries.slice(0, n)) s.add(e.alias, e.table);
  return s;
}

/**
 * Plan the access path for table i. Predicates usable here: those whose refs
 * are ⊆ {0..i} and include i. Constant-or-outer bounds on an indexed column
 * become an Index Scan; other i-only predicates become a Filter under it.
 * Mixed predicates that were not consumed as bounds are left for the join.
 */
function planScan(i: number, scope: Scope, defs: TableDef[], preds: { e: Expr; refs: Set<number>; used: boolean }[], pager: Pager): PlanNode {
  const table = defs[i]!;
  const entry = scope.entries[i]!;
  const heap = new Heap(pager, table.rootPage);
  const types = table.columns.map((c) => c.type);
  const local = new Scope();
  local.add(entry.alias, table);
  const label = entry.alias === table.name ? table.name : `${table.name} ${entry.alias}`;
  // Parameter scope = every table to the left (the outer row layout).
  const outer = subScope(scope, i);

  const candidates = preds.filter((p) => !p.used && p.refs.has(i) && [...p.refs].every((r) => r <= i));

  // Choose an index: prefer unique equality, then equality, then a range.
  type Pred = (typeof candidates)[number];
  interface Choice {
    idx: IndexDef;
    bounds: IndexBounds;
    consumed: Pred[];
    score: number;
    text: string[];
  }
  let best: Choice | null = null;
  for (const idx of table.indexes) {
    const col = table.columns[idx.columnIndex]!;
    let lo: { c: Compiled; inc: boolean; p: Pred; t: string } | null = null;
    let hi: { c: Compiled; inc: boolean; p: Pred; t: string } | null = null;
    let eq: { c: Compiled; p: Pred; t: string } | null = null;
    for (const p of candidates) {
      const m = matchBound(p.e, i, idx.columnIndex, scope, entry.alias);
      if (!m) continue;
      // The bound side must reference only outer tables (or nothing).
      const otherRefs = scope.refs(m.other);
      if (otherRefs.has(i)) continue;
      const c = compile(m.other, outer);
      if (c.type !== null && c.type !== col.type) throw new TypeError_(`operator does not exist: ${col.type} ${m.op} ${c.type}`);
      const t = `${col.name} ${m.op} ${exprText(m.other)}`;
      if (m.op === '=') eq = eq ?? { c, p, t };
      else if (m.op === '>' || m.op === '>=') lo = lo ?? { c, inc: m.op === '>=', p, t };
      else hi = hi ?? { c, inc: m.op === '<=', p, t };
    }
    let cand: Choice | null = null;
    if (eq) cand = { idx, bounds: { lo: eq.c, hi: eq.c, loInclusive: true, hiInclusive: true }, consumed: [eq.p], score: idx.unique ? 3 : 2, text: [eq.t] };
    else if (lo || hi) {
      const bounds: IndexBounds = { loInclusive: lo?.inc ?? true, hiInclusive: hi?.inc ?? true };
      if (lo) bounds.lo = lo.c;
      if (hi) bounds.hi = hi.c;
      cand = { idx, bounds, consumed: [lo?.p, hi?.p].filter((x): x is Pred => !!x), score: lo && hi ? 1.5 : 1, text: [lo?.t, hi?.t].filter((x): x is string => !!x) };
    }
    if (cand && (!best || cand.score > best.score)) best = cand;
  }

  let node: PlanNode;
  if (best) {
    for (const p of best.consumed) p.used = true;
    const keyType = table.columns[best.idx.columnIndex]!.type;
    node = new IndexScanNode(heap, openTree(pager, best.idx, keyType), keyType, types, best.bounds, label, best.idx.name, best.text.join(' AND '));
  } else {
    node = new SeqScanNode(heap, types, label);
  }
  // Remaining predicates that touch only this table: filter right here.
  const localPreds = candidates.filter((p) => !p.used && p.refs.size === 1);
  if (localPreds.length) {
    for (const p of localPreds) p.used = true;
    const w = andAll(localPreds.map((p) => p.e))!;
    node = new FilterNode(node, compileBool(w, local, 'WHERE'), exprText(w));
  }
  return node;
}

/** Match `col op other` or `other op col` where col is column `ci` of scope entry `i`. */
function matchBound(e: Expr, i: number, ci: number, scope: Scope, alias: string): { op: '=' | '<' | '<=' | '>' | '>='; other: Expr } | null {
  if (e.kind !== 'binary') return null;
  if (!['=', '<', '<=', '>', '>='].includes(e.op)) return null;
  const isCol = (x: Expr): boolean => {
    if (x.kind !== 'column') return false;
    if (x.table !== undefined && x.table !== alias) return false;
    try {
      const r = scope.resolve(x.table, x.name);
      return scope.entries.indexOf(r.entry) === i && r.column === ci;
    } catch {
      return false;
    }
  };
  const op = e.op as '=' | '<' | '<=' | '>' | '>=';
  if (isCol(e.left)) return { op, other: e.right };
  if (isCol(e.right)) {
    const flip: Record<typeof op, typeof op> = { '=': '=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
    return { op: flip[op], other: e.left };
  }
  return null;
}

export function exprText(e: Expr): string {
  switch (e.kind) {
    case 'param':
      return e.name ? '$' + e.name : '?';
    case 'literal':
      return e.value === null ? 'NULL' : typeof e.value === 'string' ? `'${e.value.replace(/'/g, "''")}'` : String(e.value);
    case 'column':
      return e.table ? `${e.table}.${e.name}` : e.name;
    case 'binary':
      return `(${exprText(e.left)} ${e.op} ${exprText(e.right)})`;
    case 'not':
      return `NOT ${exprText(e.expr)}`;
    case 'neg':
      return `-${exprText(e.expr)}`;
    case 'isnull':
      return `${exprText(e.expr)} IS ${e.negated ? 'NOT ' : ''}NULL`;
  }
}
