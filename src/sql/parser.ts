import { tokenize, SqlSyntaxError, type Token } from './lexer.js';
import type { Expr, Stmt, SelectStmt, SelectItem, TableRef, JoinClause, ColumnSpec, BinaryOp } from './ast.js';
import type { DataType } from '../types.js';

/**
 * Recursive-descent statements + Pratt expressions.
 * Binding powers (low → high): OR 1 < AND 2 < NOT 3 < comparison 4 (non-assoc)
 * < additive 5 < multiplicative 6 < unary minus 7.
 */

const BP_OR = 1;
const BP_AND = 2;
const BP_NOT = 3;
const BP_CMP = 4;
const BP_ADD = 5;
const BP_MUL = 6;
const BP_UNARY = 7;

const INFIX: Record<string, { bp: number; op: BinaryOp; assoc: 'left' | 'none' }> = {
  OR: { bp: BP_OR, op: 'OR', assoc: 'left' },
  AND: { bp: BP_AND, op: 'AND', assoc: 'left' },
  '=': { bp: BP_CMP, op: '=', assoc: 'none' },
  '!=': { bp: BP_CMP, op: '!=', assoc: 'none' },
  '<>': { bp: BP_CMP, op: '!=', assoc: 'none' },
  '<': { bp: BP_CMP, op: '<', assoc: 'none' },
  '<=': { bp: BP_CMP, op: '<=', assoc: 'none' },
  '>': { bp: BP_CMP, op: '>', assoc: 'none' },
  '>=': { bp: BP_CMP, op: '>=', assoc: 'none' },
  '+': { bp: BP_ADD, op: '+', assoc: 'left' },
  '-': { bp: BP_ADD, op: '-', assoc: 'left' },
  '*': { bp: BP_MUL, op: '*', assoc: 'left' },
  '/': { bp: BP_MUL, op: '/', assoc: 'left' },
  '%': { bp: BP_MUL, op: '%', assoc: 'left' },
};

export function parse(sql: string): Stmt[] {
  return new Parser(tokenize(sql)).parseAll();
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private get cur(): Token {
    return this.toks[this.i]!;
  }
  private peek(off = 1): Token {
    return this.toks[Math.min(this.i + off, this.toks.length - 1)]!;
  }
  private atEof(): boolean {
    return this.toks[this.i]!.type === 'eof';
  }
  private fail(msg: string, tok: Token = this.cur): never {
    const near = tok.type === 'eof' ? 'end of input' : `"${tok.text}"`;
    throw new SqlSyntaxError(`syntax error at or near ${near}: ${msg}`, tok.pos);
  }
  private isKw(kw: string): boolean {
    return this.cur.type === 'keyword' && this.cur.text === kw;
  }
  private isOp(op: string): boolean {
    return this.cur.type === 'op' && this.cur.text === op;
  }
  private acceptKw(kw: string): boolean {
    if (this.isKw(kw)) {
      this.i++;
      return true;
    }
    return false;
  }
  private acceptOp(op: string): boolean {
    if (this.isOp(op)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expectKw(kw: string): void {
    if (!this.acceptKw(kw)) this.fail(`expected ${kw}`);
  }
  private expectOp(op: string): void {
    if (!this.acceptOp(op)) this.fail(`expected "${op}"`);
  }
  private ident(): string {
    if (this.cur.type !== 'ident') this.fail('expected identifier');
    return this.toks[this.i++]!.text;
  }
  private integer(): number {
    if (this.cur.type !== 'number') this.fail('expected integer');
    return Number(this.toks[this.i++]!.text);
  }

  parseAll(): Stmt[] {
    const out: Stmt[] = [];
    while (!this.atEof()) {
      if (this.acceptOp(';')) continue;
      out.push(this.statement());
      if (!this.atEof()) this.expectOp(';');
    }
    return out;
  }

  private statement(): Stmt {
    if (this.isKw('SELECT')) return this.select();
    if (this.acceptKw('EXPLAIN')) {
      if (!this.isKw('SELECT')) this.fail('EXPLAIN supports SELECT only');
      return { kind: 'explain', stmt: this.select() };
    }
    if (this.acceptKw('INSERT')) return this.insert();
    if (this.acceptKw('UPDATE')) return this.update();
    if (this.acceptKw('DELETE')) return this.delete_();
    if (this.acceptKw('CREATE')) return this.create();
    if (this.acceptKw('DROP')) return this.drop();
    if (this.acceptKw('BEGIN')) return { kind: 'begin' };
    if (this.acceptKw('COMMIT')) return { kind: 'commit' };
    if (this.acceptKw('ROLLBACK')) return { kind: 'rollback' };
    if (this.acceptKw('CHECKPOINT')) return { kind: 'checkpoint' };
    this.fail('expected a statement');
  }

  // ---- SELECT ----
  private select(): SelectStmt {
    this.expectKw('SELECT');
    const columns: SelectItem[] = [];
    do {
      if (this.acceptOp('*')) columns.push({ kind: 'star' });
      else if (this.cur.type === 'ident' && this.peek().type === 'op' && this.peek().text === '.' && this.peek(2).type === 'op' && this.peek(2).text === '*') {
        const table = this.ident();
        this.i += 2;
        columns.push({ kind: 'star', table });
      } else {
        const expr = this.expr();
        let alias: string | undefined;
        if (this.acceptKw('AS')) alias = this.ident();
        else if (this.cur.type === 'ident') alias = this.ident();
        columns.push(alias === undefined ? { kind: 'expr', expr } : { kind: 'expr', expr, alias });
      }
    } while (this.acceptOp(','));
    const stmt: SelectStmt = { kind: 'select', columns, joins: [], orderBy: [] };
    if (this.acceptKw('FROM')) {
      stmt.from = this.tableRef();
      for (;;) {
        for (const kw of ['LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL']) if (this.isKw(kw)) this.fail(`${kw} JOIN is not supported (only INNER JOIN)`);
        if (!(this.isKw('JOIN') || this.isKw('INNER'))) break;
        this.acceptKw('INNER');
        this.expectKw('JOIN');
        const table = this.tableRef();
        if (this.isKw('USING')) this.fail('JOIN ... USING is not supported (use ON)');
        this.expectKw('ON');
        const on = this.expr();
        const j: JoinClause = { table, on };
        stmt.joins.push(j);
      }
    }
    if (this.acceptKw('WHERE')) stmt.where = this.expr();
    if (this.acceptKw('ORDER')) {
      this.expectKw('BY');
      do {
        const expr = this.expr();
        let desc = false;
        if (this.acceptKw('DESC')) desc = true;
        else this.acceptKw('ASC');
        stmt.orderBy.push({ expr, desc });
      } while (this.acceptOp(','));
    }
    if (this.acceptKw('LIMIT')) stmt.limit = this.integer();
    if (this.acceptKw('OFFSET')) stmt.offset = this.integer();
    return stmt;
  }

  private tableRef(): TableRef {
    const name = this.ident();
    if (this.acceptKw('AS')) return { name, alias: this.ident() };
    if (this.cur.type === 'ident') return { name, alias: this.ident() };
    return { name };
  }

  // ---- INSERT ----
  private insert(): Stmt {
    this.expectKw('INTO');
    const table = this.ident();
    let columns: string[] | undefined;
    if (this.acceptOp('(')) {
      columns = [];
      do columns.push(this.ident());
      while (this.acceptOp(','));
      this.expectOp(')');
    }
    this.expectKw('VALUES');
    const rows: Expr[][] = [];
    do {
      this.expectOp('(');
      const row: Expr[] = [];
      do row.push(this.expr());
      while (this.acceptOp(','));
      this.expectOp(')');
      rows.push(row);
    } while (this.acceptOp(','));
    return columns ? { kind: 'insert', table, columns, rows } : { kind: 'insert', table, rows };
  }

  // ---- UPDATE / DELETE ----
  private update(): Stmt {
    const table = this.ident();
    this.expectKw('SET');
    const assignments: { column: string; expr: Expr }[] = [];
    do {
      const column = this.ident();
      this.expectOp('=');
      assignments.push({ column, expr: this.expr() });
    } while (this.acceptOp(','));
    const where = this.acceptKw('WHERE') ? this.expr() : undefined;
    return where ? { kind: 'update', table, assignments, where } : { kind: 'update', table, assignments };
  }

  private delete_(): Stmt {
    this.expectKw('FROM');
    const table = this.ident();
    const where = this.acceptKw('WHERE') ? this.expr() : undefined;
    return where ? { kind: 'delete', table, where } : { kind: 'delete', table };
  }

  // ---- DDL ----
  private create(): Stmt {
    if (this.acceptKw('TABLE')) {
      const name = this.ident();
      this.expectOp('(');
      const columns: ColumnSpec[] = [];
      do {
        const cname = this.ident();
        const type = this.dataType();
        let notNull = false;
        let pk = false;
        for (;;) {
          if (this.acceptKw('NOT')) {
            this.expectKw('NULL');
            notNull = true;
          } else if (this.acceptKw('PRIMARY')) {
            this.expectKw('KEY');
            pk = true;
          } else if (this.acceptKw('NULL')) {
            // explicit nullable, no-op
          } else break;
        }
        columns.push({ name: cname, type, notNull, pk });
      } while (this.acceptOp(','));
      this.expectOp(')');
      if (columns.length === 0) this.fail('table must have at least one column');
      return { kind: 'create_table', name, columns };
    }
    const unique = this.acceptKw('UNIQUE');
    this.expectKw('INDEX');
    const name = this.ident();
    this.expectKw('ON');
    const table = this.ident();
    this.expectOp('(');
    const column = this.ident();
    this.expectOp(')');
    return { kind: 'create_index', name, table, column, unique };
  }

  private dataType(): DataType {
    if (this.acceptKw('INT') || this.acceptKw('INTEGER')) return 'INT';
    if (this.acceptKw('TEXT')) return 'TEXT';
    if (this.acceptKw('BOOL') || this.acceptKw('BOOLEAN')) return 'BOOL';
    this.fail('expected a type (INT, TEXT, BOOL)');
  }

  private drop(): Stmt {
    const what = this.acceptKw('TABLE') ? 'table' : this.acceptKw('INDEX') ? 'index' : this.fail('expected TABLE or INDEX');
    let ifExists = false;
    if (this.acceptKw('IF')) {
      this.expectKw('EXISTS');
      ifExists = true;
    }
    return { kind: 'drop', what, name: this.ident(), ifExists };
  }

  // ---- expressions (Pratt) ----
  expr(minBp = 0): Expr {
    let left = this.prefix();
    for (;;) {
      const t = this.cur;
      // IS [NOT] NULL: postfix at comparison level
      if (t.type === 'keyword' && t.text === 'IS') {
        if (BP_CMP < minBp) break;
        this.i++;
        const negated = this.acceptKw('NOT');
        this.expectKw('NULL');
        left = { kind: 'isnull', expr: left, negated };
        continue;
      }
      const key = t.type === 'keyword' || t.type === 'op' ? t.text : '';
      const info = INFIX[key];
      if (!info || info.bp < minBp) break;
      this.i++;
      const right = this.expr(info.bp + 1);
      left = { kind: 'binary', op: info.op, left, right };
      if (info.assoc === 'none') {
        const nt = this.cur;
        const nk = nt.type === 'keyword' || nt.type === 'op' ? nt.text : '';
        if (INFIX[nk]?.bp === BP_CMP) this.fail('comparison operators are not associative');
      }
    }
    return left;
  }

  private paramCount = 0;

  private prefix(): Expr {
    const t = this.cur;
    if (t.type === 'param') {
      this.i++;
      const index = this.paramCount++;
      return t.text ? { kind: 'param', index, name: t.text } : { kind: 'param', index };
    }
    if (t.type === 'number') {
      this.i++;
      const n = Number(t.text);
      if (!Number.isSafeInteger(n)) this.fail('integer literal out of range', t);
      return { kind: 'literal', value: n };
    }
    if (t.type === 'string') {
      this.i++;
      return { kind: 'literal', value: t.text };
    }
    if (t.type === 'keyword') {
      if (t.text === 'TRUE' || t.text === 'FALSE') {
        this.i++;
        return { kind: 'literal', value: t.text === 'TRUE' };
      }
      if (t.text === 'NULL') {
        this.i++;
        return { kind: 'literal', value: null };
      }
      if (t.text === 'NOT') {
        this.i++;
        return { kind: 'not', expr: this.expr(BP_NOT) };
      }
    }
    if (t.type === 'op') {
      if (t.text === '-') {
        this.i++;
        const e = this.expr(BP_UNARY);
        if (e.kind === 'literal' && typeof e.value === 'number') return { kind: 'literal', value: -e.value };
        return { kind: 'neg', expr: e };
      }
      if (t.text === '+') {
        this.i++;
        return this.expr(BP_UNARY);
      }
      if (t.text === '(') {
        this.i++;
        const e = this.expr();
        this.expectOp(')');
        return e;
      }
    }
    if (t.type === 'ident') {
      this.i++;
      if (this.isOp('.') && this.peek().type === 'ident') {
        this.i++;
        return { kind: 'column', table: t.text, name: this.ident() };
      }
      return { kind: 'column', name: t.text };
    }
    this.fail('expected an expression');
  }
}
