#!/usr/bin/env node
import readline from 'node:readline';
import { Database, type QueryResult } from './index.js';
import { formatValue } from './types.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: minidb <file.db>');
  process.exit(2);
}
const db = new Database(path);
console.log(`minidb 0.1.0 — ${path}\nType SQL ending with ';', or .help`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'minidb> ' });
let buf = '';
rl.prompt();
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (buf === '' && trimmed.startsWith('.')) {
    meta(trimmed);
    rl.prompt();
    return;
  }
  buf += line + '\n';
  if (!trimmed.endsWith(';')) {
    rl.setPrompt('   ...> ');
    rl.prompt();
    return;
  }
  const sql = buf;
  buf = '';
  try {
    const t0 = performance.now();
    const results = db.exec(sql);
    const ms = (performance.now() - t0).toFixed(1);
    for (const r of results) print(r);
    console.log(`(${ms} ms)`);
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
  }
  rl.setPrompt(db.inTransaction ? 'minidb*> ' : 'minidb> ');
  rl.prompt();
});
rl.on('close', () => {
  db.close();
  process.exit(0);
});

function meta(cmd: string): void {
  switch (cmd.split(/\s+/)[0]) {
    case '.help':
      console.log('.tables  .schema [table]  .indexes  .stats  .exit');
      break;
    case '.tables':
      for (const t of db.catalog.allTables()) if (!t.system) console.log(t.name);
      break;
    case '.schema': {
      const which = cmd.split(/\s+/)[1];
      for (const t of db.catalog.allTables()) {
        if (t.system || (which && t.name !== which)) continue;
        const cols = t.columns.map((c) => `  ${c.name} ${c.type}${c.pk ? ' PRIMARY KEY' : c.notNull ? ' NOT NULL' : ''}`);
        console.log(`CREATE TABLE ${t.name} (\n${cols.join(',\n')}\n);`);
        for (const i of t.indexes) if (!i.name.endsWith('_pkey')) console.log(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${i.name} ON ${t.name} (${i.column});`);
      }
      break;
    }
    case '.indexes':
      for (const t of db.catalog.allTables()) for (const i of t.indexes) console.log(`${i.name}  ON ${t.name}(${i.column})${i.unique ? '  UNIQUE' : ''}`);
      break;
    case '.stats':
      console.log(JSON.stringify({ ...db.pager.stats, ...db.pager.getMeta() }, null, 2));
      break;
    case '.exit':
    case '.quit':
      rl.close();
      break;
    default:
      console.log(`unknown command ${cmd}`);
  }
}

function print(r: QueryResult): void {
  if (r.columns.length === 0) {
    console.log(r.rowCount ? `${r.command} ${r.rowCount}` : r.command);
    return;
  }
  const cells = r.rows.map((row) => row.map(formatValue));
  const widths = r.columns.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)));
  const line = (row: string[]) => ' ' + row.map((c, i) => c.padEnd(widths[i]!)).join(' | ');
  console.log(line(r.columns));
  console.log(widths.map((w) => '-'.repeat(w + 2)).join('+'));
  for (const row of cells) console.log(line(row));
  console.log(`(${r.rows.length} row${r.rows.length === 1 ? '' : 's'})`);
}
