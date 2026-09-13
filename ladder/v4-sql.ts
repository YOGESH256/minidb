/**
 * v4 — SQL on top. Text → tokens → tree → plan → rows.
 *
 *   "SELECT name FROM users WHERE id = 4 AND age > 20"
 *        │ lexer
 *        ▼  [SELECT] [name] [FROM] [users] [WHERE] [id] [=] [4] [AND] [age] [>] [20]
 *        │ parser
 *        ▼  { table: 'users', columns: ['name'], where: [ {col:'id', op:'=', v:4}, {col:'age', op:'>', v:20} ] }
 *        │ planner:  is there an `id = <number>` condition?  yes → IndexLookup, else SeqScan
 *        ▼
 *      Project(name)
 *        └─ Filter(age > 20)
 *             └─ IndexLookup(id = 4)         ← each node has next(); rows are pulled one at a time
 *
 * Supports exactly: CREATE TABLE t (a, b, c) · INSERT INTO t VALUES (...) ·
 * SELECT cols|* FROM t [WHERE col op literal [AND ...]] · EXPLAIN SELECT ...
 * The real src/sql/ adds types, joins, ORDER BY, LIMIT, NULLs and a Pratt
 * expression parser. Same shape, more cases.
 */
import type { FakeDisk } from './fake-disk.js';
import { IndexedDb } from './v3-btree.js';
import type { Row } from './v0-array.js';

// ------------------------------------------------------------ lexer
type Tok = { t: 'word' | 'num' | 'str' | 'punct'; v: string };

export function lex(input: string): Tok[] {
  const sql = input.trim().replace(/;$/, '');
  const out: Tok[] = [];
  const re = /\s*(?:(\d+)|'((?:[^']|'')*)'|([A-Za-z_]\w*)|(<=|>=|<>|!=|[=<>(),*;]))/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < sql.length && (m = re.exec(sql))) {
    if (m[1] !== undefined) out.push({ t: 'num', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'str', v: m[2].replace(/''/g, "'") });
    else if (m[3] !== undefined) out.push({ t: 'word', v: KEYWORDS.has(m[3].toUpperCase()) ? m[3].toUpperCase() : m[3].toLowerCase() });
    else out.push({ t: 'punct', v: m[4]! });
  }
  if (re.lastIndex < sql.length) throw new Error(`cannot lex near "${sql.slice(re.lastIndex, re.lastIndex + 10)}"`);
  return out;
}
const KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'INSERT', 'INTO', 'VALUES', 'CREATE', 'TABLE', 'EXPLAIN']);

// ------------------------------------------------------------ parser
export type Cond = { col: string; op: string; v: number | string };
export type Stmt =
  | { kind: 'create'; table: string; columns: string[] }
  | { kind: 'insert'; table: string; values: (number | string)[] }
  | { kind: 'select'; table: string; columns: string[] | '*'; where: Cond[]; explain: boolean };

export function parse(sql: string): Stmt {
  const toks = lex(sql);
  let i = 0;
  const peek = () => toks[i];
  const take = (v?: string): Tok => {
    const t = toks[i++];
    if (!t || (v !== undefined && t.v !== v)) throw new Error(`expected ${v ?? 'more input'} near "${t?.v ?? 'end'}"`);
    return t;
  };
  const list = <T>(item: () => T): T[] => {
    const out = [item()];
    while (peek()?.v === ',') {
      i++;
      out.push(item());
    }
    return out;
  };
  const literal = (): number | string => {
    const t = take();
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    throw new Error(`expected a value, got "${t.v}"`);
  };

  const first = take();
  if (first.v === 'CREATE') {
    take('TABLE');
    const table = take().v;
    take('(');
    const columns = list(() => take().v);
    take(')');
    return { kind: 'create', table, columns };
  }
  if (first.v === 'INSERT') {
    take('INTO');
    const table = take().v;
    take('VALUES');
    take('(');
    const values = list(literal);
    take(')');
    return { kind: 'insert', table, values };
  }
  const explain = first.v === 'EXPLAIN';
  if (explain) take('SELECT');
  else if (first.v !== 'SELECT') throw new Error(`unknown statement "${first.v}"`);
  const columns: string[] | '*' = peek()?.v === '*' ? (i++, '*') : list(() => take().v);
  take('FROM');
  const table = take().v;
  const where: Cond[] = [];
  if (peek()?.v === 'WHERE') {
    i++;
    do where.push({ col: take().v, op: take().v, v: literal() });
    while (peek()?.v === 'AND' && ++i);
  }
  if (i !== toks.length) throw new Error(`unexpected "${toks[i]!.v}"`);
  return { kind: 'select', table, columns, where, explain };
}

// ------------------------------------------------------------ executor nodes
interface Node {
  next(): Row | null;
  explain(): string;
}
class SeqScan implements Node {
  private it: IterableIterator<{ row: Row }>;
  constructor(db: IndexedDb) {
    this.it = db.scan();
  }
  next(): Row | null {
    const r = this.it.next();
    return r.done ? null : r.value.row;
  }
  explain() {
    return 'Seq Scan (reads every page)';
  }
}
class IndexLookup implements Node {
  private done = false;
  constructor(
    private db: IndexedDb,
    private id: number,
  ) {}
  next(): Row | null {
    if (this.done) return null;
    this.done = true;
    return this.db.findById(this.id);
  }
  explain() {
    return `Index Lookup (id = ${this.id}, reads ~3 pages)`;
  }
}
class Filter implements Node {
  constructor(
    private child: Node,
    private conds: Cond[],
  ) {}
  next(): Row | null {
    for (;;) {
      const r = this.child.next();
      if (!r) return null;
      if (this.conds.every((c) => test(r[c.col] ?? null, c.op, c.v))) return r;
    }
  }
  explain() {
    return `Filter (${this.conds.map((c) => `${c.col} ${c.op} ${JSON.stringify(c.v)}`).join(' AND ')})\n  -> ${this.child.explain()}`;
  }
}
class Project implements Node {
  constructor(
    private child: Node,
    private cols: string[] | '*',
  ) {}
  next(): Row | null {
    const r = this.child.next();
    if (!r || this.cols === '*') return r;
    return Object.fromEntries(this.cols.map((c) => [c, r[c] ?? null]));
  }
  explain() {
    return `Project (${this.cols === '*' ? '*' : this.cols.join(', ')})\n  -> ${this.child.explain()}`;
  }
}
function test(a: number | string | boolean | null, op: string, b: number | string): boolean {
  if (a === null) return false;
  switch (op) {
    case '=': return a === b;
    case '<>': case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
  }
  throw new Error(`unknown operator ${op}`);
}

// ------------------------------------------------------------ planner + database
export class SqlDb {
  private tables = new Map<string, { columns: string[]; store: IndexedDb }>();
  constructor(
    private disk: FakeDisk,
    private prefix: string,
  ) {}

  private plan(s: Extract<Stmt, { kind: 'select' }>): Node {
    const t = this.tables.get(s.table);
    if (!t) throw new Error(`no such table ${s.table}`);
    // The planner's one decision: can the primary-key index answer part of WHERE?
    const pk = s.where.find((c) => c.col === 'id' && c.op === '=' && typeof c.v === 'number');
    const rest = s.where.filter((c) => c !== pk);
    let node: Node = pk ? new IndexLookup(t.store, pk.v as number) : new SeqScan(t.store);
    if (rest.length) node = new Filter(node, rest);
    return new Project(node, s.columns);
  }

  exec(sql: string): Row[] | string {
    const s = parse(sql);
    switch (s.kind) {
      case 'create':
        this.tables.set(s.table, { columns: s.columns, store: new IndexedDb(this.disk, `${this.prefix}-${s.table}`) });
        return `CREATE TABLE`;
      case 'insert': {
        const t = this.tables.get(s.table);
        if (!t) throw new Error(`no such table ${s.table}`);
        if (s.values.length !== t.columns.length) throw new Error(`expected ${t.columns.length} values`);
        t.store.insert(Object.fromEntries(t.columns.map((c, i) => [c, s.values[i]!])));
        return `INSERT 1`;
      }
      case 'select': {
        const node = this.plan(s);
        if (s.explain) return node.explain();
        const rows: Row[] = [];
        let r: Row | null;
        while ((r = node.next())) rows.push(r); // the Volcano loop: pull until empty
        return rows;
      }
    }
  }
}
