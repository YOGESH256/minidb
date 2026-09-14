/**
 * The list of tables, kept inside the database itself.
 *
 *   __tables   (id, name, root_page)                      one row per table
 *   __columns  (table_id, ordinal, name, type, not_null, pk)   one row per column
 *   __indexes  (id, name, table_id, column_name, meta_page, is_unique)
 *
 * These three are ordinary heaps whose root pages are written in the meta
 * page (page 0). Their own layout is hardcoded below, which is how the
 * chicken-and-egg ("where is the table that lists the tables?") is broken.
 * Everything is read into memory once (`load`) and re-read after a rollback.
 */
import type { Pager } from './storage/pager.js';
import { Heap } from './storage/heap.js';
import { BTree } from './storage/btree.js';
import { encodeTuple, decodeTuple, type DataType, type Value } from './types.js';

/**
 * System catalog, SQLite-style bootstrap: the catalog tables' own schemas are
 * hardcoded here and their heap roots live in the meta page. Everything else
 * is discovered by reading them.
 */

export interface ColumnDef {
  name: string;
  type: DataType;
  notNull: boolean;
  pk: boolean;
}

export interface IndexDef {
  id: number;
  name: string;
  tableId: number;
  column: string;
  columnIndex: number;
  metaPage: number;
  unique: boolean;
}

export interface TableDef {
  id: number;
  name: string;
  rootPage: number;
  columns: ColumnDef[];
  indexes: IndexDef[];
  system: boolean;
}

export class CatalogError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CatalogError';
  }
}

const SYS_TABLES = '__tables';
const SYS_COLUMNS = '__columns';
const SYS_INDEXES = '__indexes';
const SYS_TABLES_COLS: ColumnDef[] = [
  { name: 'id', type: 'INT', notNull: true, pk: false },
  { name: 'name', type: 'TEXT', notNull: true, pk: false },
  { name: 'root_page', type: 'INT', notNull: true, pk: false },
];
const SYS_COLUMNS_COLS: ColumnDef[] = [
  { name: 'table_id', type: 'INT', notNull: true, pk: false },
  { name: 'ordinal', type: 'INT', notNull: true, pk: false },
  { name: 'name', type: 'TEXT', notNull: true, pk: false },
  { name: 'type', type: 'TEXT', notNull: true, pk: false },
  { name: 'not_null', type: 'BOOL', notNull: true, pk: false },
  { name: 'pk', type: 'BOOL', notNull: true, pk: false },
];
export const SYS_CHANGES = '__changes';
/** One receipt per changed row, written in the same transaction as the change. */
export const SYS_CHANGES_COLS: ColumnDef[] = [
  { name: 'txn', type: 'INT', notNull: true, pk: false },
  { name: 'seq', type: 'INT', notNull: true, pk: false },
  { name: 'table_name', type: 'TEXT', notNull: true, pk: false },
  { name: 'op', type: 'TEXT', notNull: true, pk: false }, // INSERT | UPDATE | DELETE
  { name: 'row_key', type: 'TEXT', notNull: false, pk: false }, // JSON of the primary key value, or NULL
  { name: 'before', type: 'TEXT', notNull: false, pk: false }, // JSON array of the old row, or NULL
  { name: 'after', type: 'TEXT', notNull: false, pk: false }, // JSON array of the new row, or NULL
];
const SYS_INDEXES_COLS: ColumnDef[] = [
  { name: 'id', type: 'INT', notNull: true, pk: false },
  { name: 'name', type: 'TEXT', notNull: true, pk: false },
  { name: 'table_id', type: 'INT', notNull: true, pk: false },
  { name: 'column_name', type: 'TEXT', notNull: true, pk: false },
  { name: 'meta_page', type: 'INT', notNull: true, pk: false },
  { name: 'is_unique', type: 'BOOL', notNull: true, pk: false },
];

const types = (cols: ColumnDef[]) => cols.map((c) => c.type);

export class Catalog {
  private tables = new Map<string, TableDef>();
  /** Bumped on every schema change or reload; prepared statements re-plan when it moves. */
  version = 0;
  private sysTables!: Heap;
  private sysColumns!: Heap;
  private sysIndexes!: Heap;

  constructor(private readonly pager: Pager) {
    const meta = pager.getMeta();
    if (meta.tablesRoot === 0) this.bootstrap();
    this.load();
  }

  private bootstrap(): void {
    const p = this.pager;
    p.begin();
    p.setMeta({ tablesRoot: Heap.create(p), columnsRoot: Heap.create(p), indexesRoot: Heap.create(p) });
    p.commit();
  }

  /** Create the __changes heap if the file predates history. Caller holds the transaction. */
  ensureChangesTable(): TableDef {
    let meta = this.pager.getMeta();
    if (meta.changesRoot === 0) {
      this.pager.setMeta({ changesRoot: Heap.create(this.pager) });
      meta = this.pager.getMeta();
      this.tables.set(SYS_CHANGES, { id: -4, name: SYS_CHANGES, rootPage: meta.changesRoot, columns: SYS_CHANGES_COLS, indexes: [], system: true });
    }
    return this.tables.get(SYS_CHANGES)!;
  }

  /** (Re)read the catalog from disk. Call after rollback of any DDL. */
  load(): void {
    this.version++;
    const meta = this.pager.getMeta();
    this.sysTables = new Heap(this.pager, meta.tablesRoot);
    this.sysColumns = new Heap(this.pager, meta.columnsRoot);
    this.sysIndexes = new Heap(this.pager, meta.indexesRoot);
    this.tables.clear();
    const sys = (id: number, name: string, root: number, cols: ColumnDef[]): TableDef => ({
      id,
      name,
      rootPage: root,
      columns: cols,
      indexes: [],
      system: true,
    });
    this.tables.set(SYS_TABLES, sys(-1, SYS_TABLES, meta.tablesRoot, SYS_TABLES_COLS));
    this.tables.set(SYS_COLUMNS, sys(-2, SYS_COLUMNS, meta.columnsRoot, SYS_COLUMNS_COLS));
    this.tables.set(SYS_INDEXES, sys(-3, SYS_INDEXES, meta.indexesRoot, SYS_INDEXES_COLS));
    if (meta.changesRoot !== 0) this.tables.set(SYS_CHANGES, sys(-4, SYS_CHANGES, meta.changesRoot, SYS_CHANGES_COLS));

    const byId = new Map<number, TableDef>();
    for (const r of this.sysTables.scan()) {
      const [id, name, root] = decodeTuple(types(SYS_TABLES_COLS), r.data) as [number, string, number];
      const t: TableDef = { id, name, rootPage: root, columns: [], indexes: [], system: false };
      byId.set(id, t);
      this.tables.set(name, t);
    }
    const cols: { tid: number; ord: number; def: ColumnDef }[] = [];
    for (const r of this.sysColumns.scan()) {
      const [tid, ord, name, type, notNull, pk] = decodeTuple(types(SYS_COLUMNS_COLS), r.data) as [number, number, string, DataType, boolean, boolean];
      cols.push({ tid, ord, def: { name, type, notNull, pk } });
    }
    cols.sort((a, b) => a.tid - b.tid || a.ord - b.ord);
    for (const c of cols) byId.get(c.tid)?.columns.push(c.def);
    for (const r of this.sysIndexes.scan()) {
      const [id, name, tableId, column, metaPage, unique] = decodeTuple(types(SYS_INDEXES_COLS), r.data) as [number, string, number, string, number, boolean];
      const t = byId.get(tableId);
      if (!t) continue;
      t.indexes.push({ id, name, tableId, column, columnIndex: t.columns.findIndex((c) => c.name === column), metaPage, unique });
    }
  }

  getTable(name: string): TableDef | undefined {
    return this.tables.get(name);
  }

  mustGetTable(name: string): TableDef {
    const t = this.tables.get(name);
    if (!t) throw new CatalogError(`relation "${name}" does not exist`);
    return t;
  }

  allTables(): TableDef[] {
    return [...this.tables.values()];
  }

  findIndex(name: string): { table: TableDef; index: IndexDef } | undefined {
    for (const t of this.tables.values()) for (const i of t.indexes) if (i.name === name) return { table: t, index: i };
    return undefined;
  }

  // ---- DDL (caller holds the transaction) ----

  createTable(name: string, columns: ColumnDef[]): TableDef {
    if (this.tables.has(name)) throw new CatalogError(`relation "${name}" already exists`);
    if (name.startsWith('__')) throw new CatalogError('names starting with "__" are reserved');
    const seen = new Set<string>();
    for (const c of columns) {
      if (seen.has(c.name)) throw new CatalogError(`column "${c.name}" specified more than once`);
      seen.add(c.name);
    }
    if (columns.filter((c) => c.pk).length > 1) throw new CatalogError('multiple primary keys are not allowed');
    this.version++;
    const id = this.pager.nextObjectId();
    const root = Heap.create(this.pager);
    this.sysTables.insert(encodeTuple(types(SYS_TABLES_COLS), [id, name, root]));
    columns.forEach((c, i) => {
      this.sysColumns.insert(encodeTuple(types(SYS_COLUMNS_COLS), [id, i, c.name, c.type, c.notNull || c.pk, c.pk]));
    });
    const t: TableDef = { id, name, rootPage: root, columns: columns.map((c) => ({ ...c, notNull: c.notNull || c.pk })), indexes: [], system: false };
    this.tables.set(name, t);
    const pk = columns.find((c) => c.pk);
    if (pk) this.createIndex(`${name}_pkey`, name, pk.name, true);
    return t;
  }

  createIndex(name: string, tableName: string, column: string, unique: boolean): IndexDef {
    if (this.findIndex(name)) throw new CatalogError(`relation "${name}" already exists`);
    if (this.tables.has(name)) throw new CatalogError(`relation "${name}" already exists`);
    const t = this.mustGetTable(tableName);
    if (t.system) throw new CatalogError('cannot index a system table');
    const ci = t.columns.findIndex((c) => c.name === column);
    if (ci < 0) throw new CatalogError(`column "${column}" does not exist`);
    this.version++;
    const id = this.pager.nextObjectId();
    const metaPage = BTree.create(this.pager);
    this.sysIndexes.insert(encodeTuple(types(SYS_INDEXES_COLS), [id, name, t.id, column, metaPage, unique]));
    const def: IndexDef = { id, name, tableId: t.id, column, columnIndex: ci, metaPage, unique };
    t.indexes.push(def);
    return def;
  }

  dropTable(name: string): TableDef {
    const t = this.mustGetTable(name);
    if (t.system) throw new CatalogError('cannot drop a system table');
    this.version++;
    for (const r of this.sysTables.scan()) {
      const [id] = decodeTuple(types(SYS_TABLES_COLS), r.data) as [number];
      if (id === t.id) this.sysTables.delete(r.tid);
    }
    for (const r of this.sysColumns.scan()) {
      const [tid] = decodeTuple(types(SYS_COLUMNS_COLS), r.data) as [number];
      if (tid === t.id) this.sysColumns.delete(r.tid);
    }
    for (const r of this.sysIndexes.scan()) {
      const [, , tableId] = decodeTuple(types(SYS_INDEXES_COLS), r.data) as [number, string, number];
      if (tableId === t.id) this.sysIndexes.delete(r.tid);
    }
    this.tables.delete(name);
    return t;
  }

  dropIndex(name: string): { table: TableDef; index: IndexDef } {
    const found = this.findIndex(name);
    if (!found) throw new CatalogError(`index "${name}" does not exist`);
    if (name.endsWith('_pkey')) throw new CatalogError('cannot drop a primary key index');
    this.version++;
    for (const r of this.sysIndexes.scan()) {
      const [id] = decodeTuple(types(SYS_INDEXES_COLS), r.data) as [number];
      if (id === found.index.id) this.sysIndexes.delete(r.tid);
    }
    found.table.indexes = found.table.indexes.filter((i) => i.id !== found.index.id);
    return found;
  }
}

export type { Value };
