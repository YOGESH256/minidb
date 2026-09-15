# Research log

Six rounds, over a week, asking one question: is there a use case for this engine? Every round was desk research — GitHub issues, download counts, forum threads. **No user was ever interviewed.** That is the method's main weakness and it should be read with that in mind.

| # | Round | Question | Verdict |
|---|---|---|---|
| 1 | [research-storage.md](../research-storage.md) | How do real engines lay out pages, WAL, B-trees? | Design input, not a use case. Used to build the engine. |
| 2 | [research-sql.md](../research-sql.md) | How do real engines parse and plan SQL? | Same. |
| 3 | [archive/USE-CASE.md](../archive/USE-CASE.md) | A test database you can crash on purpose? | **No.** An app on SQLite learns nothing from passing against a different engine; a fault-injecting VFS under real SQLite tests the real thing. |
| 4 | [archive/USE-CASE-RESEARCH-2026-09-13.md](../archive/USE-CASE-RESEARCH-2026-09-13.md), [archive/REAL-USE-CASES-2026-09-13.md](../archive/REAL-USE-CASES-2026-09-13.md) | A small records store for Node apps? | **No.** `node:sqlite` ships in Node 22.13+; PGlite is real Postgres in wasm at 12M downloads a week. |
| 5 | [../edge/RESULTS.md](../edge/RESULTS.md) (branch `explore/edge-object-store`) | SQL over S3/R2 from edge runtimes? | **No.** Ties with SQLite on cold reads; SQLite stores the same data in 57% of the bytes; our scan wins came from fetch concurrency any VFS can copy. The protocol itself is sound and engine-independent. |
| 6 | [2026-09-14-history-watch-undo.md](2026-09-14-history-watch-undo.md) | History, live queries and undo as database features? | **Mostly no.** SQLite's session extension already does undo with conflict detection; audit is a solved trigger problem. Only live queries are genuinely missing, and the AI-agent framing is falsified 15 builders to 1 asker. |
| 7 | [2026-09-14-observability.md](2026-09-14-observability.md) | Anything in observability or telemetry? | **No**, on all five angles. Also corrected a bad number quoted in round 6. |

## What the rounds got wrong

- **Round 6 quoted `drizzle-orm#843` (558 reactions) as demand for live queries.** That issue is about `CREATE TRIGGER`. The real live-query issues have 5 reactions and 0. Round 7 caught it. Any conclusion resting on that number was void.
- **Reaction counts only measure things people already know to ask for.** SQLite, Redis and Git had no issue with 500 reactions demanding them before they existed. A method built on this signal can validate copies of existing tools and little else. "Six rounds found nothing" may mean there is nothing, or may mean the method cannot see it.
- **The order was backwards.** The engine was built first and the use case hunted afterwards. No amount of research repairs that.

## What stands regardless

The engine works, it is crash-safe under `SIGKILL`, and every finding of two code reviews is fixed. The learning material — [`../../START-HERE.md`](../../START-HERE.md), the [ladder](../../ladder/), [`../explainer.html`](../explainer.html), the video — is finished. That was the original question ("can we make a database like Postgres") and the answer was yes.
