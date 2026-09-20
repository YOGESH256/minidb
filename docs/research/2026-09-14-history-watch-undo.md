# Does a database need native history, live queries and undo?

Research 2026-09-14. Run adversarially against our own hypothesis, after the `explore/history-watch` prototype was already built.

**Hypothesis tested:** applications repeatedly hand-build (a) UI refresh plumbing, (b) an audit log, (c) an undo stack with conflict detection, and SQLite provides none of them.

**Result: two of three are false.** SQLite already provides undo with conflict detection, and audit is a solved trigger problem. Only live queries are genuinely missing.

## 1. SQLite's session extension already does undo with conflict detection

`sqlite3changeset_invert()` produces the exact inverse of a changeset. `sqlite3changeset_apply()` routes every mismatch through a conflict callback that raises `SQLITE_CHANGESET_DATA` when "original row values don't match current database state", plus `NOTFOUND` / `CONFLICT` / `CONSTRAINT`, and the handler returns `OMIT` / `REPLACE` / `ABORT`. Detection is row and column granular. SQLite's own docs pitch it: "A changeset may also be inverted and used to 'undo' a session."

- https://www.sqlite.org/sessionintro.html
- https://www.sqlite.org/session/sqlite3changeset_apply.html

Real limits, all verified:

- **PRIMARY KEY required**; tables without one are silently skipped. WITHOUT ROWID only from 3.17.0. No virtual tables.
- **Must attach the session before the changes happen.** No retrospective capture. `sqlite3session_diff()` is the escape hatch and diffs whole tables.
- **Buffered in heap memory** (`sqlite3session_memory_used()` exists for exactly this reason). Not a durable log.
- **Patchsets drop the before-image**, which is what makes conflict detection possible. Only changesets raise `DATA`.
- A missing table in the target produces **no error**, just a logged `SQLITE_SCHEMA` warning.
- Not in default builds: needs `-DSQLITE_ENABLE_SESSION` and `-DSQLITE_ENABLE_PREUPDATE_HOOK` (https://sqlite.org/compile.html).
- Quality is rough. APSW's author raised conflict handlers receiving empty data, a mutex-order bug, `OMIT` deleting rows, and streaming ignoring `STRMSIZE`, in 2025. One reply, from Dan Kennedy, in January 2026. https://sqlite.org/forum/info/9b1f72ccb45bef6249b2e40c6162b83099cc84054a9347f17ccc8d7c86f4abd6

### The real gap is in the JavaScript bindings

| Binding | session | **invert** | preupdate hook | update hook |
|---|---|---|---|---|
| node:sqlite | yes (`createSession` / `applyChangeset` with `onConflict`) | **not exposed** | no | no |
| bun:sqlite | yes (node:sqlite compat) | no | no | no, [#4175](https://github.com/oven-sh/bun/issues/4175) open since Aug 2023 |
| better-sqlite3 | none | no | no | no, [#62](https://github.com/WiseLibs/better-sqlite3/issues/62) closed 2017 |
| wa-sqlite | none upstream; LiveStore [forked it](https://github.com/livestorejs/wa-sqlite) to add `session_*` | no | no | no |
| sql.js | none | no | no | no |
| APSW (Python) | full | yes | yes | yes |

`sqlite3_update_hook` gives operation, table and **rowid only, no values**, and skips WITHOUT ROWID tables, `ON CONFLICT REPLACE` deletes, and the truncate optimisation. https://www.sqlite.org/c3ref/update_hook.html

SQLite also publishes an official undo/redo recipe built on triggers and an UNDOLOG table, explicitly "a demonstration of the technique, not a drop-in module": https://www.sqlite.org/undoredo.html

## 2. Sixteen local-first frameworks: one has conflict-detecting undo

| Project | Live queries | Queryable history | Undo | Conflict-detecting undo |
|---|---|---|---|---|
| Electric | yes | no | no | no |
| PowerSync | yes | no | no | no |
| cr-sqlite (3.8k★) | — | no, "history-free / only current state" | no | no, LWW |
| Zero / Replicache (3.4k★) | yes | no | no | no |
| Triplit | yes | no (0 of 79 doc pages) | no | no, LWW register with Lamport clocks |
| Jazz v2 | yes | last-writer only; `getEdits` has zero hits repo-wide | no | no, [documented LWW clobber](https://jazz.tools/docs/concepts/branches) |
| Jazz classic | yes | yes, `by: Account` + `madeAt: Date` | no | no |
| Evolu | yes | yes, `evolu_history` with owner + HLC + value | no | no, per-column LWW |
| LiveStore | yes | partial: answers who, **no timestamp column at all** | [doc is a stub](https://docs.livestore.dev/patterns/undo-redo/) | no |
| TinyBase (5.2k★) | yes | checkpoints only | yes | no, purely local in memory |
| Dexie | yes | no | no | no |
| RxDB | yes | no | no | no |
| WatermelonDB | yes | no | no | no |
| InstantDB | yes | no | no | no |
| Automerge | yes | yes, random actor id | "cut for 1.0"; [#985](https://github.com/automerge/automerge/issues/985) closed 10 Sep 2026, undocumented | no |
| **Yjs UndoManager** | yes | yes | yes | **yes, the only one** |

Outside local-first, [DoltLite](https://www.dolthub.com/blog/2026-08-31-doltlite-beta/) (SQLite fork, beta Aug 2026) plus Dolt give history, blame, revert **and cell-level conflict detection**. Cost: 3.1× slower autocommit writes and no live queries at all.

## 3. Demand, split by feature

**Live queries: recurring and growing.** [LISTEN/NOTIFY doesn't scale, 574 points](https://news.ycombinator.com/item?id=44490510) → [actually scales, 373 points](https://news.ycombinator.com/item?id=49040296) → [NOTIFY for SQLite, 327 points](https://news.ycombinator.com/item?id=47874647). Decade-old StackOverflow questions still being edited in 2026.

**History and audit: high views, dead asks.** The StackOverflow `audit-trail` tag has **312 questions ever**, peaked at 30/year in 2018, and hit **zero in 2026**. paper_trail has [146.9M downloads](https://rubygems.org/gems/paper_trail). Triggers solved it.

**Undo: weakest.** The high-view questions are panic recovery ("how to undo an UPDATE", answered "restore from backup"), which is ops pain, not a product ask.

## 4. The AI-agent angle is falsified: 15 builders, 1 asker

- ~40 artifacts complaining after agent data loss, including [HN 860 points / 1,032 comments](https://news.ycombinator.com/item?id=47911524) and [r/ClaudeAI 1,759 upvotes](https://www.reddit.com/r/ClaudeAI/comments/1vu2umz/claude_subagent_got_bored_and_prompt_injected_my/).
- ~14 asking for a *preventive* gate, best being [supabase/mcp#236 at +7](https://github.com/supabase/mcp/issues/236).
- **1** asking to undo agent row changes: [r/cursor, 16 Jun 2025, 0 upvotes, 2 comments](https://www.reddit.com/r/cursor/comments/1lcwm1m/whats_your_process_for_undoing_supabase_mcp/).
- **~15 shipped products**, none above 23 HN points, median Show HN score **2**. UndoMCP, "Ctrl-Z for AI agent MCP actions": 0 upvotes, 0 comments. pg-dry-run: 1 upvote, in a subreddit that gave a data-loss story 4,322.
- Keyword split on that 1,032-comment thread: backups **107**, approval gates 59, credential scoping 50, staging separation 38, undo/revert-data **20**. Roughly **50:1 against undo**.
- GitHub search `undo agent database changes in:title` → **0 results**. Same for `rollback data agent MCP in:title`.
- Where it shipped, the complaint is that it's broken: [Replit #7531](https://replit.discourse.group/t/lost-of-database-records-horror-story-in-progress/7531), "i have 7 days revert history… BUT NO revert does not work". Max likes on any such thread: 6. Security, by contrast, front-pages: [Supabase MCP leak, 848 points](https://news.ycombinator.com/item?id=44502318).

## 5. Postgres: three disjoint columns, nothing spanning them

pgaudit logs **statements to the server log**, never row before/after, and is "best-effort and not transactional". temporal_tables (1.1k★) and pg_ivm (1.5k★) are C extensions, so unavailable on RDS, Supabase and Neon. supa_audit is archived; audit-trigger untouched since 2023. pgMemento (411★) is the only open-source one with a real `revert_transaction`, and has no live queries and no conflict detection. Supabase Postgres Changes has no history and degrades above ~3k subscribers. Materialize is live queries only, from ~$800/month.

Money: Bemi charges $19–$99+/month, pgstack $95/month per database, but total funding in the space is about $1.2M pre-seed, and Bemi's own newest repo is an AI inbox app. The real money is a layer up: WorkOS Audit Logs at $99/month per million events.

## Verdict

**True:** apps do hand-build live-query plumbing; no product anywhere combines history + live queries + conflict-detecting undo; and in JavaScript specifically SQLite's undo primitive is unreachable.

**False:** "SQLite does not provide them" is wrong on two of three. Undo with conflict detection is in the engine and well specified. Audit is a solved trigger problem with an official recipe, a dead question tag and a 147M-download gem. The AI-agent framing is falsified outright by 15 builders to 1 asker.

**Remaining gap, honestly narrow:** nothing binds a *turn* or an agent tool call to the row set it changed and reverts exactly that set while refusing rows a human has since touched. Triggers give rows without the boundary; point-in-time restore gives the boundary without selectivity; changesets give both and die in heap memory, unexposed in JS.

**Could not verify:** Automerge #985's implementation; Jazz v1 merge semantics; Zero and PowerSync conflict semantics (docs returned navigation only); no X/Twitter sweep, which undercounts complaints and therefore widens the gap against undo demand.
