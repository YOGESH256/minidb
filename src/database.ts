/**
 * The front door. `exec(sql)` parses, then runs each statement:
 *
 *   SELECT            → planner → executor → rows
 *   INSERT/UPDATE/DELETE → check constraints, write heap, maintain every index
 *   CREATE/DROP       → catalog
 *   BEGIN/COMMIT/ROLLBACK → pager
 *
 * Each statement is its own transaction unless BEGIN is active.
 * prepare() compiles a statement once; parameters are read from a slot at
 * run time, so the plan is reused across runs (rebuilt if the schema changes).
 */
import { Pager, type PagerOptions, type TraceEvent } from './storage/pager.js';
import { memoryFileSystem, getDefaultFileSystem, type FileSystem } from './storage/file-io.js';
import { PageType } from './storage/page.js';
import { Heap, type TID } from './storage/heap.js';
import { Catalog, CatalogError, SYS_CHANGES, SYS_CHANGES_COLS, type TableDef, type IndexDef } from './catalog.js';
import { parse } from './sql/parser.js';
import type { Stmt, SelectStmt, InsertStmt, UpdateStmt, DeleteStmt, Expr } from './sql/ast.js';
import { planSelect, openTree } from './sql/planner.js';
import { Scope, compile, type ParamSlot } from './sql/expr.js';
import { collect, type PlanNode } from './sql/executor.js';
import { encodeTuple, decodeTuple, encodeValue, decodeValue, compareValues, TypeError_, typeOfValue, type Value } from './types.js';

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
  /**
   * Record a receipt for every changed row (what changed, in which transaction,
   * from which previous values) in the same transaction as the change. Enables
   * changes(), history() and undo(). Off by default: it costs one extra heap
   * insert per changed row.
   */
  history?: boolean;
}

/** One changed row, as recorded in `__changes`. */
export interface ChangeRecord {
  txn: number;
  seq: number;
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Primary-key value of the row, or null if the table has no primary key. */
  key: Value;
  before: Value[] | null;
  after: Value[] | null;
}

export type WatchCallback = (rows: RowObject[]) => void;

export class UndoConflictError extends Error {
  constructor(
    readonly conflicts: { table: string; key: Value; reason: string }[],
  ) {
    super(`cannot undo: ${conflicts.map((c) => `${c.table}[${JSON.stringify(c.key)}] ${c.reason}`).join('; ')}`);
    this.name = 'UndoConflictError';
  }
}

/** Positional (`?`) or named (`$name`) values for a statement. */
export type Params = readonly Value[] | Readonly<Record<string, Value>>;

/** A row as an object keyed by output column name. Duplicate names: last one wins. */
export type RowObject = Record<string, Value>;

/** What a compiled statement knows how to do once its parameter slot is filled. */
interface Prepared {
  run(): QueryResult;
}

/**
 * better-sqlite3-shaped prepared statement. Parsing AND planning happen once;
 * each run only rewrites the parameter slot the compiled plan reads from.
 * Plans are rebuilt automatically if the schema changes underneath.
 */
export class Statement {
  private readonly stmt: Stmt;
  private readonly slot: ParamSlot = { positional: null, named: null };
  private readonly positionalCount: number;
  private readonly names: string[];
  private readonly prepared: Prepared;

  constructor(
    private readonly db: Database,
    stmts: Stmt[],
    readonly source: string,
  ) {
    if (stmts.length !== 1) throw new TypeError_('prepare() expects exactly one statement');
    this.stmt = stmts[0]!;
    const meta = collectParams(this.stmt);
    this.positionalCount = meta.positional;
    this.names = meta.names;
    this.prepared = db.compileStatement(this.stmt, this.slot);
  }

  private bind(params: Params): void {
    const s = slotFor(params, this.positionalCount, this.names);
    this.slot.positional = s.positional;
    this.slot.named = s.named;
  }

  private exec(params: Params): QueryResult {
    this.bind(params);
    return this.db.runPrepared(this.stmt, this.prepared);
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

/** How many `?` and which `$name`s a statement uses. */
function collectParams(stmt: Stmt): { positional: number; names: string[] } {
  let positional = 0;
  const names: string[] = [];
  const walk = (e: Expr | undefined): void => {
    if (!e) return;
    switch (e.kind) {
      case 'param':
        if (e.name !== undefined) {
          if (!names.includes(e.name)) names.push(e.name);
        } else positional++;
        break;
      case 'binary':
        walk(e.left);
        walk(e.right);
        break;
      case 'not':
      case 'neg':
      case 'isnull':
        walk(e.expr);
        break;
      default:
        break;
    }
  };
  switch (stmt.kind) {
    case 'select':
      for (const c of stmt.columns) if (c.kind === 'expr') walk(c.expr);
      for (const j of stmt.joins) walk(j.on);
      for (const o of stmt.orderBy) walk(o.expr);
      walk(stmt.where);
      break;
    case 'explain':
      return collectParams(stmt.stmt);
    case 'insert':
      for (const r of stmt.rows) for (const e of r) walk(e);
      break;
    case 'update':
      for (const a of stmt.assignments) walk(a.expr);
      walk(stmt.where);
      break;
    case 'delete':
      walk(stmt.where);
      break;
    default:
      break;
  }
  return { positional, names };
}

/** Validate caller-supplied values against what the statement uses; build the slot. */
function slotFor(params: Params, positionalCount: number, names: string[]): ParamSlot {
  if (Array.isArray(params)) {
    const p = params as readonly Value[];
    if (names.length) throw new TypeError_(`missing value for parameter $${names[0]}`);
    if (p.length < positionalCount) throw new TypeError_(`too few parameter values: need at least ${positionalCount}`);
    if (p.length > positionalCount) throw new TypeError_(`too many parameter values: ${p.length} given, ${positionalCount} used`);
    return { positional: p, named: null };
  }
  const named = params as Readonly<Record<string, Value>>;
  if (positionalCount) throw new TypeError_('positional parameter ? given an object of named values');
  for (const n of names) if (!(n in named)) throw new TypeError_(`missing value for parameter $${n}`);
  return { positional: null, named };
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
  /** A statement failed inside BEGIN: only ROLLBACK (or COMMIT, which rolls back) is accepted. */
  private aborted = false;
  private readonly historyOn: boolean;
  /** Transaction id assigned to the open transaction on its first recorded change. */
  private txnId: number | null = null;
  private txnSeq = 0;
  /** Tables written by the open transaction; drives watcher notification on commit. */
  private touched = new Set<string>();
  private watchers = new Map<number, { tables: Set<string>; stmt: Statement; params: Params; last: string; cb: WatchCallback; onError?: (e: Error) => void }>();
  private nextWatcher = 1;
  private notifying = false;
  private pendingNotify: Set<string>[] = [];

  constructor(
    readonly path: string,
    opts: DatabaseOptions = {},
  ) {
    this.historyOn = opts.history ?? false;
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

  /** Parse and plan once, run many times with different values. */
  prepare(sql: string): Statement {
    return new Statement(this, parse(sql), sql);
  }

  /**
   * Compile a statement against the current schema. The returned object reads
   * parameters from `slot` at run time and re-plans itself if the catalog
   * version moves (CREATE/DROP/rollback). `slot` undefined = no parameters
   * allowed (plain exec()).
   */
  compileStatement(stmt: Stmt, slot?: ParamSlot): Prepared {
    const cached = <T>(build: () => T): (() => T) => {
      let version = -1;
      let value: T;
      return () => {
        if (version !== this.catalog.version) {
          value = build();
          version = this.catalog.version;
        }
        return value;
      };
    };
    switch (stmt.kind) {
      case 'select': {
        const plan = cached(() => planSelect(stmt, this.catalog, this.pager, slot));
        return {
          run: () => {
            const p = plan();
            const rows = collect(p.root).map((r) => r.v);
            return { command: 'SELECT', columns: p.columns, rows, rowCount: rows.length };
          },
        };
      }
      case 'explain': {
        const plan = cached(() => planSelect(stmt.stmt, this.catalog, this.pager, slot));
        return { run: () => ({ command: 'EXPLAIN', columns: ['QUERY PLAN'], rows: plan().root.explain().map((l) => [l]), rowCount: 0 }) };
      }
      case 'insert': {
        const c = cached(() => this.compileInsert(stmt, slot));
        return { run: () => c()() };
      }
      case 'update': {
        const c = cached(() => this.compileUpdate(stmt, slot));
        return { run: () => c()() };
      }
      case 'delete': {
        const c = cached(() => this.compileDelete(stmt, slot));
        return { run: () => c()() };
      }
      default:
        return { run: () => this.dispatch(stmt) };
    }
  }

  /** Run a compiled statement under the same transaction rules as exec(). Used by Statement. */
  runPrepared(stmt: Stmt, prepared: Prepared): QueryResult {
    return this.runStatement(stmt, prepared);
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
        // An async callback returns a Promise before doing its work; committing
        // here would persist a partial transaction and a later rejection could
        // never roll it back. Refuse rather than guess.
        if (r !== null && typeof r === 'object' && typeof (r as { then?: unknown }).then === 'function')
          throw new TypeError_('transaction callback must be synchronous (it returned a Promise)');
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
    const stmts = parse(sql);
    const hasParams = Array.isArray(params) ? params.length > 0 : Object.keys(params).length > 0;
    this.pager.startTrace();
    try {
      const results = stmts.map((s) => {
        const meta = collectParams(s);
        const slot = hasParams || meta.positional || meta.names.length ? slotFor(params, meta.positional, meta.names) : undefined;
        return this.runStatement(s, this.compileStatement(s, slot));
      });
      const events = this.pager.stopTrace();
      return { results, events, summary: summarize(events) };
    } catch (e) {
      this.pager.stopTrace();
      throw e;
    }
  }

  /**
   * Structural integrity check an adopter can run on their own file:
   * catalog roots exist and have the right page type, every heap chain is
   * intact with a correct `last` pointer, every B-tree is ordered with valid
   * sibling links and high keys, and every index entry points at a live row.
   * Returns problems instead of throwing so a report can list them all.
   * Counts cover user tables; the catalog tables are checked but not counted.
   */
  verify(): VerifyReport {
    const problems: string[] = [];
    const meta = this.pager.getMeta();
    const kindOf = (page: number): PageKind => {
      if (page <= 0 || page >= meta.pageCount) return 'unknown';
      return PAGE_KIND[this.pager.with(page, (f) => f.page.type)] ?? 'unknown';
    };
    let tables = 0;
    let indexes = 0;
    let rows = 0;
    let entries = 0;
    for (const t of this.catalog.allTables()) {
      if (!t.system) tables++; // catalog tables are checked but not counted
      if (kindOf(t.rootPage) !== 'heap') problems.push(`table "${t.name}": root page ${t.rootPage} is ${kindOf(t.rootPage)}, expected heap`);
      // heap chain
      const heap = new Heap(this.pager, t.rootPage);
      const chain = heap.chain();
      let count = 0;
      for (const page of chain) {
        if (kindOf(page) !== 'heap') problems.push(`table "${t.name}": chain page ${page} is ${kindOf(page)}`);
        count += this.pager.with(page, (f) => [...f.page.items()].length);
      }
      const last = this.pager.with(t.rootPage, (f) => f.page.special.readUInt32LE(4));
      if (last !== chain[chain.length - 1]) problems.push(`table "${t.name}": last-page pointer ${last} but chain ends at ${chain[chain.length - 1]}`);
      if (!t.system) rows += count;
      // indexes
      for (const idx of t.indexes) {
        indexes++;
        if (kindOf(idx.metaPage) !== 'btree-meta') problems.push(`index "${idx.name}": meta page ${idx.metaPage} is ${kindOf(idx.metaPage)}`);
        const type = t.columns[idx.columnIndex]!.type;
        const tree = openTree(this.pager, idx, type);
        let n = 0;
        try {
          n = tree.verify();
        } catch (e) {
          problems.push(`index "${idx.name}": ${(e as Error).message}`);
        }
        entries += n;
        let dangling = 0;
        let mismatched = 0;
        for (const e of tree.scan()) {
          const data = heap.get(e.tid);
          if (!data) {
            dangling++;
            continue;
          }
          const v = decodeTuple(t.columns.map((c) => c.type), data)[idx.columnIndex]!;
          if (v === null || compareValues(type, v, decodeValue(type, e.key, 0).value) !== 0) mismatched++;
        }
        if (dangling) problems.push(`index "${idx.name}": ${dangling} entries point at deleted rows`);
        if (mismatched) problems.push(`index "${idx.name}": ${mismatched} entries disagree with the row's value`);
        const indexedRows = [...heap.scan()].filter((r) => decodeTuple(t.columns.map((c) => c.type), r.data)[idx.columnIndex] !== null).length;
        if (n !== indexedRows) problems.push(`index "${idx.name}": ${n} entries for ${indexedRows} indexable rows`);
      }
    }
    return { ok: problems.length === 0, problems, tables, indexes, rows, entries, pages: meta.pageCount };
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

  /** Transaction rules around one statement: explicit block (with aborted state) or autocommit. */
  private runStatement(stmt: Stmt, prepared?: Prepared): QueryResult {
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
    const run = prepared ?? this.compileStatement(stmt);
    if (this.explicitTxn) {
      if (this.aborted) throw new TypeError_('current transaction is aborted, commands ignored until end of transaction block');
      try {
        return run.run();
      } catch (e) {
        // Keep the transaction open but poisoned; its partial effects live only
        // in the buffer pool and are discarded by the eventual rollback.
        this.aborted = true;
        throw e;
      }
    }
    this.pager.begin();
    try {
      const r = run.run();
      this.pager.commit();
      this.afterCommit();
      return r;
    } catch (e) {
      this.pager.rollback();
      this.catalog.load();
      this.resetTxnState();
      throw e;
    }
  }

  private resetTxnState(): void {
    this.txnId = null;
    this.txnSeq = 0;
    this.touched = new Set();
  }

  /** Called once the pager has durably committed: tell watchers whose tables changed. */
  private afterCommit(): void {
    const touched = this.touched;
    this.resetTxnState();
    if (touched.size) this.notify(touched);
  }

  /** Finish the explicit transaction. The facade flag is cleared only once the pager is back in a clean state. */
  private endTxn(commit: boolean): void {
    try {
      if (commit) this.pager.commit();
      else this.pager.rollback();
    } catch (e) {
      if (this.pager.inTxn) this.pager.rollback();
      this.catalog.load();
      this.resetTxnState();
      throw e;
    } finally {
      this.explicitTxn = false;
      this.aborted = false;
    }
    if (commit) this.afterCommit();
    else {
      this.catalog.load();
      this.resetTxnState();
    }
  }

  /** DDL. Queries and DML go through compileStatement(). */
  private dispatch(stmt: Stmt): QueryResult {
    switch (stmt.kind) {
      case 'create_table':
        this.catalog.createTable(stmt.name, stmt.columns);
        this.touched.add(stmt.name);
        return result('CREATE TABLE');
      case 'create_index': {
        const t = this.catalog.mustGetTable(stmt.table);
        const idx = this.catalog.createIndex(stmt.name, stmt.table, stmt.column, stmt.unique);
        this.buildIndex(t, idx);
        return result('CREATE INDEX');
      }
      case 'drop': {
        const r = this.drop(stmt.what, stmt.name, stmt.ifExists);
        this.touched.add(stmt.name);
        return r;
      }
      default:
        throw new TypeError_('unsupported statement');
    }
  }

  // ------------------------------------------------------------ INSERT / UPDATE / DELETE (compiled once, run many)

  private compileInsert(stmt: InsertStmt, slot?: ParamSlot): () => QueryResult {
    const t = this.userTable(stmt.table);
    const targets = stmt.columns
      ? stmt.columns.map((name) => {
          const ci = t.columns.findIndex((c) => c.name === name);
          if (ci < 0) throw new TypeError_(`column "${name}" of relation "${t.name}" does not exist`);
          return ci;
        })
      : t.columns.map((_, i) => i);
    if (new Set(targets).size !== targets.length) throw new TypeError_('column specified more than once');
    const empty = new Scope();
    const rows = stmt.rows.map((exprs) => {
      if (exprs.length !== targets.length) throw new TypeError_(`INSERT has ${exprs.length} expressions but ${targets.length} target columns`);
      return exprs.map((e, i) => {
        const c = compile(e, empty, slot);
        const col = t.columns[targets[i]!]!;
        if (c.type !== null && c.type !== col.type)
          throw new TypeError_(`column "${col.name}" is of type ${col.type} but expression is of type ${c.type}`);
        return c;
      });
    });
    const heap = new Heap(this.pager, t.rootPage);
    return () => {
      for (const exprs of rows) {
        const values: Value[] = t.columns.map(() => null);
        exprs.forEach((c, i) => (values[targets[i]!] = c.eval([])));
        this.writeRow(t, heap, values, null);
      }
      return { ...result('INSERT'), rowCount: rows.length };
    };
  }

  private compileUpdate(stmt: UpdateStmt, slot?: ParamSlot): () => QueryResult {
    const t = this.userTable(stmt.table);
    const scope = new Scope();
    scope.add(t.name, t);
    const sets = stmt.assignments.map((a) => {
      const ci = t.columns.findIndex((c) => c.name === a.column);
      if (ci < 0) throw new TypeError_(`column "${a.column}" of relation "${t.name}" does not exist`);
      const c = compile(a.expr, scope, slot);
      const col = t.columns[ci]!;
      if (c.type !== null && c.type !== col.type)
        throw new TypeError_(`column "${col.name}" is of type ${col.type} but expression is of type ${c.type}`);
      return { ci, c };
    });
    if (new Set(sets.map((s) => s.ci)).size !== sets.length) throw new TypeError_('multiple assignments to same column');
    const scan = this.planDml(t, stmt.where, slot);
    const heap = new Heap(this.pager, t.rootPage);
    return () => {
      // Collect first, then write (Halloween problem: an index scan must not see rows it just moved).
      const targets = collect(scan);
      for (const row of targets) {
        const values = [...row.v];
        for (const s of sets) values[s.ci] = s.c.eval(row.v);
        this.writeRow(t, heap, values, { tid: row.tid!, old: row.v });
      }
      return { ...result('UPDATE'), rowCount: targets.length };
    };
  }

  private compileDelete(stmt: DeleteStmt, slot?: ParamSlot): () => QueryResult {
    const t = this.userTable(stmt.table);
    const scan = this.planDml(t, stmt.where, slot);
    const heap = new Heap(this.pager, t.rootPage);
    return () => {
      const targets = collect(scan);
      for (const row of targets) {
        this.removeIndexEntries(t, row.v, row.tid!);
        heap.delete(row.tid!);
        this.recordChange(t, 'DELETE', row.v, null);
      }
      return { ...result('DELETE'), rowCount: targets.length };
    };
  }

  /** The scan that finds the rows UPDATE/DELETE will touch: same planner as SELECT *. */
  private planDml(t: TableDef, where: Expr | undefined, slot?: ParamSlot): PlanNode {
    const sel: SelectStmt = { kind: 'select', columns: [{ kind: 'star' }], from: { name: t.name }, joins: [], orderBy: [] };
    if (where) sel.where = where;
    return planSelect(sel, this.catalog, this.pager, slot).root;
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
      if (typeOfValue(v) !== col.type) throw new TypeError_(`column "${col.name}" is of type ${col.type} but expression is of type ${typeOfValue(v)}`);
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
      this.recordChange(t, 'UPDATE', prev.old, values);
      return;
    }
    tid = heap.insert(data);
    for (const idx of t.indexes) {
      const v = values[idx.columnIndex]!;
      if (v === null) continue; // NULLs are not indexed
      const type = t.columns[idx.columnIndex]!.type;
      openTree(this.pager, idx, type).insert(encodeValue(type, v), tid);
    }
    this.recordChange(t, 'INSERT', null, values);
  }

  // ------------------------------------------------------------ change receipts

  /** Note the table as touched; with history on, append a receipt in the same transaction. */
  private recordChange(t: TableDef, op: ChangeRecord['op'], before: Value[] | null, after: Value[] | null): void {
    this.touched.add(t.name);
    if (!this.historyOn || t.system) return;
    const changes = this.catalog.ensureChangesTable();
    if (this.txnId === null) {
      const meta = this.pager.getMeta();
      this.txnId = meta.nextTxn;
      this.pager.setMeta({ nextTxn: meta.nextTxn + 1 }); // rolls back with the transaction
      this.txnSeq = 0;
    }
    const pk = t.columns.findIndex((c) => c.pk);
    const row = after ?? before!;
    const key = pk >= 0 ? JSON.stringify(row[pk]) : null;
    new Heap(this.pager, changes.rootPage).insert(
      encodeTuple(
        SYS_CHANGES_COLS.map((c) => c.type),
        [this.txnId, this.txnSeq++, t.name, op, key, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
      ),
    );
  }

  /** Receipts, oldest first. `since` = only transactions after this id. */
  changes(opts: { since?: number; table?: string; limit?: number } = {}): ChangeRecord[] {
    if (!this.catalog.getTable(SYS_CHANGES)) return [];
    const since = opts.since ?? 0;
    const params: Value[] = [since];
    let where = 'txn > ?';
    if (opts.table !== undefined) {
      where += ' AND table_name = ?';
      params.push(opts.table);
    }
    const sql = `SELECT txn, seq, table_name, op, row_key, before, after FROM __changes WHERE ${where} ORDER BY txn, seq${opts.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : ''}`;
    return this.prepare(sql).raw(...params).rows.map(decodeChange);
  }

  /** Every receipt for one row, oldest first. */
  history(table: string, key: Value): ChangeRecord[] {
    if (!this.catalog.getTable(SYS_CHANGES)) return [];
    return this.prepare('SELECT txn, seq, table_name, op, row_key, before, after FROM __changes WHERE table_name = ? AND row_key = ? ORDER BY txn, seq').raw(table, JSON.stringify(key)).rows.map(decodeChange);
  }

  /** Id of the last committed transaction that recorded a change (0 if none). */
  lastTxn(): number {
    return this.pager.getMeta().nextTxn - 1;
  }

  /** Drop receipts of transactions older than `beforeTxn`. Returns how many were removed. */
  pruneHistory(beforeTxn: number): number {
    const t = this.catalog.getTable(SYS_CHANGES);
    if (!t) return 0;
    const heap = new Heap(this.pager, t.rootPage);
    const types = SYS_CHANGES_COLS.map((c) => c.type);
    const run = () => {
      const victims = [...heap.scan()].filter((r) => (decodeTuple(types, r.data)[0] as number) < beforeTxn).map((r) => r.tid);
      for (const tid of victims) heap.delete(tid);
      return victims.length;
    };
    if (this.explicitTxn) return run();
    this.pager.begin();
    try {
      const n = run();
      this.pager.commit();
      return n;
    } catch (e) {
      this.pager.rollback();
      throw e;
    }
  }

  // ------------------------------------------------------------ watch

  /**
   * Re-run `sql` after every committed transaction that touched one of its
   * tables, and call `cb` only when the result differs from last time. `cb`
   * is called once immediately with the current result. Returns unsubscribe.
   * Callbacks run after the commit has returned, so they may write; their
   * writes notify other watchers in turn.
   */
  watch(sql: string, params: Params, cb: WatchCallback, opts: { onError?: (e: Error) => void } = {}): () => void {
    const stmts = parse(sql);
    if (stmts.length !== 1 || stmts[0]!.kind !== 'select') throw new TypeError_('watch() takes exactly one SELECT');
    const sel = stmts[0]!;
    const tables = new Set<string>();
    if (sel.from) tables.add(sel.from.name);
    for (const j of sel.joins) tables.add(j.table.name);
    const stmt = this.prepare(sql);
    const rows = Array.isArray(params) ? stmt.all(...(params as Value[])) : stmt.all(params as Readonly<Record<string, Value>>);
    const id = this.nextWatcher++;
    const w = { tables, stmt, params, last: JSON.stringify(rows), cb, ...(opts.onError ? { onError: opts.onError } : {}) };
    this.watchers.set(id, w);
    cb(rows);
    return () => {
      this.watchers.delete(id);
    };
  }

  private notify(touched: Set<string>): void {
    this.pendingNotify.push(touched);
    if (this.notifying) return; // a callback's own write; drained by the outer loop
    this.notifying = true;
    try {
      while (this.pendingNotify.length) {
        const batch = this.pendingNotify.shift()!;
        for (const w of [...this.watchers.values()]) {
          if (![...w.tables].some((t) => batch.has(t))) continue;
          let rows: RowObject[];
          try {
            rows = Array.isArray(w.params) ? w.stmt.all(...(w.params as Value[])) : w.stmt.all(w.params as Readonly<Record<string, Value>>);
          } catch (e) {
            w.onError?.(e as Error);
            continue;
          }
          const json = JSON.stringify(rows);
          if (json === w.last) continue;
          w.last = json;
          w.cb(rows);
        }
      }
    } finally {
      this.notifying = false;
    }
  }

  // ------------------------------------------------------------ undo

  /**
   * Reverse every change of transaction `txn`, in one new transaction (which
   * gets its own receipt, so an undo can itself be undone). Refuses with
   * UndoConflictError, changing nothing, if any affected row has been
   * modified since: an INSERT/UPDATE is only undone if the row still holds
   * the values that transaction left, a DELETE only if the row is still absent.
   */
  undo(txn: number): { reverted: number } {
    if (!this.historyOn) throw new TypeError_('undo() needs the history option');
    const changes = this.changes({ since: txn - 1 }).filter((c) => c.txn === txn);
    if (!changes.length) throw new TypeError_(`transaction ${txn} has no recorded changes`);
    const same = (a: Value[] | null, b: Value[] | null) => JSON.stringify(a) === JSON.stringify(b);
    const run = this.transaction(() => {
      const conflicts: UndoConflictError['conflicts'] = [];
      const plan: (() => void)[] = [];
      // A row may appear in several receipts of the same transaction. Walking
      // them newest-first, the live row must match the newest receipt's `after`;
      // undoing it leaves `before`, which is what the next-older receipt expects.
      const expected = new Map<string, Value[] | null>();
      for (const c of [...changes].reverse()) {
        const t = this.catalog.getTable(c.table);
        const pk = t?.columns.findIndex((col) => col.pk) ?? -1;
        if (!t || pk < 0 || c.key === null) {
          conflicts.push({ table: c.table, key: c.key, reason: 'table gone or has no primary key' });
          continue;
        }
        const pkName = t.columns[pk]!.name;
        const id = `${c.table}\u0000${JSON.stringify(c.key)}`;
        if (!expected.has(id)) expected.set(id, this.prepare(`SELECT * FROM ${c.table} WHERE ${pkName} = ?`).raw(c.key).rows[0] ?? null);
        const current = expected.get(id)!;
        const cols = t.columns.map((col) => col.name);
        switch (c.op) {
          case 'INSERT':
            if (!same(current, c.after)) conflicts.push({ table: c.table, key: c.key, reason: current ? 'modified since' : 'already deleted' });
            else plan.push(() => this.prepare(`DELETE FROM ${c.table} WHERE ${pkName} = ?`).run(c.key));
            break;
          case 'UPDATE':
            if (!same(current, c.after)) conflicts.push({ table: c.table, key: c.key, reason: current ? 'modified since' : 'deleted since' });
            else plan.push(() => this.prepare(`UPDATE ${c.table} SET ${cols.map((n) => `${n} = ?`).join(', ')} WHERE ${pkName} = ?`).run(...c.before!, c.key));
            break;
          case 'DELETE':
            if (current) conflicts.push({ table: c.table, key: c.key, reason: 'row re-created since' });
            else plan.push(() => this.prepare(`INSERT INTO ${c.table} VALUES (${cols.map(() => '?').join(', ')})`).run(...c.before!));
            break;
        }
        expected.set(id, c.before); // state of the row once this receipt is undone
      }
      if (conflicts.length) throw new UndoConflictError(conflicts);
      for (const step of plan) step();
      return { reverted: plan.length };
    });
    return run();
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
        const k = encodeValue(type, v).toString('hex'); // canonical bytes, same identity the index itself uses
        if (seen.has(k)) throw new ConstraintError(`could not create unique index "${idx.name}": key (${idx.column})=(${String(v)}) is duplicated`);
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

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  tables: number;
  indexes: number;
  rows: number;
  entries: number;
  pages: number;
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

function decodeChange(r: Value[]): ChangeRecord {
  const [txn, seq, table, op, key, before, after] = r as [number, number, string, ChangeRecord['op'], string | null, string | null, string | null];
  return {
    txn,
    seq,
    table,
    op,
    key: key === null ? null : (JSON.parse(key) as Value),
    before: before === null ? null : (JSON.parse(before) as Value[]),
    after: after === null ? null : (JSON.parse(after) as Value[]),
  };
}

function result(command: string): QueryResult {
  return { command, columns: [], rows: [], rowCount: 0 };
}
