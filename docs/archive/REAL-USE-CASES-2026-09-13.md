# Concrete use cases for minidb

Research date: 2026-09-13. Proposal only; no engine changes made for this research. This note replaces the earlier recommendation in USE-CASE-RESEARCH-2026-09-13.md.

## Recommendation

Start with a small, persistent job/outbox example for a single-process Node application. Pending uploads, report generation, and API imports are concrete workflows: accepted work is recorded before acknowledgment, unfinished work is recoverable after a process restart, and completion/retry state is persisted.

Keep minidb a database package. This is its first demonstrated application, rather than a claim that an entire queue framework is a small change. Bot session storage is the smallest integration candidate; Express sessions are another established adapter surface.

These are established needs, not evidence that their maintainers want to adopt minidb. No maintainers were contacted.

## 1. Persistent background work

- [Workmatic](https://github.com/litepacks/workmatic) explicitly describes its motivation: fastq keeps jobs in memory, while the author needed jobs to survive restarts without operating Redis. It already offers a SQLite-backed solution. This supports the use case and establishes competition.
- [Rails Solid Queue](https://github.com/rails/solid_queue) is a database-backed job backend configured by default in new Rails 8 applications. This is evidence that the architecture serves ordinary applications; it is not an integration target for this TypeScript engine.
- [better-queue](https://github.com/diamondio/better-queue) provides a pluggable store. Its [SQL store](https://github.com/diamondio/better-queue-sql) exposes pending tasks and claimed batches. However, queue source also keeps retry counters and retry timers in process memory. A minidb adapter alone would not establish durable retry semantics; this needs a framework-level failure test before recommending it.

Fit: short job metadata, status transitions, and atomic insertion of both a business record and its pending work when they share the same minidb transaction. External HTTP calls cannot be part of that transaction. Recovered jobs can execute again; receivers or operations must support deduplication/idempotency where duplicate effects matter.

Bounded first scope: one process owns the database; asynchronous work runs outside short synchronous database transactions; records hold IDs and file paths, with an explicit size limit.

Three implementation additions for that scope: job-table helpers; a runner that persists retry times and recovers interrupted jobs; package exports plus a documented, tested example. This is not a production-readiness estimate. Larger payloads would require additional work.

## 2. Bot conversation state

- [grammY session documentation](https://grammy.dev/plugins/session.html) states that its default in-memory sessions disappear when the bot stops.
- [Telegraf's official storage adapters](https://github.com/telegraf/session) offer SQLite through Kysely and better-sqlite3. The actual storage contract is get/set/delete; [its implementation](https://github.com/telegraf/session/blob/master/kysely.ts) stores serialized session objects. A dedicated minidb store can implement that contract directly, without imitating Kysely's SQL.
- A concrete application, [expressjs-baileys](https://github.com/rezadaulay/expressjs-baileys), defaults to JSON storage specifically to avoid native build tools. Its documentation says webhook events rewrite that JSON file and recommends SQLite for busier deployments. This is a real example of the installation/storage tradeoff. It is not evidence that its author wants another backend.

Example workflow: a shopping or booking bot preserves the user's cart and current conversation step across a restart. This is persistent application state, not conversation-history search.

The Telegraf integration is small for bounded records. General session support needs larger values, and concurrent updates must retain the framework's session coordination. The Baileys application's auth, message, outbox, and idempotency contracts are broader than a three-method session store; do not present it as a finished drop-in integration.

## 3. Express login sessions

[express-session](https://github.com/expressjs/session) documents a session-store contract and existing SQLite and file stores. A minidb store would implement get/set/destroy, the recommended touch operation, and expiration. A single-process admin application could preserve login sessions across restarts without adding an external database service.

This is straightforward distribution through an existing ecosystem. It offers little differentiation by itself, and it does not support multiple application processes opening the same minidb file.

## Current-code experiment

Scratch script: `/private/tmp/minidb-usecase-probe-20260913/probe.mjs`.
Results: `/private/tmp/minidb-usecase-probe-20260913/results.json`.

Executed against the current working tree with Node and tsx:

1. Committed a business record and a queued job together.
2. A child process claimed that job and committed the claim, then opened another transaction with an additional job and a record update.
3. Sent SIGKILL to that child at the selected application boundary.
4. Reopened the file: committed claim survived; the uncommitted job and record update were absent.
5. Requeued the interrupted job, claimed it again, deleted it on completion, and reopened to verify its absence.
6. Inserted and deleted 2,000 jobs in 20 batches, with at most 100 live rows. Checkpointed file size was 73,728 bytes after batches 1, 5, 10, and 20. This small workload demonstrated reuse; it does not prove bounded growth for other key distributions or larger workloads.
7. Stored, updated, reopened, and deleted a small JSON bot session. An 8 KB text field failed with `row too large (8222 > 4060)`.

These are engine and storage-contract probes, not complete framework integrations. The selected SIGKILL boundary is not a power-loss test. Batched timings are not a throughput benchmark.

## Decision limits

The current tree already has prepared statements, parameter binding, transaction callbacks, memory storage, and a Node file lock. The original proposal's missing-feature list is stale. No aggregates, LIKE, or GROUP BY are required for the bounded workflows above.

The 4,060-byte tuple limit is a substantive blocker for unrestricted JSON payloads. Another observed API concern is that transaction callbacks are not checked for Promise returns; integrations must use synchronous callbacks, and the public API should reject asynchronous callbacks before promising transactional safety.

[node:sqlite](https://nodejs.org/api/sqlite.html) and [node-sqlite3-wasm](https://github.com/tndrle/node-sqlite3-wasm) are credible alternatives. Pure TypeScript is a packaging preference, not proof of a large unserved market. The useful next validation is an actual adopter exercising one of these integrations, rather than expanding SQL syntax speculatively.
