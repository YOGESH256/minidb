# minidb use-case research

Research date: 2026-09-13. This is a proposal, not an implemented integration. The engine source was not changed. Local experiments ran against the existing source under Node 20.18.0 on macOS arm64.

## Revised direction: local application records

The user rejected the Node-RED proposal below as too narrow. Treat it as an example of a constrained deployment, not the recommended product identity.

The broader direction is a small transactional SQL database for Node applications graduating from JSON files. The common task is storing and querying application records: projects, tasks, settings, bookmarks, catalog entries, and counters. Applications want indexed lookups, individual record updates, and atomic changes to related records, with an ordinary npm installation. This is a proposed audience, not measured demand for minidb.

Evidence extends beyond constrained hardware:

- [lowdb's current limitations](https://github.com/typicode/lowdb#limits) explicitly describe serializing and rewriting the entire database on each write and possible performance issues with 10–100 MB objects.
- [AIRI's Satori bot persistence report](https://github.com/moeru-ai/airi/blob/main/integrations/satori-bot/docs/PERSISTENCE.md), dated March 6, 2026, documents migrating from lowdb to PGlite/Drizzle. It specifically identifies targeted SQL updates, indexed message history, and persisted event state as improvements. This demonstrates a migration reason; minidb cannot replace that complete stack with four small changes, particularly its arbitrary message bodies, queue churn, and ORM integration.
- [Foundry VTT's migration issue](https://github.com/foundryvtt/foundryvtt/issues/5065) documents replacing NeDB with LevelDB, including maintenance concerns and more selective writes to embedded documents. It also describes implementing a query layer over the KV engine. This is another application category with the same underlying persistence needs, not an identified minidb customer.

For an initial release restricted to small structured records, four bounded changes would be positional parameter binding; convenient `run/get/all` methods returning useful results; a synchronous transaction callback; and exclusive file ownership. Package exports and a working application example are release work. Full SQLite compatibility, a document facade, public chaos tooling, and framework adapters are unnecessary to test this direction.

These API changes do not remove the 4,060-byte tuple limit or the heap space-reuse limitation documented below. Larger text values and sustained update/delete churn need storage work before positioning this as a general JSON/document-store replacement. Do not hide those tasks inside a one-day estimate or claim the four API changes establish broad production readiness.

Competition is substantial: [node:sqlite](https://nodejs.org/api/sqlite.html) is built into newer Node versions; [node-sqlite3-wasm](https://github.com/tndrle/node-sqlite3-wasm) offers actual SQLite with direct filesystem access and no per-platform compilation; and [Pocket DB](https://github.com/AxFab/pocket-db) already markets a pure-TS document store for desktop and CLI apps, with an optional fsync mode. The evidence supports a useful product category, not an uncontested market or a demonstrated reason for everyone to switch from SQLite. The original proposal's lack-of-moat argument is insufficient reason to discard this category when the goal is a useful small library.

## Earlier proposal: Node-RED integration

Ship a small SQL node for Node-RED deployments on offline or restricted edge devices. Begin with lookup tables, machine counters, checkpoints, and small configuration records. The user installs a package, chooses a writable database path, supplies SQL and parameters, and receives rows in the flow.

The reason to choose it is practical installation: a JavaScript-only package that can be bundled for offline installation and uses the existing durable engine. It does not require the device operator to install a compiler, deploy a database service, or replace the host's Node runtime. Those properties are a useful alternative, not a claim that other solutions cannot work.

## Direct evidence

1. **A specific user asks for precisely the SQL subset minidb already implements.** In March 2024 a Bosch ctrlX CORE user asked for a local Node-RED database on an offline machine where they could not install another program. Their SQLite installation log shows Node 18.15.0 and `Error: not found: make`. They clarified that they only needed basic insert, delete, select, and where operations. The forum topic closed automatically, without a confirmed database installation in the visible discussion. This is historical evidence, not proof the same person is still blocked today. [User report](https://discourse.nodered.org/t/create-a-database-in-nodered-bosch-ctrlx-core/86183)

2. **The device vendor documents the installation restriction.** Bosch's August 2024 offline npm packaging guide explicitly says its method does not work for nodes requiring native compilation, naming `node-red-node-sqlite`. The documented environment uses Node 20.12.0. The guide now links an open-source packager. This supports targeting an offline package; it does not establish minidb compatibility with actual ctrlX hardware. [Bosch guide](https://community.boschrexroth.com/ctrlx-automation-how-tos-qmglrz33/post/bundle-npm-packages-for-offline-node-red-installation-key9lk3EWaf0ZrS)

3. **This is an existing, modest distribution category.** At research time the official flow-library listing for `node-red-node-sqlite` showed 2,625 downloads in the preceding week. Its current v2 documentation warns about missing platform prebuilds, gives `GLIBC_2.38` as an example, and describes rebuilding the native library. Its installation notes warn that native compilation can take 15–20 minutes on a Raspberry Pi. These downloads indicate use of the category, not demand for minidb or a count of unique users. [Current SQLite node listing](https://flows.nodered.org/node/node-red-node-sqlite)

4. **Durability matters to some of these users.** A February 2025 Node-RED user describes an industrial Raspberry Pi that buffers and forwards data; they report corrupted context preventing automatic startup and long delays getting access to repair it. This is the user's reported failure, not a reproduced diagnosis. [Discussion](https://discourse.nodered.org/t/durable-and-reliable-contextstorage-db-mysql-mariadb-based/95085)

5. **The standard persistence behavior has a documented loss window.** Node-RED's filesystem context defaults to cached updates flushed every 30 seconds, and its docs explicitly say unflushed state is lost when the runtime is unexpectedly killed. The source inspected writes a temporary JSON file then renames it; that function has no explicit fsync. Lowering the flush interval addresses batching delay, but should not be described as establishing durable acknowledgement. [Documentation](https://nodered.org/docs/api/context/store/localfilesystem), [source](https://github.com/node-red/node-red/blob/master/packages/node_modules/%40node-red/runtime/lib/nodes/context/localfilesystem.js)

## What to build

Three implementation changes, plus a packaging/example deliverable:

1. **Positional parameter binding.** Allow SQL and values to be supplied separately. A full better-sqlite3-compatible prepared-statement API is unnecessary for this first integration.
2. **Exclusive ownership of the database files.** Reject a second owner, including duplicate configurations in one process. Define conservative stale-lock recovery. This prevents concurrent file access; it is not multi-process database support.
3. **A Node-RED package containing a database configuration node and query node.** Share one database connection per configuration. Accept SQL plus bound values, return row objects and errors, and handle deploy/close correctly. Put the synchronous database in a worker so fsync does not stall unrelated flows. Specify JSON-safe conversion for 64-bit integers. If an atomic batch is exposed, execute the entire batch in one worker request using the existing transaction support.
4. **An offline-installable tarball and one working flow.** Demonstrate storing a machine counter and checkpoint, restarting, and reading both back. Exercise the packaged artifact through Node-RED before publishing; the research harness below does not verify that integration.

The integration is a modest adapter, not just a rename of the package. Worker lifecycle, failed requests, and closing the connection deserve explicit checks. There is no reliable one-day estimate yet.

## Local workload experiment

The scratch harness imported `src/database.ts` and `test/helpers.ts` without modifying them. It created 200 small keys and executed 300 transactions, each updating two keys with an fsync-backed commit. It then closed and reopened the real database and checked the saved value.

| Metric | Run 1 | Run 2 |
| --- | ---: | ---: |
| Total for 300 commits | 2,860 ms | 6,043 ms |
| Commits/second | 105 | 50 |
| Median transaction time | 6.38 ms | 8.37 ms |
| p95 transaction time | 29.17 ms | 108.35 ms |
| Database size after close | 40,960 bytes | 40,960 bytes |
| Reopen verification | Passed | Passed |

These are small laptop experiments, not target-device benchmarks. The variation and tail latency argue for a worker and an initial low-rate workload. They do not establish suitability for a high-frequency control loop or flash endurance.

The final fault experiment put the two changed keys on different heap pages. It tried 20 seeds, drop/torn modes, and a simulated stop after each write/fsync boundary plus after completion: 200 scenarios. After a stop, the abandoned instance was forbidden from doing cleanup I/O. Recovery produced either both old values or both new values; updates survived a successful WAL fsync. There were 120 old-state and 80 new-state outcomes. This is a test under the existing FaultFS model, not hardware power-cut certification or an independently validated filesystem model.

The size probe accepted 2,048-byte and 4,000-byte text values in its particular three-column schema; a 4,096-byte text value produced a 4,122-byte tuple and was rejected against the 4,060-byte tuple limit. The maximum usable value depends on all fields in the row. Do not advertise arbitrary JSON/document support.

Scratch harness: `/private/tmp/minidb-research.l0HqdH/probe.mjs`. Final machine-readable result: `/private/tmp/minidb-research.l0HqdH/results.json`. These temporary files are not a permanent benchmark suite.

## Boundaries that keep the proposal small

- Small rows, INT/TEXT/BOOL, low-rate state changes, and one owner are the first workload. Do not imply floating-point telemetry analytics, full-text search, arbitrary message bodies, or SQLite file compatibility.
- A transparent Node-RED context-store replacement is a later, different integration. It requires nested-property semantics, serialization decisions, and larger values. A queue stored as one context array can exceed the row limit quickly.
- A long-lived delete-heavy queue is not the first workload. `Heap.insert` appends to the last heap page, and deleting old rows does not make earlier heap pages available to future inserts. B+tree deletion also does not merge pages. Repeated enqueue/dequeue could grow the file despite a bounded live queue; space reuse needs work before recommending that use case.
- The device must offer a writable, persistent filesystem. Recovery relies on the device honoring sync; it cannot fix a failed SD card or a corrupted host filesystem.
- The experiment establishes execution under Node 20.18.0. Node 18 and actual Node-RED/device versions remain compatibility checks, not verified support claims.

## Alternatives checked

| Candidate | Evidence | Why it is not the first integration |
| --- | --- | --- |
| Crawlee storage | Open [SQL storage request #3406](https://github.com/apify/crawlee/issues/3406), February 2026 | Covers datasets, KV, request queues, and especially concurrent/multi-process access. Larger than four small changes. |
| Baileys authentication store | [Documentation](https://github.com/WhiskeySockets/Baileys/blob/master/README.md) recommends careful DB-backed key-state handling; [issue #2256](https://github.com/WhiskeySockets/Baileys/issues/2256) asks about the provided filesystem adapter | Real adapter opportunity, but serialized key/session sizes and async transaction semantics must be checked before claiming a fit. |
| Quick.db/bot storage | [Quick.db usage](https://quickdb.js.org/en/introduction/) and [native installation report](https://github.com/WiseLibs/better-sqlite3/issues/1163); [lowdb bot size issue #484](https://github.com/typicode/lowdb/issues/484) | Existing consumers, but broad JSON/KV compatibility adds value-size and data-migration work. |
| General CLI state | Same technical capabilities | Plausible, but no comparably specific distribution path or constrained-host case found in this pass. |

Competition exists. [SQLite context plugins](https://github.com/sebenik/node-red-context) were already published in 2025; a later forum reply claiming none existed was incomplete. [node-sqlite3-wasm](https://github.com/tndrle/node-sqlite3-wasm) supports actual SQLite with direct Node filesystem access and avoids native rebuilding. There is also a [PGlite/Node-RED prototype](https://conoroneill.net/2024/08/18/running-postgres-inside-node-red-via-wasm-and-pglite/). A wrapper around those is a credible alternative. The recommendation is to offer a small, self-contained minidb integration to an existing category, not to claim an empty market.

## First acceptance gate

Build and run one packaged Node-RED flow on a supported Node 20 host with no compiler or install scripts. Verify parameter handling, JSON-safe results, one connection per configuration, refusal of duplicate ownership, deploy/close behavior, and recovery after interruption. Measure per-write latency on an actual intended device before making throughput or power-loss claims. This is an implementation proposal justified by concrete requests and an initial engine workload check; adoption remains unproven.
