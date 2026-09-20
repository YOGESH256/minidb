/**
 * The custodian: something that lives with the data and notices things.
 *
 * It is not an autonomous tuner. It never changes the database. It watches
 * every statement go past, remembers what the work cost, and reports what a
 * careful person would notice if they sat with your data every day:
 *
 *   - this query keeps reading the whole table to find three rows
 *   - this index is paid for on every write and nothing has used it
 *   - this column went from 5% null to 60% overnight
 *   - this row has been written and reverted six times today
 *   - your history is now bigger than your data
 *
 * Findings carry the evidence that produced them, so you can disagree.
 */
import type { AccessPath } from './sql/planner.js';
import type { Value } from './types.js';

export type Severity = 'info' | 'suggestion' | 'warning';

export interface Finding {
  /** Stable identifier for the kind of observation, e.g. 'missing-index'. */
  kind: string;
  severity: Severity;
  table?: string;
  /** One sentence, in the terms a person using the database would use. */
  message: string;
  /** The numbers behind the claim, so the reader can judge it. */
  evidence: Record<string, Value>;
  /** SQL that would act on it, when there is an obvious action. */
  suggestion?: string;
}

/** What one recurring statement shape has cost, in total. */
export interface ShapeStat {
  shape: string;
  table: string;
  access: 'seq' | 'index';
  index?: string;
  filterColumns: string[];
  runs: number;
  pagesRead: number;
  rowsOut: number;
  totalMs: number;
}

export interface CustodianOptions {
  /** Distinct statement shapes to remember. Oldest-least-used dropped beyond this. */
  maxShapes?: number;
  /** A shape must run at least this often before a missing index is suggested. */
  minRuns?: number;
  /**
   * Suggest an index only when it would read at least this many times fewer
   * pages than the scan it replaces. Selectivity alone is not enough: matching
   * rows scattered across every page cost an index scan a page each, so a
   * query returning 80 rows from a 45-page table gains nothing.
   */
  minSpeedup?: number;
  /** Ignore tables small enough that a full scan is a handful of pages anyway. */
  minPagesPerScan?: number;
  /** Warn about an unused index only after this many writes have maintained it. */
  minWritesForUnusedIndex?: number;
}

const DEFAULTS = { maxShapes: 500, minRuns: 20, minSpeedup: 2, minPagesPerScan: 4, minWritesForUnusedIndex: 100 };
/** Typical B-tree descent for the sizes this engine handles: meta, root, leaf. */
const INDEX_DESCENT_PAGES = 3;

/** Replace literals with `?` so runs of the same query collapse into one shape. */
export function shapeOf(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Custodian {
  private shapes = new Map<string, ShapeStat>();
  /** Writes per table, to price the indexes those writes maintain. */
  private writes = new Map<string, number>();
  /** Indexes the planner has actually used. */
  private indexUse = new Map<string, number>();
  /** Null counts sampled per column over time: table.column → [old share, new share]. */
  private nullRates = new Map<string, { early: { n: number; nulls: number }; late: { n: number; nulls: number } }>();
  private opts: Required<CustodianOptions>;

  constructor(opts: CustodianOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Called after a SELECT: what it cost, and how the planner reached each table. */
  recordQuery(sql: string, paths: readonly AccessPath[], pagesRead: number, rowsOut: number, ms: number): void {
    const shape = shapeOf(sql);
    for (const p of paths) {
      if (p.index) this.indexUse.set(p.index, (this.indexUse.get(p.index) ?? 0) + 1);
      const key = `${shape}\u0000${p.table}`;
      let st = this.shapes.get(key);
      if (!st) {
        if (this.shapes.size >= this.opts.maxShapes) this.evictLeastUsed();
        st = { shape, table: p.table, access: p.access, filterColumns: [], runs: 0, pagesRead: 0, rowsOut: 0, totalMs: 0 };
        if (p.index !== undefined) st.index = p.index;
        this.shapes.set(key, st);
      }
      // A shape's access method can change under it when an index appears.
      st.access = p.access;
      if (p.index !== undefined) st.index = p.index;
      else delete st.index;
      st.filterColumns = [...new Set([...st.filterColumns, ...p.filterColumns])];
      st.runs++;
      // Cost is per statement; attribute it to each table the statement touched.
      st.pagesRead += pagesRead / paths.length;
      st.rowsOut += rowsOut / paths.length;
      st.totalMs += ms / paths.length;
    }
  }

  /** Called after a write: indexes on this table were maintained. */
  recordWrite(table: string, rows: number): void {
    this.writes.set(table, (this.writes.get(table) ?? 0) + rows);
  }

  /** A sampled null count for a column, taken at some point in time. */
  recordNullSample(table: string, column: string, n: number, nulls: number): void {
    const key = `${table}.${column}`;
    const cur = this.nullRates.get(key);
    if (!cur) {
      this.nullRates.set(key, { early: { n, nulls }, late: { n, nulls } });
      return;
    }
    cur.late = { n, nulls };
  }

  private evictLeastUsed(): void {
    let worst: string | null = null;
    let worstRuns = Infinity;
    for (const [k, v] of this.shapes) {
      if (v.runs < worstRuns) {
        worstRuns = v.runs;
        worst = k;
      }
    }
    if (worst) this.shapes.delete(worst);
  }

  /** Everything remembered, heaviest first. */
  workload(): ShapeStat[] {
    return [...this.shapes.values()].sort((a, b) => b.pagesRead - a.pagesRead);
  }

  reset(): void {
    this.shapes.clear();
    this.writes.clear();
    this.indexUse.clear();
    this.nullRates.clear();
  }

  /**
   * What the custodian has noticed. `known` describes the current schema so
   * findings can name real indexes and avoid suggesting ones that exist.
   */
  report(known: { tables: { name: string; indexes: { name: string; column: string }[]; rows?: number }[]; historyRows?: number; dataRows?: number }): Finding[] {
    const out: Finding[] = [];
    const indexed = new Map<string, Set<string>>();
    const rowCount = new Map<string, number>();
    for (const t of known.tables) {
      indexed.set(t.name, new Set(t.indexes.map((i) => i.column)));
      if (t.rows !== undefined) rowCount.set(t.name, t.rows);
    }

    // ---- 1. A query keeps reading the whole table to find a few rows.
    const byColumn = new Map<string, { table: string; column: string; runs: number; pages: number; rows: number; ms: number; shapes: Set<string> }>();
    for (const st of this.shapes.values()) {
      if (st.access !== 'seq') continue;
      for (const col of st.filterColumns) {
        if (indexed.get(st.table)?.has(col)) continue; // already indexed; the planner just didn't pick it
        const key = `${st.table}.${col}`;
        const agg = byColumn.get(key) ?? { table: st.table, column: col, runs: 0, pages: 0, rows: 0, ms: 0, shapes: new Set<string>() };
        agg.runs += st.runs;
        agg.pages += st.pagesRead;
        agg.rows += st.rowsOut;
        agg.ms += st.totalMs;
        agg.shapes.add(st.shape);
        byColumn.set(key, agg);
      }
    }
    for (const agg of [...byColumn.values()].sort((a, b) => b.pages - a.pages)) {
      if (agg.runs < this.opts.minRuns) continue;
      const pagesPerScan = agg.pages / agg.runs;
      if (pagesPerScan < this.opts.minPagesPerScan) continue; // table too small to matter
      const total = rowCount.get(agg.table);
      const perRun = agg.rows / agg.runs;
      // Cost the index honestly: descend the tree, then fetch one heap page per
      // matching row in the worst case — but never more pages than the table
      // has, since that is what the scan already reads.
      const indexPages = INDEX_DESCENT_PAGES + Math.min(perRun, pagesPerScan);
      const speedup = pagesPerScan / indexPages;
      if (speedup < this.opts.minSpeedup) continue;
      const selectivity = total && total > 0 ? perRun / total : 1;
      out.push({
        kind: 'missing-index',
        severity: 'suggestion',
        table: agg.table,
        message: `${agg.runs} queries scanned all of "${agg.table}" to filter on ${agg.column}, reading ${Math.round(pagesPerScan)} pages each time to return ${Math.round(perRun)} of ${(total ?? 0).toLocaleString()} rows. An index on ${agg.column} would read about ${Math.round(indexPages)}, roughly ${speedup.toFixed(1)}x less work.`,
        evidence: {
          runs: agg.runs,
          pagesRead: Math.round(agg.pages),
          rowsReturned: Math.round(agg.rows),
          rowsPerRun: Math.round(perRun),
          tableRows: total ?? null,
          selectivityPercent: Math.round(selectivity * 1000) / 10,
          pagesPerScan: Math.round(pagesPerScan),
          estimatedIndexPages: Math.round(indexPages),
          estimatedSpeedup: Math.round(speedup * 10) / 10,
          totalMs: Math.round(agg.ms),
          example: [...agg.shapes][0]!,
        },
        suggestion: `CREATE INDEX ${agg.table}_${agg.column} ON ${agg.table} (${agg.column});`,
      });
    }

    // ---- 2. An index that costs writes and nothing reads.
    for (const t of known.tables) {
      const writes = this.writes.get(t.name) ?? 0;
      if (writes < this.opts.minWritesForUnusedIndex) continue;
      for (const idx of t.indexes) {
        if (idx.name.endsWith('_pkey')) continue; // a primary key earns its keep by enforcing uniqueness
        const uses = this.indexUse.get(idx.name) ?? 0;
        if (uses > 0) continue;
        out.push({
          kind: 'unused-index',
          severity: 'suggestion',
          table: t.name,
          message: `Index "${idx.name}" on ${t.name}(${idx.column}) has been maintained through ${writes.toLocaleString()} row writes and no query has used it.`,
          evidence: { index: idx.name, column: idx.column, writesMaintained: writes, timesUsed: 0 },
          suggestion: `DROP INDEX ${idx.name};`,
        });
      }
    }

    // ---- 3. A column's null rate moved sharply.
    for (const [key, r] of this.nullRates) {
      if (r.early.n < 50 || r.late.n < 50) continue;
      const before = r.early.nulls / r.early.n;
      const after = r.late.nulls / r.late.n;
      if (after - before < 0.25) continue;
      const [table, column] = key.split('.') as [string, string];
      out.push({
        kind: 'null-rate-shift',
        severity: 'warning',
        table,
        message: `${column} in ${table} was ${(before * 100).toFixed(0)}% empty and is now ${(after * 100).toFixed(0)}%. Something that used to fill it may have stopped.`,
        evidence: { column, beforePercent: Math.round(before * 100), afterPercent: Math.round(after * 100), sampled: r.late.n },
      });
    }

    // ---- 4. History outgrowing the data it describes.
    if (known.historyRows !== undefined && known.dataRows !== undefined && known.dataRows > 0 && known.historyRows > known.dataRows * 2) {
      out.push({
        kind: 'history-outgrew-data',
        severity: 'info',
        message: `Change history holds ${known.historyRows.toLocaleString()} receipts for ${known.dataRows.toLocaleString()} live rows. Pruning old transactions would reclaim most of it.`,
        evidence: { historyRows: known.historyRows, dataRows: known.dataRows, ratio: Math.round((known.historyRows / known.dataRows) * 10) / 10 },
        suggestion: 'db.pruneHistory(olderThanTxn)',
      });
    }

    const rank: Record<Severity, number> = { warning: 0, suggestion: 1, info: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }
}

/** Rows written and then reverted to a previous value: two things fighting. */
export function findChurn(
  changes: { txn: number; table: string; op: string; key: Value; before: Value[] | null; after: Value[] | null }[],
  minFlips = 4,
): Finding[] {
  const perRow = new Map<string, { table: string; key: Value; states: string[] }>();
  for (const c of changes) {
    if (c.op !== 'UPDATE' || c.key === null) continue;
    const id = `${c.table}\u0000${JSON.stringify(c.key)}`;
    const e = perRow.get(id) ?? { table: c.table, key: c.key, states: [] };
    if (!e.states.length) e.states.push(JSON.stringify(c.before));
    e.states.push(JSON.stringify(c.after));
    perRow.set(id, e);
  }
  const out: Finding[] = [];
  for (const e of perRow.values()) {
    // A flip is a return to a value the row already held.
    let flips = 0;
    const seen = new Set<string>();
    for (const s of e.states) {
      if (seen.has(s)) flips++;
      seen.add(s);
    }
    if (flips < minFlips) continue;
    out.push({
      kind: 'row-churn',
      severity: 'warning',
      table: e.table,
      message: `Row ${JSON.stringify(e.key)} in ${e.table} changed ${e.states.length - 1} times and returned to a previous value ${flips} times. Two writers may be overwriting each other.`,
      evidence: { key: e.key, changes: e.states.length - 1, reversions: flips, distinctStates: seen.size },
    });
  }
  return out;
}
