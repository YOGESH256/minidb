/** Node entry point: installs real-disk file I/O, then re-exports the engine. */
import { setDefaultFileSystem } from './storage/file-io.js';
import { nodeFileSystem } from './storage/node-file-io.js';
setDefaultFileSystem(nodeFileSystem);

export { Database, Statement, ConstraintError, type QueryResult, type DatabaseOptions, type Params, type RowObject, type TraceSummary, type VerifyReport, type PageInfo } from './database.js';
export { DatabaseLockedError, nodeFileSystem } from './storage/node-file-io.js';
export { memoryFileSystem, type FileSystem, type FileIO } from './storage/file-io.js';
export { Pager, CorruptionError, type TraceEvent } from './storage/pager.js';
export { Heap } from './storage/heap.js';
export { BTree } from './storage/btree.js';
export { Page, PAGE_SIZE } from './storage/page.js';
export { parse } from './sql/parser.js';
export type { Value, DataType } from './types.js';
export { formatValue } from './types.js';
