# Is there an observability use case for minidb?

Research 2026-09-14, the sixth and final round. **Answer: no.** One weak candidate survived, and it does not need a database.

Three premises from earlier rounds were falsified along the way, which matters more than the answer.

## Falsified premises

**`drizzle-orm#843` is not about live queries.** Its title is "[FEATURE]: `CREATE TRIGGER` functions", opened 2023-07-02, 558 reactions. Confirmed twice via the GitHub API. The actual live-query issues there are [#4893](https://github.com/drizzle-team/drizzle-orm/issues/4893) (**5 reactions, 0 comments**) and #2443 (closed, 0 reactions). This number was quoted in the previous round as the strongest demand signal for live queries. It was wrong, and so was the conclusion built on it.

**"No persistent queue for JS" is a capability gap, not demand.** Issue search across `open-telemetry/opentelemetry-js` for "persistent queue" returns **zero results**. The one direct ask, [#2833](https://github.com/open-telemetry/opentelemetry-js/issues/2833), was closed as not planned. The spec issue it waited on, [opentelemetry-specification#3645](https://github.com/open-telemetry/opentelemetry-specification/issues/3645), was **closed by a stale bot on 2026-08-23**, after a TC member wrote: "persistence mechanisms will be complicated to implement in the SDK, and it's not clear that there is enough user demand to justify the investment."

**Native dependencies are no longer a moat in Node.** `node:sqlite` has been built in since v22.5.0, unflagged since v22.13.0, and is "Stability: 1.2 – Release candidate" as of v25.7.0. Deno has implemented it since v2.2.

## Angle 1: durable telemetry buffering — weak

The loss is real and recurring. [otel-js#523](https://github.com/open-telemetry/opentelemetry-js/issues/523) (2019): "for short-lived processes the lost data may be actually everything". [#6220](https://github.com/open-telemetry/opentelemetry-js/issues/6220) closed by a stale bot, maintainer: "I don't agree with the idea that we need to make it configurable". [#7001](https://github.com/open-telemetry/opentelemetry-js/issues/7001) Chromium keepalive loss, 1 reaction, **0 comments**. [faro-web-sdk#1898](https://github.com/grafana/faro-web-sdk/issues/1898), 0 reactions, no maintainer reply. [opentelemetry-lambda#2537](https://github.com/open-telemetry/opentelemetry-lambda/issues/2537), "logs silently dropped without manual forceFlush()", 1 reaction.

Reaction counts run 0 to 2 throughout. The ecosystem's answer is architectural: run a Collector sidecar or a Lambda extension layer, and that has absorbed the demand.

**What kills it for a database specifically:** the two languages that did ship disk buffering did not use one. OTel Java's disk-buffering is plain files (1 MB max per file, 10 MB per folder, rename on close). Sentry's `OfflineStore` interface is **three methods: `push`, `unshift`, `shift`** — a FIFO. Nobody imports a SQL engine to get `shift()`.

The one genuine hole: **no Node filesystem offline store ships in Sentry** (`packages/node/src/transports/` holds only `http-module.ts`, `http.ts`, `index.ts`). Roughly 200 lines of `fs`.

## Angle 2: what collectors actually use for on-disk queues — none

Five of seven use append-only segment logs, not databases: Vector `disk_v2` (mmap'd ledger, CRC32C-framed records; they [deleted LevelDB](https://github.com/vectordotdev/vector/blob/master/rfcs/2021-10-14-9477-buffer-improvements.md) partly to drop a C++ dependency), Fluent Bit chunkio, Fluentd `buf_file`, Alloy/Prometheus WAL, Beats disk queue, Telegraf WAL.

Only the OTel Collector's `file_storage` uses a real embedded database (bbolt), and the community is trying to leave it: [collector-contrib#50395](https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/50395) (Aug 2026) reports bbolt mmapping the whole file, so "a 50GB queue means 50GB of virtual memory pressure, leading to OOM kills", plus 30–60s freelist rebuilds on open. **The one place an embedded database was used, they are replacing it with a queue-shaped store.** No widely used collector is written in JavaScript.

## Angle 3: local trace and log analysis — none

Perfetto's `trace_processor` embeds the **stock SQLite amalgamation** (3.50.3) with custom VFS bindings, compiled to WASM. `otel-desktop-viewer` (1.3k★, Go) replaced its in-memory store with **DuckDB** in 2024, and its current work is issue #403, "Compute quantiles set-based, once per query".

That issue is the disqualifier. **No GROUP BY and no floats means no p50, p95, p99, no duration histograms, no error rates, no top-N slowest.** That is trace analysis. Add a 4 KB row limit against spans carrying stack traces, and a row store against a scan-and-aggregate workload. Size does not rescue it either: sql.js is ~705 KB (against duckdb-wasm's ~35.7 MB) and gives the full SQLite optimiser, aggregates, window functions and floats.

## Angle 4: live queries for monitoring — none

ClickHouse deprecated `LIVE VIEW` in 2023 and **removed** it in [PR #88706](https://github.com/ClickHouse/ClickHouse/pull/88706) (Oct 2025), commit message "Remove the obsolete LIVE VIEW feature". `WATCH` removed in 26.9.1. The industry tried push-on-result-change and retired it.

Of Materialize, Feldera, RisingWave, Epsio and Readyset, **only RisingWave** markets monitoring and alerting. Grafana alerting is interval-evaluated; Prometheus `evaluation_interval` defaults to 1 minute. Polling by design. The highest-reaction live-query issue found anywhere, [pg_graphql#17](https://github.com/supabase/pg_graphql/issues/17) with 117 reactions, is entirely about client subscriptions and offline support, with **zero alerting asks in 23 comments**. The demand is UI reactivity, decisively.

## Angle 5: database self-observability and education — none

PG18 includes BUFFERS in `EXPLAIN ANALYZE` by default, but reports block *counts*, never block *identity*. SQLite is weaker: `sqlite3_stmt_status` has no I/O counter at all. So the granularity gap is real. But an HN search for query-IO observability returned **zero stories**, and every popular artifact in the area is about *rendering* counters that already exist. The askers are engine developers.

Education is worse. CMU 15-445 is C++/BusTub; **MIT 6.5830 moved to Go**; Berkeley CS186 is Java; build-your-own.org's database book is Go, with no JavaScript edition. The closest pure-TypeScript teaching engine, `sksql`, has **42 stars**, has been dead since Dec 2023, and its three Show HN posts scored **6, 3 and 2 points with zero comments**. And CodeCrafters, the only company that monetised this, with 400k+ users and 547k stars on build-your-own-x, [paused new challenges on 2026-05-22](https://codecrafters.io/blog/pausing-new-challenges): "we were unsuccessful at turning CodeCrafters into a business."

## Ranked survivors

| # | Use case | Evidence |
|---|---|---|
| 1 | Durable telemetry queue where wasm and native are barred | **weak** |
| 2 | Local trace and log analysis | none |
| 3 | Live queries for monitoring and alerting | none |
| 4 | Per-query page and IO tracing | none, outside engine developers |
| 5 | Education | none |

**The strongest is not a database use case.** The user would be someone shipping telemetry from Cloudflare Workers (where `node:sqlite` is a non-functional stub while `node:fs` is supported), React Native, or an Electron app where better-sqlite3 breaks ASAR packaging. What they need is `push`/`shift` with fsync and crash replay: 200 to 500 lines of framed append-only file I/O. Which is exactly the conclusion Vector reached, and exactly why the OTel Collector is leaving bbolt.

The honest observability contribution is narrow and unglamorous: publish `@sentry/node`'s missing filesystem `OfflineStore`, or a `SpanProcessor` that wraps OTel's exporter with disk persistence. Real gap, near-zero demand signal, needs none of minidb.

**Could not verify:** Telegraf's first disk-buffer release version; Sentry Electron/Node on-disk envelope caching (docs 404'd); quantified browser telemetry loss rates; Waterloo and Stanford course languages; Educative/Coursera enrolment. The web-search quota was exhausted at the start, so all findings rest on direct fetches of canonical URLs plus the GitHub API. Negative results are suggestive, not conclusive.
