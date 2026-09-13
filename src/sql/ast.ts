import type { DataType, Value } from '../types.js';

export type BinaryOp = 'OR' | 'AND' | '=' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%';

export type Expr =
  | { kind: 'literal'; value: Value }
  /** `?` (index = position among all `?`s, 0-based) or `$name` / `:name`. Replaced by a literal before planning. */
  | { kind: 'param'; index: number; name?: string }
  | { kind: 'column'; table?: string; name: string }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'not'; expr: Expr }
  | { kind: 'neg'; expr: Expr }
  | { kind: 'isnull'; expr: Expr; negated: boolean };

export type SelectItem = { kind: 'star'; table?: string } | { kind: 'expr'; expr: Expr; alias?: string };

export interface TableRef {
  name: string;
  alias?: string;
}

export interface JoinClause {
  table: TableRef;
  on: Expr;
}

export interface SelectStmt {
  kind: 'select';
  columns: SelectItem[];
  from?: TableRef;
  joins: JoinClause[];
  where?: Expr;
  orderBy: { expr: Expr; desc: boolean }[];
  limit?: number;
  offset?: number;
}

export interface InsertStmt {
  kind: 'insert';
  table: string;
  columns?: string[];
  rows: Expr[][];
}

export interface UpdateStmt {
  kind: 'update';
  table: string;
  assignments: { column: string; expr: Expr }[];
  where?: Expr;
}

export interface DeleteStmt {
  kind: 'delete';
  table: string;
  where?: Expr;
}

export interface ColumnSpec {
  name: string;
  type: DataType;
  notNull: boolean;
  pk: boolean;
}

export interface CreateTableStmt {
  kind: 'create_table';
  name: string;
  columns: ColumnSpec[];
}

export interface CreateIndexStmt {
  kind: 'create_index';
  name: string;
  table: string;
  column: string;
  unique: boolean;
}

export interface DropStmt {
  kind: 'drop';
  what: 'table' | 'index';
  name: string;
  ifExists: boolean;
}

export interface TxnStmt {
  kind: 'begin' | 'commit' | 'rollback' | 'checkpoint';
}

export interface ExplainStmt {
  kind: 'explain';
  stmt: SelectStmt;
}

export type Stmt = SelectStmt | InsertStmt | UpdateStmt | DeleteStmt | CreateTableStmt | CreateIndexStmt | DropStmt | TxnStmt | ExplainStmt;
