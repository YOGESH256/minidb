# minidb at the edge: SQL over any storage

Status: research + proposal. No engine code changed for this direction. Written 2026-09-13.

## 1. One paragraph

More and more application code runs as small functions in sandboxes (Cloudflare Workers, Vercel, Deno Deploy, AWS Lambda) with tight bundle limits, no native libraries, and often no local disk. Those functions still need a database. Native SQLite cannot run there, SQLite-in-WebAssembly is megabytes and awkward, and Postgres means a server and a connection per invocation. minidb is a few tens of kilobytes of plain TypeScript whose "disk" is an interface, so the same engine can keep its pages in a file, in memory, in R2/S3, in Durable Object storage, or in browser storage. That combination does not exist today. The cost of getting there is one large engine change: the storage path must become asynchronous.

## 2. What changed since the earlier proposals

Two facts shrink the older "native modules are painful" arguments, so earlier directions are dropped:

- `node:sqlite` ships in Node 22.13+ without a flag ([nodejs/node#55890](https://github.com/nodejs/node/pull/55890)); VS Code 1.137 runs Node 24.18 ([vscode-versions](https://github.com/ewanharris/vscode-versions)). CLIs and desktop VS Code extensions no longer need a native SQLite package.
- PGlite, real Postgres compiled to wasm, is at 12.4M weekly downloads ([npm](https://api.npmjs.org/downloads/point/last-week/@electric-sql/pglite), [Electric blog](https://electric.ax/blog/2026/06/25/pglite-reaches-10-million-weekly-downloads)). "Postgres-flavoured test double" is a lost race; pg-mem's 422k/week is the remainder.

Dropped: chaos-testing database, CLI/desktop store, Postgres test double, generic "records store". Kept: the learning ladder and explainer, which stand on their own.

## 3. Evidence, by audience

### 3.1 Edge and serverless runtimes (primary)

Constraints:

- Cloudflare Workers: 3 MiB script on free, 10 MiB paid, no web workers. sql.js needed a fork to run at all ([cloudflare-worker-sqlite-wasm](https://github.com/adrianlyjak/cloudflare-worker-sqlite-wasm)); PGlite needs a custom wasm-import setup ([example](https://github.com/electric-sql/pglite-cloudflare-worker-example)).
- Durable Objects SQLite is GA at 10 GB per object, D1 caps 10 GB/db, 2 MB/row, 100 columns ([DO storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). Both are Cloudflare-only and SQLite-shaped.
- Lambda: better-sqlite3 needs a prebuilt layer ([better-sqlite3#343](https://github.com/WiseLibs/better-sqlite3/issues/343), [layer repo](https://github.com/seanfisher/better-sqlite3-lambda-layer)).

Demand for "database pages fetched from object storage on demand", all built as hacks around the C engine:

- Litestream's VFS became writable in Jan 2026: reads fetch pages from S3, single writer, eventual durability ([Fly blog](https://fly.io/blog/litestream-writable-vfs/)); commentary names "per-tenant databases, agent state stores" as the use ([bex.co](https://bex.co/blog/2026/08/07/litestream-writable-vfs-sqlite-s3-self-hosted-paas)).
- turbolite: "sub-100 ms cold JOIN queries from S3" ([repo](https://github.com/russellromney/turbolite)).
- sql.js-httpvfs on static hosts ([post](https://recca0120.github.io/en/2026/03/07/sql-js-httpvfs-static-hosting/)); sqlite3vfshttp ([repo](https://github.com/psanford/sqlite3vfshttp)).

None of these run as plain JavaScript inside an isolate. minidb's page store is already an interface (`FileIO`: `read(pos, len)`, `write`, `size`, `truncate`, `fsync`), which is the property they are all reconstructing from outside.

### 3.2 Agent frameworks (secondary, same product)

- LangGraph.js checkpoint-sqlite wraps better-sqlite3, 51k/week ([npm](https://api.npmjs.org/downloads/point/last-week/@langchain/langgraph-checkpoint-sqlite)). Author of a desktop agent app: "JSON file I/O doesn't scale well with concurrent access or large datasets… running the whole agent system local on the device… would be finicky" ([langgraphjs#1970](https://github.com/langchain-ai/langgraphjs/issues/1970), Feb 2026).
- Mastra defaults to `@mastra/libsql`, 284k/week, native bindings ([npm](https://api.npmjs.org/downloads/point/last-week/@mastra/libsql)). "Agents on AWS Lambda fail without @libsql/client layer even when not using LibSQL" ([mastra#4135](https://github.com/mastra-ai/mastra/issues/4135)); bundler "processes native modules incorrectly" ([mastra#6621](https://github.com/mastra-ai/mastra/issues/6621)); "Cannot find module '@libsql/darwin-x64'" ([libsql#1474](https://github.com/tursodatabase/libsql/issues/1474)).
- OpenAI Agents JS, 1.29M/week ([npm](https://api.npmjs.org/downloads/point/last-week/@openai/agents)), ships only in-memory and hosted sessions ([docs](https://openai.github.io/openai-agents-js/guides/sessions/)); community adds SQLite via drizzle + better-sqlite3 ([StackOne](https://github.com/StackOneHQ/openai-agents-js-sessions)).
- Claude Code stores state as JSONL files ([writeup](https://milvus.io/blog/why-claude-code-feels-so-stable-a-developers-deep-dive-into-its-local-storage-design.md)).

Fit: checkpoints, threads, messages are small rows with transactions and crash-safety, exactly the engine's current shape. Gap: frameworks increasingly want vector search, which minidb does not have.

### 3.3 Browser and web extensions (ride-along)

Persisting SQLite in the browser needs dedicated workers, COOP/COEP headers for the fast OPFS path, and has Safari gaps ([PowerSync survey, May 2026](https://powersync.com/blog/sqlite-persistence-on-the-web), [sqlite.org](https://sqlite.org/wasm/doc/trunk/persistence.md)). A pure-JS engine over IndexedDB/OPFS needs none of that. wa-sqlite and PGlite are far more SQL-complete, so this is a bonus that falls out of the same store interface, not a lead.

### 3.4 Not pursued

Testing (PGlite won), desktop VS Code and CLIs (`node:sqlite`), general "records store" (same reason).

## 4. Ranking

| # | Audience | Size signal | Fit with what minidb uniquely has |
|---|---|---|---|
| 1 | Edge/isolate SQL over pluggable storage | fastest-growing runtime category; four independent "pages over S3" hacks exist | pluggable page store + tiny bundle: no competitor has both |
| 2 | Agent framework local state | 1.5M+/week across three frameworks, documented native-binding failures | schema shape already covered; same package |
| 3 | Browser / web-extension persistence | real but narrower | same store interface, no workers or headers |

## 5. Minimal product

**Packages** (npm name availability unverified): `minidb` core; `@minidb/store-memory`, `store-file`, `store-r2`, `store-s3`, `store-do` (Durable Object storage), `store-opfs`.

**API**

```ts
const db = await openDatabase({ store: r2Store(env.BUCKET, 'tenant-42.db'), cache: { pages: 2048 } });
await db.exec('CREATE TABLE ...');
const rows = await db.query('SELECT ... WHERE id = ?', [id]);
await db.transaction(async (tx) => { await tx.exec(...); });
```

Async everywhere. A synchronous fast path can remain for in-memory and local files.

**First integration:** a Cloudflare Worker serving one database per tenant from R2, single writer with a lease, read-only mode for replicas. **Second:** a LangGraph.js `MinidbSaver` over a plain file, then over R2.

## 6. Engine work, in order

1. **Async storage contract.** `read/write/size/truncate/fsync` return promises. This propagates: pager `acquire`, heap and B-tree operations, executor `next()`, `Database.exec`. Mechanical but touches every layer. Add `readMany(ranges)` so a B-tree descent can batch page fetches, plus read-ahead in the page cache.
2. **Commit as one upload.** Object stores have no in-place partial writes. `write(pos, data)` on a WAL cannot mean "patch bytes"; a commit becomes one WAL-segment object (or one multipart upload), and checkpoint rewrites the data object. The existing WAL-then-data ordering survives; the units change from byte ranges to objects. Verify the torn-record detection holds when an upload is partial.
3. **Single-writer lease.** A lock object in the store with expiry, mirroring Litestream's constraint. Readers may open without it.
4. **SQL for real applications.** Aggregates with `GROUP BY`/`HAVING`, `LIKE`, `IN`, `UPSERT`/`ON CONFLICT`, `RETURNING`, a JSON column with `->`/`->>`. Agent checkpointers need JSON blobs; cursors via `ORDER BY ... LIMIT` already work.
5. **Bundle.** ESM build, measure gzipped size against the 3 MiB Workers free tier and against sql.js / PGlite.

Rough effort: step 1 and 2 one to two weeks; step 3 days; step 4 one to two weeks; step 5 a day. No change to page layout, B-tree structure, or recovery rules.

## 7. Risks, stated plainly

- Async rewrite is the whole bet. If it stalls, nothing else in this direction ships.
- Object-store latency: a cold B-tree lookup is 2–3 sequential fetches at tens of ms each. Fine for per-tenant, read-mostly data; wrong for hot OLTP. Say so in the docs.
- Single writer only. Multi-writer needs a different design.
- Cloudflare could ship "DO SQLite over R2" and cover the primary case on their platform. The portable, platform-neutral angle (same engine on Vercel, Deno, Lambda, browser) is the hedge.
- Trust in a young engine holding tenant data. The crash-test suite and fault-injection tests are the answer; keep expanding them.

## 8. Decision needed

Go / no-go on step 1 (async storage contract). Everything else depends on it. If go, the plan for the rewrite comes before any edit.
