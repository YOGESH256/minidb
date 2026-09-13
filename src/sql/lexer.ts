export type TokenType = 'keyword' | 'ident' | 'number' | 'string' | 'op' | 'param' | 'eof';

export interface Token {
  type: TokenType;
  text: string; // keywords uppercased, identifiers as written (lowercased unless quoted)
  pos: number;
}

export class SqlSyntaxError extends Error {
  constructor(msg: string, public readonly pos: number) {
    super(msg);
    this.name = 'SqlSyntaxError';
  }
}

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'DROP', 'TABLE', 'INDEX',
  'UNIQUE', 'ON', 'PRIMARY', 'KEY', 'NOT', 'NULL', 'AND', 'OR', 'IS', 'TRUE', 'FALSE', 'AS', 'JOIN', 'INNER', 'ORDER',
  'BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'BEGIN', 'COMMIT', 'ROLLBACK', 'INT', 'INTEGER', 'TEXT', 'BOOL', 'BOOLEAN',
  'IF', 'EXISTS', 'EXPLAIN', 'CHECKPOINT', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'USING',
]);

const OPS = ['<>', '!=', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '%', '(', ')', ',', ';', '.'];

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new SqlSyntaxError('unterminated comment', i);
      i = end + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= n) throw new SqlSyntaxError('unterminated string literal', i);
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += sql[j];
        j++;
      }
      out.push({ type: 'string', text: s, pos: i });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) throw new SqlSyntaxError('unterminated quoted identifier', i);
      out.push({ type: 'ident', text: sql.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    if (c === '?') {
      out.push({ type: 'param', text: '', pos: i });
      i++;
      continue;
    }
    if ((c === '$' || c === ':') && /[a-zA-Z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(sql[j]!)) j++;
      out.push({ type: 'param', text: sql.slice(i + 1, j), pos: i });
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < n && sql[j]! >= '0' && sql[j]! <= '9') j++;
      if (j < n && (sql[j] === '.' || /[a-zA-Z_]/.test(sql[j]!))) throw new SqlSyntaxError('invalid number', i);
      out.push({ type: 'number', text: sql.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      const up = word.toUpperCase();
      if (KEYWORDS.has(up)) out.push({ type: 'keyword', text: up, pos: i });
      else out.push({ type: 'ident', text: word.toLowerCase(), pos: i });
      i = j;
      continue;
    }
    const op = OPS.find((o) => sql.startsWith(o, i));
    if (!op) throw new SqlSyntaxError(`unexpected character '${c}'`, i);
    out.push({ type: 'op', text: op, pos: i });
    i += op.length;
  }
  out.push({ type: 'eof', text: '', pos: n });
  return out;
}
