# Is there an opportunity in autonomous / AI-operated databases?

Research 2026-09-20, round nine. **Verdict: no for a new engine.** A narrow yes for agent-facing verification tooling, which belongs on Postgres or SQLite rather than here.

This round asked a different question from rounds 3–8. Those asked who needs the engine. This asked what happens when the *agent* is the operator, on the theory that a 4,000-line engine fits in a context window and is therefore legible to an LLM in a way Postgres is not.

## 1. The category's own history

**OtterTune** (Andy Pavlo's ML database-tuning company) shut down 14 June 2024. His words, on X: "I'm too sad to announce that @OtterTuneAI is officially dead. Our service is shutdown and we let everyone go today… we got screwed over by a PE Postgres company on an acquisition offer." His only written post-mortem is one line in [Databases in 2024](https://www.cs.cmu.edu/~pavlo/blog/2025/01/2024-databases-retrospective.html).

Correction worth recording: the widely repeated claim that OtterTune failed because the product "wasn't sticky enough" could **not** be sourced to Pavlo. It appears in SEO aggregator pages attributed to Reddit speculation. The honest read is a financing death, not a market verdict.

**But the silence is the market signal.** Both HN threads about its death drew [15 points / 5 comments](https://news.ycombinator.com/item?id=40682165) and [14 points / 5 comments](https://news.ycombinator.com/item?id=40683900).

**Vendors, the strongest anti-marketing datum.** Azure SQL's automatic tuning ships with "FORCE_LAST_GOOD_PLAN enabled, CREATE_INDEX disabled, and DROP_INDEX disabled" ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/azure-sql/database/automatic-tuning-overview)). After roughly eight years, Microsoft ships autonomous schema change **off by default**. Google's Database Observability and Onboarding Agents (Next '26) are advisory with a human in the loop. Oracle's Autonomous Database adoption claims are Oracle-published only; no independent survey found.

**Learned indexes:** eight years since Kraska et al., the only production-scale result is still Google's [2020 integration study](https://arxiv.org/abs/2012.12501), and 2025–26 output is all benchmarks. No GA shipment anywhere.

CMU's research line continues ([PACMMOD, Apr 2026](https://dl.acm.org/doi/10.1145/3786704)); the products are dead.

## 2. LLM-operated databases: real tools, poor numbers

- [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp), 3.3k stars, exposes `explain_query`, `analyze_workload_indexes`, `analyze_db_health`, hypothetical-index simulation and an implementation of Microsoft's DTA algorithm. Default production mode is **read-only**. DB-GPT is at ~19.9k stars.
- Microsoft Research on LLM index tuning ([arXiv 2603.09181](https://arxiv.org/abs/2603.09181)): LLMs sometimes "significantly outperform those found by DTA in terms of execution time" but "suffer from high variance" and are "often substantially worse than DTA in terms of optimizer-estimated cost."
- **DBA-Bench** ([arXiv 2607.22165](https://arxiv.org/abs/2607.22165), Jul 2026), production-fidelity PostgreSQL: best agents score **17.9% Safe Pass against a human DBA's 93.4%**. Diagnosis pass 32.7%, of which **62.1% still fail to repair**. 36.7% of outcome-passing runs fail safety checks.

All benchmark-only. No adoption numbers found for any LLM-DBA product.

## 3. The specific hypothesis, and why it fails

**Nobody argues that an agent operates a system better because it can read the whole implementation.** Searched directly; found no vendor, blog or paper making the claim. The 2026 consensus runs the other way, toward context compilers and retrieval, because "fitting a codebase in context does not guarantee that an LLM attends to the architecturally critical files" ([Fowler](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html)). "Agent-friendly system design" exists as a named idea, but every property listed is fast spawn, branching, rollback and isolation, never source legibility.

DBA-Bench kills the mechanism directly: it already hands agents thousands of time series, logs, query plans, lock and session activity, and concludes the bottleneck is causal reasoning and safety discipline, **not signal availability**. minidb's differentiator is more signal.

## 4. Databases for agents: real category, not an engine category

Neon reports **80% of its databases are created by agents** (Jul 2025 telemetry, cited by [Pavlo](https://www.cs.cmu.edu/~pavlo/blog/2026/01/2025-databases-retrospective.html)); Databricks acquired Neon for ~$1B. Turso markets "A Database for Every Agent"; Dolt ships branch/diff/revert for agents.

The axes being bought are provisioning speed, isolation, branching and undo — all on Postgres, SQLite and MySQL. This confirms round 4's finding rather than extending it.

## 5. Demand, separated from vendor claims

- Auto-tuning is a twenty-year wish, not a purchase. PostgreSQL's TODO for an auto-tuning tool dates to [2008](https://www.postgresql.org/message-id/20080716153019.864C9754A84%40cvs.postgresql.org).
- What people actually complain about is **reading plans**: pgMustard, explain.dalibo.com, explain.depesz.com all exist because raw `EXPLAIN` is painful. That is "give me better EXPLAIN", not "tune yourself", and it is met by tools layered on Postgres.
- **The loudest signal argues for less autonomy.** The [Supabase MCP prompt-injection leak](https://news.ycombinator.com/item?id=44502318) drew 848 points and 470 comments. Roughly 50× the attention OtterTune's death received, pointing the opposite way. Pavlo agrees: "Nobody should trust an application with unfettered database access, whether it is via MCP or the system's regular API."

## Answers

**Opportunity:** no, for a new engine. Narrow yes for agent-facing verification surfaces (trace, verify, diff as MCP tools), but that is a feature, and postgres-mcp already ships roughly 70% of it.

**Database gap or tooling gap:** tooling, unambiguously. Every demand signal found is satisfiable as a Postgres extension or MCP server. Nobody's problem is that their engine is too large to read.

**Strongest evidence for:** Neon's 80% figure plus the $1B acquisition plus Turso and Dolt repositioning. Agents are the majority database user on at least one real platform.

**Strongest evidence against:** DBA-Bench's 17.9% versus 93.4%, achieved *with* rich observability already supplied, with the paper locating failure in reasoning rather than signal.

**What would make it worthless:** postgres-mcp or a first-party equivalent exposing trace-grade introspection on a real engine; the non-transfer problem (an agent that can operate 4,000 lines of TypeScript has learned nothing about the Postgres it must actually operate); and model improvement, since legibility is a crutch whose value decays.

## The one unclaimed angle

minidb as an **evaluation substrate** rather than a database: a DBA-Bench-style harness where ground truth (every page read, fsync, WAL record, B-tree hop) is mechanically checkable, so an agent's *causal explanation* can be scored, not just its outcome. DBA-Bench's own numbers say explanation quality is the unmeasured variable.

Two caveats, stated plainly: it is a benchmark rather than a product, and "nobody is doing this" has been a red flag in every previous round rather than an opening.

**Unverified:** NoisePage archive status (lightly verified); Oracle adoption claims (vendor-published only); Turso's CTO.new scale claim (vendor blog). The researcher also caught itself producing precise-looking figures from a fetched PDF that appear nowhere in that paper's abstract, and discarded them.
