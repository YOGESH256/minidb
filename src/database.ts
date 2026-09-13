/**
 * The front door. `exec(sql)` parses, then runs each statement:
 *
 *   SELECT            → planner → executor → rows
 *   INSERT/UPDATE/DELETE → check constraints, write heap, maintain every index
 *   CREATE/DROP       → catalog
 *   BEGIN/COMMIT/ROLLBACK → pager
 *
 * Each statement is its own transaction unless BEGIN is active.
 */
import { Pager, type PagerOptions, type TraceEvent } from './storage/pager.js';
import { memoryFileSystem, getDefaultFileSystem, type FileSystem } from './storage/file-io.js';
import { PageType } from './storage/page.js';
import { Heap, type TID } from './storage/heap.js';
import { Catalog, CatalogError, type TableDef, type IndexDef } from './catalog.js';
import { parse } from './sql/parser.js';
import type { Stmt, SelectStmt, InsertStmt, UpdateStmt, DeleteStmt, Expr } from './sql/ast.js';
import { planSelect, openTree } from './sql/planner.js';
import { Scope, compile } from './sql/expr.js';
import { collect } from './sql/executor.js';
import { encodeTuple, decodeTuple, encodeValue, TypeError_, typeOfValue, type Value } from './types.js';

export interface QueryResult {
  command: string;
  columns: string[];
  rows: Value[][];
  rowCount: number;
}

export class ConstraintError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ConstraintError';
  }
}

export interface DatabaseOptions extends PagerOptions {
  /** Where files live. Defaults to real disk for Node (via src/index.js) or memory for ':memory:'. */
  fs?: FileSystem;
}

/** Positional (`?`) or named (`$name`) values for a statement. */
export type Params = readonly Value[] | Readonly<Record<string, Value>>;

/** A row as an object keyed by output column name. Duplicate names: last one wins. */
export type RowObject = Record<string, Value>;

/** better-sqlite3-shaped prepared statement. Parsing happens once; binding per call. */
export class Statement {
  constructor(
    private readonly db: Database,
    private readonly stmts: Stmt[],
    readonly source: string,
  ) {
    if (stmts.length !== 1) throw new TypeError_('prepare() expects exactly one statement');
  }
  private exec(params: Params): QueryResult {
    return this.db.runBound(this.stmts[0]!, params);
  }
  /** Run for its effect. Returns how many rows changed. */
  run(...params: Value[] | [Readonly<Record<string, Value>>]): { changes: number } {
    return { changes: this.exec(normalize(params)).rowCount };
  }
  /** First row as an object, or undefined. */
  get(...params: Value[] | [Readonly<Record<string, Value>>]): RowObject | undefined {
    const r = this.exec(normalize(params));
    return r.rows.length ? toObject(r.columns, r.rows[0]!) : undefined;
  }
  /** Every row as objects. */
  all(...params: Value[] | [Readonly<Record<string, Value>>]): RowObject[] {
    const r = this.exec(normalize(params));
    return r.rows.map((row) => toObject(r.columns, row));
  }
  /** Raw result: column names + arrays. */
  raw(...params: Value[] | [Readonly<Record<string, Value>>]): QueryResult {
    return this.exec(normalize(params));
  }
}

function normalize(args: Value[] | [Readonly<Record<string, Value>>]): Params {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object') return args[0] as Readonly<Record<string, Value>>;
  return args as Value[];
}

function toObject(columns: string[], row: Value[]): RowObject {
  const o: RowObject = {};
  columns.forEach((c, i) => (o[c] = row[i]!));
  return o;
}

/** Replace every `?` / `$name` in a statement with a literal. */
function bindParams(stmt: Stmt, params: Params): Stmt {
  const positional = Array.isArray(params) ? (params as readonly Value[]) : null;
  const named = positional ? null : (params as Readonly<Record<string, Value>>);
  let used = 0;
  const sub = (e: Expr): Expr => {
    switch (e.kind) {
      case 'param': {
        used++;
        if (e.name !== undefined) {
          if (!named || !(e.name in named)) throw new TypeError_(`missing value for parameter $${e.name}`);
          return { kind: 'literal', value: named[e.name]! };
        }
        if (!positional) throw new TypeError_('positional parameter ? given an object of named values');
        if (e.index >= positional.length) throw new TypeError_(`too few parameter values: need at least ${e.index + 1}`);
        return { kind: 'literal', value: positional[e.index]! };
      }
      case 'binary':
        return { ...e, left: sub(e.left), right: sub(e.right) };
      case 'not':
      case 'neg':
      case 'isnull':
        return { ...e, expr: sub(e.expr) };
      default:
        return e;
    }
  };
  const optional = <T extends Expr | undefined>(e: T): T => (e ? (sub(e) as T) : e);
  let out: Stmt;
  switch (stmt.kind) {
    case 'select':
      out = {
        ...stmt,
        columns: stmt.columns.map((c) => (c.kind === 'expr' ? { ...c, expr: sub(c.expr) } : c)),
        joins: stmt.joins.map((j) => ({ ...j, on: sub(j.on) })),
        orderBy: stmt.orderBy.map((o) => ({ ...o, expr: sub(o.expr) })),
        ...(stmt.where ? { where: sub(stmt.where) } : {}),
      };
      break;
    case 'explain':
      // The nested call does its own arity check; do not count again here.
      return { kind: 'explain', stmt: bindParams(stmt.stmt, params) as SelectStmt };
    case 'insert':
      out = { ...stmt, rows: stmt.rows.map((r) => r.map(sub)) };
      break;
    case 'update':
      out = { ...stmt, assignments: stmt.assignments.map((a) => ({ ...a, expr: sub(a.expr) })), ...(stmt.where ? { where: sub(stmt.where) } : {}) };
      break;
    case 'delete':
      out = { ...stmt, ...(stmt.where ? { where: sub(stmt.where) } : {}) };
      break;
    default:
      out = stmt;
  }
  void optional;
  if (positional && positional.length > used) throw new TypeError_(`too many parameter values: ${positional.length} given, ${used} used`);
  return out;
}

/**
 * Top-level facade. Statements run in autocommit mode unless BEGIN is active.
 * A statement error inside an explicit transaction leaves it in PG's
 * "aborted" state: further statements are rejected until ROLLBACK (COMMIT
 * also rolls back and reports ROLLBACK).
 */
export class Database {
  readonly pager: Pager;
  readonly catalog: Catalog;
  private explicitTxn = false;
  private readonly unlock: () => void;
  private readonly opts: DatabaseOptions;
  /** A statement failed inside BEGIN: only ROLLBACK (or COMMIT, which rolls back) is accepted. */
  private aborted = false;

  constructor(
    readonly path: string,
    opts: DatabaseOptions = {},
  ) {
    this.opts = opts;
    const fs = opts.fs ?? (path === ':memory:' ? memoryFileSystem() : opts.openFile ? null : getDefaultFileSystem());
    this.unlock = fs ? fs.lock(path) : () => {};
    try {
      this.pager = new Pager(path, fs ? { ...opts, openFile: fs.open } : opts);
      this.catalog = new Catalog(this.pager);
    } catch (e) {
      this.unlock();
      throw e;
    }
  }

  close(): void {
    this.pager.close();
    this.unlock();
  }

  // ------------------------------------------------------------ prepared statements + transactions

  /** Parse once, run many times with different values. */
  prepare(sql: string): Statement {
    return new Statement(this, parse(sql), sql);
  }

  /** Bind values then run one already-parsed statement. Used by Statement. */
  runBound(stmt: Stmt, params: Params): QueryResult {
    return this.runStatement(bindParams(stmt, params));
  }

  /**
   * Wrap a function so it runs inside BEGIN ... COMMIT; any throw rolls back
   * and is rethrown. Same shape as better-sqlite3's db.transaction(fn).
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      if (this.explicitTxn) throw new TypeError_('cannot start a transaction within a transaction');
      this.exec('BEGIN');
      try {
        const r = fn(...args);
        this.exec('COMMIT');
        return r;
      } catch (e) {
        if (this.explicitTxn) this.exec('ROLLBACK');
        throw e;
      }
    };
  }

  // ------------------------------------------------------------ introspection (the learning lab uses these)

  /**
   * Run SQL with the pager recording every page read, write, WAL record,
   * fsync and index descent. Returns the events alongside the results.
   */
  trace(sql: string, params: Params = []): { results: QueryResult[]; events: TraceEvent[]; summary: TraceSummary } {
    this.pager.startTrace();
    let results: QueryResult[];
    try {
      results = parse(sql).map((s) => this.runStatement(bindParams(s, params)));
    } finally {
      // fall through: events are collected below even on error
    }
    const events = this.pager.stopTrace();
    return { results, events, summary: summarize(events) };
  }

  /** What every page in the file currently is. */
  pageMap(): PageInfo[] {
    const meta = this.pager.getMeta();
    const owners = new Map<number, string>();
    for (const t of this.catalog.allTables()) {
      owners.set(t.rootPage, t.name);
      for (const idx of t.indexes) owners.set(idx.metaPage, idx.name);
    }
    const out: PageInfo[] = [];
    for (let i = 0; i < meta.pageCount; i++) {
      const type = this.pager.with(i, (f) => f.page.type);
      const kind: PageKind = PAGE_KIND[type] ?? 'unknown';
      const owner = owners.get(i);
      out.push(owner !== undefined ? { page: i, kind, owner } : { page: i, kind });
    }
    return out;
  }

  get inTransaction(): boolean {
    return this.explicitTxn;
  }

  /** Parse and run every statement; returns one result per statement. */
  exec(sql: string): QueryResult[] {
    return parse(sql).map((s) => this.runStatement(s));
  }

  /** Convenience: run one statement and return its result. */
  query(sql: string): QueryResult {
    const stmts = parse(sql);
    if (stmts.length !== 1) throw new TypeError_('query() expects exactly one statement');
    return this.runStatement(stmts[0]!);
  }

  private runStatement(stmt: Stmt): QueryResult {
    switch (stmt.kind) {
      case 'begin':
        if (this.explicitTxn) throw new TypeError_('there is already a transaction in progress');
        this.pager.begin();
        this.explicitTxn = true;
        return result('BEGIN');
      case 'commit': {
        if (!this.explicitTxn) throw new TypeError_('there is no transaction in progress');
        if (this.aborted) {
          this.endTxn(false);
          return result('ROLLBACK'); // PG: COMMIT of an aborted transaction reports ROLLBACK
        }
        this.endTxn(true);
        return result('COMMIT');
      }
      case 'rollback':
        if (!this.explicitTxn) throw new TypeError_('there is no transaction in progress');
        this.endTxn(false);
        return result('ROLLBACK');
      case 'checkpoint':
        if (this.explicitTxn) throw new TypeError_('CHECKPOINT cannot run inside a transaction block');
        this.pager.checkpoint();
        return result('CHECKPOINT');
    }
    if (this.explicitTxn) {
      if (this.aborted) throw new TypeError_('current transaction is aborted, commands ignored until end of transaction block');
      try {
        return this.dispatch(stmt);
      } catch (e) {
        // Keep the transaction open but poisoned; its partial effects live only
        // in the buffer pool and are discarded by the eventual rollback.
        this.aborted = true;
        throw e;
      }
    }
    this.pager.begin();
    try {
      const r = this.dispatch(stmt);
      this.pager.commit();
      return r;
    } catch (e) {
      this.pager.rollback();
      this.catalog.load();
      throw e;
    }
  }

  /** Finish the explicit transaction. The facade flag is cleared only once the pager is back in a clean state. */
  private endTxn(commit: boolean): void {
    try {
      if (commit) this.pager.commit();
      else this.pager.rollback();
    } catch (e) {
      if (this.pager.inTxn) this.pager.rollback();
      this.catalog.load();
      throw e;
    } finally {
      this.explicitTxn = false;
      this.aborted = false;
    }
    if (!commit) this.catalog.load();
  }

  private dispatch(stmt: Stmt): QueryResult {
    switch (stmt.kind) {
      case 'select':
        return this.select(stmt);
      case 'explain': {
        const plan = planSelect(stmt.stmt, this.catalog, this.pager);
        return { command: 'EXPLAIN', columns: ['QUERY PLAN'], rows: plan.root.explain().map((l) => [l]), rowCount: 0 };
      }
      case 'insert':
        return this.insert(stmt);
      case 'update':
        return this.update(stmt);
      case 'delete':
        return this.delete(stmt);
      case 'create_table':
        this.catalog.createTable(stmt.name, stmt.columns);
        return result('CREATE TABLE');
      case 'create_index': {
        const t = this.catalog.mustGetTable(stmt.table);
        const idx = this.catalog.createIndex(stmt.name, stmt.table, stmt.column, stmt.unique);
        this.buildIndex(t, idx);
        return result('CREATE INDEX');
      }
      case 'drop':
        return this.drop(stmt.what, stmt.name, stmt.ifExists);
      default:
        throw new TypeError_('unsupported statement');
    }
  }

  // ------------------------------------------------------------ SELECT

  private select(stmt: SelectStmt): QueryResult {
    const plan = planSelect(stmt, this.catalog, this.pager);
    const rows = collect(plan.root).map((r) => r.v);
    return { command: 'SELECT', columns: plan.columns, rows, rowCount: rows.length };
  }

  // ------------------------------------------------------------ INSERT

  private insert(stmt: InsertStmt): QueryResult {
    const t = this.userTable(stmt.table);
    const targets = stmt.columns
      ? stmt.columns.map((name) => {
          const ci = t.columns.findIndex((c) => c.name === name);
          if (ci < 0) throw new TypeError_(`column "${name}" of relation "${t.name}" does not exist`);
          return ci;
        })
      : t.columns.map((_, i) => i);
    if (new Set(targets).size !== targets.length) throw new TypeError_('column specified more than once');
    const heap = new Heap(this.pager, t.rootPage);
    const empty = new Scope();
    let n = 0;
    for (const exprs of stmt.rows) {
      if (exprs.length !== targets.length) throw new TypeError_(`INSERT has ${exprs.length} expressions but ${targets.length} target columns`);
      const values: Value[] = t.columns.map(() => null);
      exprs.forEach((e, i) => {
        const c = compile(e, empty);
        const ci = targets[i]!;
        const col = t.columns[ci]!;
        if (c.type !== null && c.type !== col.type)
          throw new TypeError_(`column "${col.name}" is of type ${col.type} but expression is of type ${c.type}`);
        values[ci] = c.eval([]);
      });
      this.writeRow(t, heap, values, null);
      n++;
    }
    return { ...result('INSERT'), rowCount: n };
  }

  // ------------------------------------------------------------ UPDATE / DELETE

  private update(stmt: UpdateStmt): QueryResult {
    const t = this.userTable(stmt.table);
    const scope = new Scope();
    scope.add(t.name, t);
    const sets = stmt.assignments.map((a) => {
      const ci = t.columns.findIndex((c) => c.name === a.column);
      if (ci < 0) throw new TypeError_(`column "${a.column}" of relation "${t.name}" does not exist`);
      const c = compile(a.expr, scope);
      const col = t.columns[ci]!;
      if (c.type !== null && c.type !== col.type)
        throw new TypeError_(`column "${col.name}" is of type ${col.type} but expression is of type ${c.type}`);
      return { ci, c };
    });
    if (new Set(sets.map((s) => s.ci)).size !== sets.length) throw new TypeError_('multiple assignments to same column');
    // Collect first, then write (Halloween problem: an index scan must not
    // see rows it just moved).
    const targets = this.scanForDml(t, stmt.where);
    const heap = new Heap(this.pager, t.rootPage);
    for (const row of targets) {
      const values = [...row.v];
      for (const s of sets) values[s.ci] = s.c.eval(row.v);
      this.writeRow(t, heap, values, { tid: row.tid!, old: row.v });
    }
    return { ...result('UPDATE'), rowCount: targets.length };
  }

  private delete(stmt: DeleteStmt): QueryResult {
    const t = this.userTable(stmt.table);
    const targets = this.scanForDml(t, stmt.where);
    const heap = new Heap(this.pager, t.rootPage);
    for (const row of targets) {
      this.removeIndexEntries(t, row.v, row.tid!);
      heap.delete(row.tid!);
    }
    return { ...result('DELETE'), rowCount: targets.length };
  }

  private scanForDml(t: TableDef, where: Expr | undefined): { v: Value[]; tid: TID | null }[] {
    const sel: SelectStmt = { kind: 'select', columns: [{ kind: 'star' }], from: { name: t.name }, joins: [], orderBy: [] };
    if (where) sel.where = where;
    const plan = planSelect(sel, this.catalog, this.pager);
    return collect(plan.root);
  }

  // ------------------------------------------------------------ row + index maintenance

  /** Insert (prev == null) or update a row, enforcing NOT NULL and UNIQUE. */
  private writeRow(t: TableDef, heap: Heap, values: Value[], prev: { tid: TID; old: Value[] } | null): void {
    t.columns.forEach((col, i) => {
      const v = values[i]!;
      if (v === null) {
        if (col.notNull) throw new ConstraintError(`null value in column "${col.name}" of relation "${t.name}" violates not-null constraint`);
        return;
      }
      if (typeOfValue(v) !== col.type) throw new TypeError_(`column "${col.name}" is of type ${col.type}`);
    });
    const changed = (idx: IndexDef) => !prev || prev.old[idx.columnIndex] !== values[idx.columnIndex];
    for (const idx of t.indexes) {
      if (!idx.unique || !changed(idx)) continue;
      const v = values[idx.columnIndex]!;
      if (v === null) continue;
      const type = t.columns[idx.columnIndex]!.type;
      for (const tid of openTree(this.pager, idx, type).lookup(encodeValue(type, v))) {
        if (prev && tid.page === prev.tid.page && tid.slot === prev.tid.slot) continue;
        throw new ConstraintError(`duplicate key value violates unique constraint "${idx.name}"`);
      }
    }
    const data = encodeTuple(
      t.columns.map((c) => c.type),
      values,
    );
    let tid: TID;
    if (prev) {
      tid = heap.update(prev.tid, data);
      const moved = tid.page !== prev.tid.page || tid.slot !== prev.tid.slot;
      for (const idx of t.indexes) {
        // An entry needs rewriting only if its key changed or the row moved to a new TID.
        if (!moved && !changed(idx)) continue;
        const type = t.columns[idx.columnIndex]!.type;
        const oldV = prev.old[idx.columnIndex]!;
        if (oldV !== null) openTree(this.pager, idx, type).remove(encodeValue(type, oldV), prev.tid);
        const v = values[idx.columnIndex]!;
        if (v !== null) openTree(this.pager, idx, type).insert(encodeValue(type, v), tid);
      }
      return;
    }
    tid = heap.insert(data);
    for (const idx of t.indexes) {
      const v = values[idx.columnIndex]!;
      if (v === null) continue; // NULLs are not indexed
      const type = t.columns[idx.columnIndex]!.type;
      openTree(this.pager, idx, type).insert(encodeValue(type, v), tid);
    }
  }

  private removeIndexEntries(t: TableDef, values: Value[], tid: TID): void {
    for (const idx of t.indexes) {
      const v = values[idx.columnIndex]!;
      if (v === null) continue;
      const type = t.columns[idx.columnIndex]!.type;
      openTree(this.pager, idx, type).remove(encodeValue(type, v), tid);
    }
  }

  private buildIndex(t: TableDef, idx: IndexDef): void {
    const type = t.columns[idx.columnIndex]!.type;
    const tree = openTree(this.pager, idx, type);
    const heap = new Heap(this.pager, t.rootPage);
    const seen = new Set<string>();
    const types = t.columns.map((c) => c.type);
    for (const r of heap.scan()) {
      const v = decodeTuple(types, r.data)[idx.columnIndex]!;
      if (v === null) continue;
      if (idx.unique) {
        const k = String(v);
        if (seen.has(k)) throw new ConstraintError(`could not create unique index "${idx.name}": key (${idx.column})=(${k}) is duplicated`);
        seen.add(k);
      }
      tree.insert(encodeValue(type, v), r.tid);
    }
  }

  // ------------------------------------------------------------ DROP

  private drop(what: 'table' | 'index', name: string, ifExists: boolean): QueryResult {
    if (what === 'table') {
      if (!this.catalog.getTable(name)) {
        if (ifExists) return result('DROP TABLE');
        throw new CatalogError(`table "${name}" does not exist`);
      }
      const t = this.catalog.dropTable(name);
      for (const idx of t.indexes) openTree(this.pager, idx, t.columns[idx.columnIndex]!.type).drop();
      new Heap(this.pager, t.rootPage).drop();
      return result('DROP TABLE');
    }
    if (!this.catalog.findIndex(name)) {
      if (ifExists) return result('DROP INDEX');
      throw new CatalogError(`index "${name}" does not exist`);
    }
    const { table, index } = this.catalog.dropIndex(name);
    openTree(this.pager, index, table.columns[index.columnIndex]!.type).drop();
    return result('DROP INDEX');
  }

  private userTable(name: string): TableDef {
    const t = this.catalog.mustGetTable(name);
    if (t.system) throw new CatalogError(`cannot modify system table "${name}"`);
    return t;
  }
}

export type PageKind = 'meta' | 'heap' | 'btree-meta' | 'btree' | 'free' | 'unknown';
export interface PageInfo {
  page: number;
  kind: PageKind;
  /** Table or index that starts on this page, when it is a root/meta page. */
  owner?: string;
}
const PAGE_KIND: Record<number, PageKind> = { [PageType.Meta]: 'meta', [PageType.Heap]: 'heap', [PageType.BTreeMeta]: 'btree-meta', [PageType.BTreeNode]: 'btree', [PageType.Free]: 'free' };

export interface TraceSummary {
  pagesRead: number;
  distinctPagesRead: number;
  pagesWritten: number;
  walRecords: number;
  fsyncs: number;
  indexHops: number;
}

function summarize(events: TraceEvent[]): TraceSummary {
  const read = events.filter((e) => e.op === 'read');
  return {
    pagesRead: read.length,
    distinctPagesRead: new Set(read.map((e) => e.page)).size,
    pagesWritten: events.filter((e) => e.op === 'dirty').length,
    walRecords: events.filter((e) => e.op === 'wal').length,
    fsyncs: events.filter((e) => e.op === 'fsync').length,
    indexHops: events.filter((e) => e.op === 'index').length,
  };
}

function result(command: string): QueryResult {
  return { command, columns: [], rows: [], rowCount: 0 };
}
