/**
 * The application logic of the demo, with no terminal code in it, so the
 * tests can drive the same functions the UI does.
 *
 * Everything the screen shows comes from a watch(): the app never tells the
 * view to refresh. Every change leaves a receipt, so the activity log and
 * undo are reads of the database rather than bookkeeping the app maintains.
 */
import { Database, type ChangeRecord, type RowObject, type Value } from '../../src/index.js';

export const SCHEMA = `
CREATE TABLE projects (id INT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE tasks (
  id INT PRIMARY KEY,
  project_id INT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,        -- todo | doing | done
  points INT,
  assignee TEXT
);
CREATE INDEX tasks_project ON tasks (project_id);
CREATE INDEX tasks_status ON tasks (status);
`;

export interface Task {
  id: number;
  project_id: number;
  title: string;
  status: string;
  points: Value;
  assignee: Value;
}

export class Board {
  private nextTaskId = 1;

  constructor(readonly db: Database) {}

  /**
   * Wrap a database: create the schema if it is new, and continue the id
   * counter from what is already stored, so reopening a board is seamless.
   */
  static fromDb(db: Database): Board {
    if (!db.catalog.getTable('tasks')) db.exec(SCHEMA);
    const b = new Board(db);
    b.nextTaskId = ((db.query('SELECT id FROM tasks ORDER BY id DESC LIMIT 1').rows[0]?.[0] as number) ?? 0) + 1;
    return b;
  }

  static create(path = ':memory:'): Board {
    return Board.fromDb(new Database(path, { history: true }));
  }

  /** Reopen an existing board file: history and ids continue where they left off. */
  static open(path: string): Board {
    return Board.fromDb(new Database(path, { history: true }));
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ writes

  addProject(id: number, name: string): void {
    this.db.prepare('INSERT INTO projects VALUES (?, ?)').run(id, name);
  }

  addTask(projectId: number, title: string, points: number | null = null, assignee: string | null = null): number {
    const id = this.nextTaskId++;
    this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)').run(id, projectId, title, 'todo', points, assignee);
    return id;
  }

  move(id: number, status: 'todo' | 'doing' | 'done'): void {
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  }

  rename(id: number, title: string): void {
    this.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  /**
   * A batch edit, the kind an assistant or an import would make: one
   * transaction, so it shows up as a single entry in the log and undoes
   * as a single unit.
   */
  bulk(label: string, fn: () => void): number {
    const before = this.db.lastTxn();
    this.db.transaction(fn)();
    const after = this.db.lastTxn();
    if (after === before) throw new Error(`"${label}" changed nothing`);
    return after;
  }

  // ------------------------------------------------------------ reads

  tasks(projectId: number): Task[] {
    return this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(projectId) as unknown as Task[];
  }

  /** Live column: called immediately and after every commit that changes it. */
  watchColumn(projectId: number, status: string, cb: (tasks: Task[]) => void): () => void {
    return this.db.watch('SELECT id, title, points, assignee FROM tasks WHERE project_id = $p AND status = $s ORDER BY id', { p: projectId, s: status }, (rows) => cb(rows as unknown as Task[]));
  }

  watchCount(projectId: number, cb: (n: number) => void): () => void {
    // No aggregates in the engine yet: watch the rows and count them here.
    return this.db.watch('SELECT id FROM tasks WHERE project_id = $p', { p: projectId }, (rows: RowObject[]) => cb(rows.length));
  }

  // ------------------------------------------------------------ activity + undo

  /** The activity log, newest first, one line per changed row. */
  activity(limit = 20): { txn: number; line: string; change: ChangeRecord }[] {
    const cols = this.db.catalog.mustGetTable('tasks').columns.map((c) => c.name);
    const at = (row: Value[] | null, name: string): Value => (row ? row[cols.indexOf(name)]! : null);
    return this.db
      .changes({ table: 'tasks' })
      .slice(-limit)
      .reverse()
      .map((c) => {
        const title = at(c.after ?? c.before, 'title');
        let line: string;
        if (c.op === 'INSERT') line = `added "${title}"`;
        else if (c.op === 'DELETE') line = `deleted "${title}"`;
        else {
          const changed = cols.filter((n, i) => JSON.stringify(c.before![i]) !== JSON.stringify(c.after![i]));
          line = changed.map((n) => `${n}: ${fmt(at(c.before, n))} → ${fmt(at(c.after, n))}`).join(', ');
          line = `"${at(c.before, 'title')}" ${line}`;
        }
        return { txn: c.txn, line, change: c };
      });
  }

  /** Transactions that touched tasks, newest first, with how many rows each changed. */
  transactions(limit = 10): { txn: number; rows: number; summary: string }[] {
    const byTxn = new Map<number, ChangeRecord[]>();
    for (const c of this.db.changes({ table: 'tasks' })) {
      if (!byTxn.has(c.txn)) byTxn.set(c.txn, []);
      byTxn.get(c.txn)!.push(c);
    }
    return [...byTxn.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, limit)
      .map(([txn, cs]) => {
        const ops = cs.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.op]: (acc[c.op] ?? 0) + 1 }), {});
        return { txn, rows: cs.length, summary: Object.entries(ops).map(([op, n]) => `${n} ${op.toLowerCase()}`).join(', ') };
      });
  }

  /** What one transaction did, for a review-before-accepting screen. */
  review(txn: number): { line: string }[] {
    return this.activity(1000)
      .filter((a) => a.txn === txn)
      .reverse()
      .map((a) => ({ line: a.line }));
  }

  undo(txn: number): number {
    return this.db.undo(txn).reverted;
  }
}

function fmt(v: Value): string {
  return v === null ? 'none' : String(v);
}
