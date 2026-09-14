#!/usr/bin/env node
/**
 * A task board in the terminal. The point of the demo: every panel on screen
 * is a watch() on a query, so nothing here ever calls "redraw" after a write.
 * The activity log and undo come from the database's own receipts.
 *
 *   npx tsx examples/taskboard/cli.ts [board.db]
 *
 * Commands:  add <title>        move <id> doing|done|todo      rename <id> <title>
 *            rm <id>            assistant                       undo [txn]
 *            log                txns                            review <txn>
 *            help               quit
 */
import readline from 'node:readline';
import { Board, type Task } from './board.js';

const path = process.argv[2] ?? ':memory:';
const board = path === ':memory:' ? Board.create() : Board.open(path);
const PROJECT = 1;
if (!board.db.query('SELECT id FROM projects WHERE id = 1').rows.length) {
  board.addProject(PROJECT, 'Demo');
  board.bulk('seed', () => {
    board.addTask(PROJECT, 'Write the protocol page', 3, 'yogesh');
    board.addTask(PROJECT, 'Measure cold reads', 5, 'yogesh');
    board.addTask(PROJECT, 'Decide on the rewrite', null, null);
  });
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
/** Pad to a visible width: colour codes take no space on screen. */
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visible(s)));
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

// ---- the live view: three columns, each its own watch()
const columns: Record<string, Task[]> = { todo: [], doing: [], done: [] };
let total = 0;
let dirty = true;
for (const status of ['todo', 'doing', 'done']) {
  board.watchColumn(PROJECT, status, (tasks) => {
    columns[status] = tasks;
    dirty = true;
  });
}
board.watchCount(PROJECT, (n) => {
  total = n;
  dirty = true;
});

function render(): void {
  if (!dirty) return;
  dirty = false;
  const width = 34;
  const rows = Math.max(...Object.values(columns).map((c) => c.length), 1);
  const head = ['todo', 'doing', 'done'].map((s) => pad(bold(` ${s} (${columns[s]!.length})`), width)).join('');
  const lines = [head, dim('─'.repeat(width * 3))];
  for (let i = 0; i < rows; i++) {
    lines.push(
      ['todo', 'doing', 'done']
        .map((s) => {
          const t = columns[s]![i];
          if (!t) return ' '.repeat(width);
          // Fit the card to the column: the title gives up whatever the id,
          // points and assignee need.
          const id = '#' + t.id;
          const points = t.points === null ? '' : ` ${t.points}pt`;
          const who = t.assignee === null ? '' : ` @${String(t.assignee)}`;
          const room = width - 3 - id.length - points.length - who.length;
          const title = t.title.length > room ? t.title.slice(0, Math.max(1, room - 1)) + '…' : t.title;
          return pad(` ${dim(id)} ${title}${dim(points)}${dim(who)}`, width);
        })
        .join(''),
    );
  }
  lines.push(dim(`${total} tasks · last transaction ${board.db.lastTxn()}`));
  console.log('\n' + lines.join('\n') + '\n');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'board> ' });
console.log(bold('minidb task board') + dim(`  ${path}  ·  type help`));
render();
rl.prompt();

rl.on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  try {
    switch (cmd) {
      case '':
        break;
      case 'add':
        if (!arg) throw new Error('add <title>');
        board.addTask(PROJECT, arg);
        break;
      case 'move': {
        const [id, status] = rest;
        if (!id || !['todo', 'doing', 'done'].includes(status ?? '')) throw new Error('move <id> todo|doing|done');
        board.move(Number(id), status as 'todo');
        break;
      }
      case 'rename': {
        const [id, ...title] = rest;
        if (!id || !title.length) throw new Error('rename <id> <title>');
        board.rename(Number(id), title.join(' '));
        break;
      }
      case 'rm':
        board.remove(Number(rest[0]));
        break;
      case 'assistant': {
        // What an agent or a bulk import looks like: one transaction, many rows.
        const txn = board.bulk('assistant', () => {
          for (const t of board.tasks(PROJECT)) {
            if (t.status !== 'done') board.move(t.id, 'done');
            if (t.points === null) board.db.prepare('UPDATE tasks SET points = ? WHERE id = ?').run(1, t.id);
          }
          board.addTask(PROJECT, 'Follow-up from assistant', 1, 'assistant');
        });
        console.log(green(`assistant made transaction ${txn}:`));
        for (const r of board.review(txn)) console.log('  ' + r.line);
        console.log(dim(`  undo ${txn}   to reject all of it`));
        break;
      }
      case 'undo': {
        const txn = rest[0] ? Number(rest[0]) : board.transactions(1)[0]?.txn;
        if (!txn) throw new Error('nothing to undo');
        console.log(green(`reverted ${board.undo(txn)} row changes from transaction ${txn}`));
        break;
      }
      case 'log':
        for (const a of board.activity(12)) console.log(`${dim('txn ' + a.txn)}  ${a.line}`);
        break;
      case 'txns':
        for (const t of board.transactions()) console.log(`${dim('txn ' + t.txn)}  ${t.rows} rows  ${dim(t.summary)}`);
        break;
      case 'review': {
        const txn = Number(rest[0]);
        if (!txn) throw new Error('review <txn>');
        for (const r of board.review(txn)) console.log('  ' + r.line);
        break;
      }
      case 'help':
        console.log(
          [
            'add <title>              add a task to todo',
            'move <id> todo|doing|done',
            'rename <id> <title>      rm <id>',
            'assistant                a bulk edit in one transaction (then try undo)',
            'undo [txn]               revert a transaction, refuses if rows changed since',
            'log                      row-level activity, newest first',
            'txns                     transactions, newest first',
            'review <txn>             what one transaction did',
            'quit',
          ].join('\n'),
        );
        break;
      case 'quit':
      case 'exit':
        rl.close();
        return;
      default:
        console.log(`unknown command "${cmd}", try help`);
    }
  } catch (e) {
    console.error(`\x1b[31m${(e as Error).message}\x1b[0m`);
  }
  render();
  rl.prompt();
});

rl.on('close', () => {
  board.close();
  process.exit(0);
});
