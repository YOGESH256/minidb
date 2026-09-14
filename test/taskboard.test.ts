/**
 * The demo app, driven through the same functions the terminal UI calls.
 * This is the test of the idea, not of the engine: can an application get
 * live views, an activity log and undo without keeping any state of its own?
 */
import { describe, it, expect } from 'vitest';
import { Board, type Task } from '../examples/taskboard/board.js';
import { Database, UndoConflictError } from '../src/index.js';
import { FaultFS } from './helpers.js';

function seeded(): Board {
  const b = Board.create();
  b.addProject(1, 'Demo');
  b.bulk('seed', () => {
    b.addTask(1, 'protocol page', 3, 'yogesh');
    b.addTask(1, 'measure reads', 5, 'yogesh');
    b.addTask(1, 'decide', null, null);
  });
  return b;
}

describe('task board demo', () => {
  it('columns stay live without the app ever asking for a refresh', () => {
    const b = seeded();
    const todo: Task[][] = [];
    const doing: Task[][] = [];
    b.watchColumn(1, 'todo', (t) => todo.push(t));
    b.watchColumn(1, 'doing', (t) => doing.push(t));
    expect(todo.at(-1)!.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(doing.at(-1)).toEqual([]);

    b.move(2, 'doing');
    expect(todo.at(-1)!.map((t) => t.id)).toEqual([1, 3]);
    expect(doing.at(-1)!.map((t) => t.id)).toEqual([2]);

    b.rename(2, 'measure cold reads'); // in a watched column: that column only
    expect(doing.at(-1)![0]!.title).toBe('measure cold reads');
    const todoCalls = todo.length;
    expect(todoCalls).toBe(2); // initial + the move; the rename did not touch it
    b.close();
  });

  it('the activity log and transaction list come from the database, not the app', () => {
    const b = seeded();
    b.move(1, 'done');
    b.rename(3, 'decide on the rewrite');
    b.remove(2);
    const log = b.activity();
    expect(log[0]!.line).toBe('deleted "measure reads"');
    expect(log[1]!.line).toBe('"decide" title: decide → decide on the rewrite');
    expect(log[2]!.line).toBe('"protocol page" status: todo → done');
    expect(log.slice(3).map((l) => l.line)).toEqual(['added "decide"', 'added "measure reads"', 'added "protocol page"']);
    const txns = b.transactions();
    expect(txns[0]).toMatchObject({ rows: 1, summary: '1 delete' });
    expect(txns.at(-1)).toMatchObject({ rows: 3, summary: '3 insert' }); // the seed was one transaction
    b.close();
  });

  it('a bulk edit is one transaction: reviewable, then undoable as a unit', () => {
    const b = seeded();
    b.move(1, 'done');
    const before = b.tasks(1);
    const txn = b.bulk('assistant', () => {
      for (const t of b.tasks(1)) {
        if (t.status !== 'done') b.move(t.id, 'done');
        if (t.points === null) b.db.prepare('UPDATE tasks SET points = ? WHERE id = ?').run(1, t.id);
      }
      b.addTask(1, 'Follow-up from assistant', 1, 'assistant');
    });
    const review = b.review(txn);
    expect(review.map((r) => r.line)).toEqual([
      '"measure reads" status: todo → done',
      '"decide" status: todo → done',
      '"decide" points: none → 1',
      'added "Follow-up from assistant"',
    ]);
    expect(b.transactions(1)[0]).toMatchObject({ txn, rows: 4 });

    expect(b.undo(txn)).toBe(4);
    expect(b.tasks(1)).toEqual(before);
    expect(b.transactions(1)[0]!.txn).toBe(txn + 1); // the undo is itself a transaction
    b.close();
  });

  it('undo refuses when someone edited a row after the transaction, and says which', () => {
    const b = seeded();
    const txn = b.bulk('assistant', () => {
      b.move(1, 'done');
      b.move(2, 'done');
    });
    b.rename(2, 'edited by a human'); // conflicts with the undo
    let err: UndoConflictError | null = null;
    try {
      b.undo(txn);
    } catch (e) {
      err = e as UndoConflictError;
    }
    expect(err).toBeInstanceOf(UndoConflictError);
    expect(err!.conflicts).toEqual([{ table: 'tasks', key: 2, reason: 'modified since' }]);
    expect(b.tasks(1).map((t) => t.status)).toEqual(['done', 'done', 'todo']); // nothing rolled back
    b.close();
  });

  it('live views keep working across an undo', () => {
    const b = seeded();
    const done: number[] = [];
    b.watchColumn(1, 'done', (t) => done.push(t.length));
    const txn = b.bulk('assistant', () => {
      b.move(1, 'done');
      b.move(2, 'done');
    });
    expect(done).toEqual([0, 2]);
    b.undo(txn);
    expect(done).toEqual([0, 2, 0]);
    b.close();
  });

  it('a board reopened from disk keeps its history and its ids', () => {
    const fs = new FaultFS();
    const opts = { fs: fs.fs, history: true } as const;
    const b1 = Board.fromDb(new Database('/board.db', opts));
    b1.addProject(1, 'Demo');
    const id = b1.addTask(1, 'survives a restart', 1, null);
    b1.move(id, 'doing');
    b1.close();

    const b2 = Board.fromDb(new Database('/board.db', opts));
    expect(b2.tasks(1).map((t) => t.title)).toEqual(['survives a restart']);
    expect(b2.activity().map((a) => a.line)).toEqual(['"survives a restart" status: todo → doing', 'added "survives a restart"']);
    expect(b2.addTask(1, 'second', null, null)).toBe(id + 1); // the id counter continued
    expect(b2.undo(b2.transactions(3)[1]!.txn)).toBe(1); // undo the move, across the restart
    expect(b2.tasks(1)[0]!.status).toBe('todo');
    expect(b2.db.verify().ok).toBe(true);
    b2.close();
  });
});
