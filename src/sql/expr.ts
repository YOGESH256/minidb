/**
 * Names and types.
 *
 * A Scope knows which tables are in play and where each column sits in the
 * flat row array the executor passes around (table A's columns, then B's...).
 * `compile` turns a parsed expression into { type, eval(row) }: a closure
 * that computes the value for one row, with all type checking done up front,
 * once, not per row. Strict like Postgres: INT = TEXT is an error, not false.
 * NULL uses three-valued logic (NULL = 1 is NULL, not false).
 */
import type { Expr } from './ast.js';
import type { TableDef } from '../catalog.js';
import { compareValues, checkInt, typeOfValue, TypeError_, type DataType, type Value } from '../types.js';

/** Name resolution over a flat row made of one or more tables' columns. */
export interface ScopeEntry {
  alias: string;
  table: TableDef;
  offset: number;
}

export class Scope {
  readonly entries: ScopeEntry[] = [];
  width = 0;

  add(alias: string, table: TableDef): ScopeEntry {
    if (this.entries.some((e) => e.alias === alias)) throw new TypeError_(`table name "${alias}" specified more than once`);
    const e = { alias, table, offset: this.width };
    this.entries.push(e);
    this.width += table.columns.length;
    return e;
  }

  resolve(table: string | undefined, name: string): { index: number; type: DataType; entry: ScopeEntry; column: number } {
    let found: { index: number; type: DataType; entry: ScopeEntry; column: number } | null = null;
    for (const e of this.entries) {
      if (table !== undefined && e.alias !== table) continue;
      const ci = e.table.columns.findIndex((c) => c.name === name);
      if (ci < 0) continue;
      if (found) throw new TypeError_(`column reference "${name}" is ambiguous`);
      found = { index: e.offset + ci, type: e.table.columns[ci]!.type, entry: e, column: ci };
    }
    if (!found) {
      if (table !== undefined && !this.entries.some((e) => e.alias === table)) throw new TypeError_(`missing FROM-clause entry for table "${table}"`);
      throw new TypeError_(`column "${table ? table + '.' : ''}${name}" does not exist`);
    }
    return found;
  }

  /** Which scope entries an AST expression references. */
  refs(expr: Expr): Set<number> {
    const out = new Set<number>();
    const walk = (e: Expr): void => {
      switch (e.kind) {
        case 'column':
          out.add(this.entries.indexOf(this.resolve(e.table, e.name).entry));
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
        case 'literal':
        case 'param':
          break;
      }
    };
    walk(expr);
    return out;
  }
}

export interface Compiled {
  /** null = untyped NULL literal (adopts the other operand's type). */
  type: DataType | null;
  eval: (row: readonly Value[]) => Value;
  /** True when no column is referenced. */
  isConst: boolean;
  /** For plain column refs: index into the row. */
  columnIndex?: number;
}

const TYPE_NAME = (t: DataType | null) => t ?? 'NULL';

function unify(a: DataType | null, b: DataType | null, op: string): DataType | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a !== b) throw new TypeError_(`operator does not exist: ${a} ${op} ${b}`);
  return a;
}

function expectType(c: Compiled, want: DataType, what: string): void {
  if (c.type !== null && c.type !== want) throw new TypeError_(`argument of ${what} must be type ${want}, not type ${TYPE_NAME(c.type)}`);
}

export function compile(expr: Expr, scope: Scope): Compiled {
  switch (expr.kind) {
    case 'param':
      throw new TypeError_(`unbound parameter ${expr.name ? '$' + expr.name : '?'} (pass values via prepare().run/get/all)`);
    case 'literal': {
      const v = expr.value;
      return { type: typeOfValue(v), eval: () => v, isConst: true };
    }
    case 'column': {
      const r = scope.resolve(expr.table, expr.name);
      const i = r.index;
      return { type: r.type, eval: (row) => row[i]!, isConst: false, columnIndex: i };
    }
    case 'not': {
      const c = compile(expr.expr, scope);
      expectType(c, 'BOOL', 'NOT');
      return { type: 'BOOL', eval: (row) => notV(c.eval(row)), isConst: c.isConst };
    }
    case 'neg': {
      const c = compile(expr.expr, scope);
      expectType(c, 'INT', 'unary minus');
      return {
        type: 'INT',
        eval: (row) => {
          const v = c.eval(row);
          return v === null ? null : checkInt(-(v as number));
        },
        isConst: c.isConst,
      };
    }
    case 'isnull': {
      const c = compile(expr.expr, scope);
      const neg = expr.negated;
      return { type: 'BOOL', eval: (row) => (c.eval(row) === null) !== neg, isConst: c.isConst };
    }
    case 'binary': {
      const l = compile(expr.left, scope);
      const r = compile(expr.right, scope);
      const isConst = l.isConst && r.isConst;
      switch (expr.op) {
        case 'AND':
          expectType(l, 'BOOL', 'AND');
          expectType(r, 'BOOL', 'AND');
          return {
            type: 'BOOL',
            isConst,
            eval: (row) => {
              const a = l.eval(row);
              if (a === false) return false;
              const b = r.eval(row);
              if (b === false) return false;
              return a === null || b === null ? null : true;
            },
          };
        case 'OR':
          expectType(l, 'BOOL', 'OR');
          expectType(r, 'BOOL', 'OR');
          return {
            type: 'BOOL',
            isConst,
            eval: (row) => {
              const a = l.eval(row);
              if (a === true) return true;
              const b = r.eval(row);
              if (b === true) return true;
              return a === null || b === null ? null : false;
            },
          };
        case '+':
        case '-':
        case '*':
        case '/':
        case '%': {
          const t = unify(l.type, r.type, expr.op);
          if (t !== null && t !== 'INT') throw new TypeError_(`operator does not exist: ${t} ${expr.op} ${t}`);
          const op = expr.op;
          return {
            type: 'INT',
            isConst,
            eval: (row) => {
              const a = l.eval(row) as number | null;
              const b = r.eval(row) as number | null;
              if (a === null || b === null) return null;
              switch (op) {
                case '+':
                  return checkInt(a + b);
                case '-':
                  return checkInt(a - b);
                case '*':
                  return checkInt(a * b);
                case '/':
                  if (b === 0) throw new TypeError_('division by zero');
                  return Math.trunc(a / b);
                case '%':
                  if (b === 0) throw new TypeError_('division by zero');
                  return a % b;
              }
            },
          };
        }
        default: {
          const t = unify(l.type, r.type, expr.op);
          const op = expr.op;
          return {
            type: 'BOOL',
            isConst,
            eval: (row) => {
              const a = l.eval(row);
              const b = r.eval(row);
              if (a === null || b === null) return null;
              const c = compareValues(t ?? typeOfValue(a)!, a, b);
              switch (op) {
                case '=':
                  return c === 0;
                case '!=':
                  return c !== 0;
                case '<':
                  return c < 0;
                case '<=':
                  return c <= 0;
                case '>':
                  return c > 0;
                case '>=':
                  return c >= 0;
              }
              return null;
            },
          };
        }
      }
    }
  }
}

function notV(v: Value): Value {
  return v === null ? null : !(v as boolean);
}

/** Split a predicate into AND-ed conjuncts. */
export function conjuncts(expr: Expr | undefined): Expr[] {
  if (!expr) return [];
  if (expr.kind === 'binary' && expr.op === 'AND') return [...conjuncts(expr.left), ...conjuncts(expr.right)];
  return [expr];
}

export function andAll(exprs: Expr[]): Expr | undefined {
  if (exprs.length === 0) return undefined;
  return exprs.reduce((a, b) => ({ kind: 'binary', op: 'AND', left: a, right: b }));
}
