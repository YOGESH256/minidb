# Use case: local catalog cleanup with reversible batch edits

Research date: 2026-09-15. Inspected commit `6d306d0` on `explore/history-watch`, the existing research log and underlying notes, the engine, and the taskboard example. Checked current primary sources before choosing this recommendation. No potential users were contacted. This is a proposal for validation; it does not change the accepted product direction.

**Follow-up: stop before prototyping.** The [five-export size gate](2026-09-15-catalog-size-gate.md) found that 69.35% of MUSE book records and 52.34% of OAPEN records cannot complete import and a minimal title edit with history enabled. The narrow field projection also has failures and omits most metadata. User acceptance of that restriction is unproven. The initial proposal below is retained as research history; its recommendation to proceed to a prototype is superseded.

**Initial proposal: evaluate a small local application for reviewing and correcting catalog CSVs, with persistent change history and selective batch undo.** The initial audience is a librarian or information specialist maintaining compact bibliographic metadata. The engine already handles the central state-management workflow. Whether this application earns adoption, and whether minidb is its best long-term backend, remain unproven.

An example: import 1,000 records, apply a subject correction to 100 of them, fix an unrelated record's title, and close the application. On reopening, inspect and reverse the subject batch while preserving the independent title correction. If a row in the batch now differs from the batch's recorded result, refuse the entire undo and identify the conflicting record.

## Evidence for the workflow

| Primary source, checked September 15 | What it establishes | Limit of the evidence |
| --- | --- | --- |
| [Library Carpentry's OpenRefine course](https://librarycarpentry.github.io/lc-open-refine/) and [undo/redo lesson](https://librarycarpentry.github.io/lc-open-refine/09-undo-and-redo.html) | A defined audience already learns importing, transforming, undoing and exporting bibliographic data. | Training content does not establish dissatisfaction or willingness to switch. |
| [OpenRefine's current manual](https://openrefine.org/docs/manual/running/) | Project history survives restart. Its documented timeline undo reverses subsequent operations together; making a new edit after going back discards the later redo history. | OpenRefine also supports exporting and reapplying operations, which provides a workaround for some workflows. |
| [OpenRefine issue #183](https://github.com/OpenRefine/OpenRefine/issues/183) | An explicit request to undo one operation from the middle of history; the issue is currently open. Originally requested in 2010 and imported into GitHub in 2012. | GitHub's API confirms 0 reactions, 2 comments and last update November 25, 2025. This is very weak demand evidence; it establishes an old request, not frequency, adoption or market size. |
| [OpenRefine's final reproducibility report, submitted February 28, 2026](https://openrefine.org/assets/files/2026-EOSS-5-Final-Report-36e49cb1a99fb0f4cbb59e80cbea00b1.pdf), pages 4–5 | The project conducted walkthroughs and community research. Feedback led it to prioritize workflow reliability and error prevention; broader workflow editing required more architectural work than expected. | The report also documents shipped improvements. It does not say users need a replacement or endorse minidb's particular undo semantics. |

My inference: the sources identify a workflow and a testable question. The selective-undo demand evidence is thin. They do not establish an unserved database market or justify building a prototype before cheaper feasibility checks.

## Competition and the reason to try minidb

OpenRefine already supplies a much richer cleaning application, including transformations and clustering. A broad replacement would be a large project. The proposed experiment should isolate one task: reversing a selected batch while retaining edits to other records.

SQLite is a credible backend for exactly this application. Its [session extension](https://www.sqlite.org/sessionintro.html) supplies inversion and conflict handling; its [trigger-based undo recipe](https://www.sqlite.org/undoredo.html) shows another implementation. Current [Node SQLite documentation](https://nodejs.org/api/sqlite.html) exposes session creation and changeset application, although it does not document an inversion method. Application-managed inverse records remain possible.

[Dolt Workbench supports DoltLite](https://www.dolthub.com/blog/2026-08-21-dolt-workbench-supports-doltlite/) with a graphical interface and database version control. The [August 31 DoltLite beta announcement](https://www.dolthub.com/blog/2026-08-31-doltlite-beta/) documents extensive versioning capabilities. History is established competition.

The reason to use minidb for this experiment is implementation already present in this repository: `changes()` provides before/after records, `watch()` updates views, and `undo(txn)` reverses a batch after checking current row values. The [taskboard example](../../examples/taskboard/board.ts) demonstrates their composition. That saves prototype work; it is not a durable competitive advantage. The application should keep its storage adapter replaceable.

## What the current code actually supports

Ran all existing tests: **68 passed across 10 files**, including the real-file crash test. `npm run typecheck` passed. These checks ran on Node v20.18.0; they do not certify production readiness.

Also ran a synthetic catalog workload against the current source, with history enabled and a real temporary database file:

| Check | Result |
| --- | --- |
| Import 1,000 compact metadata records in a transaction | Passed |
| Apply a 100-row subject correction with one transaction identifier | Passed |
| Retain the receipts after clean close and reopen | Passed |
| Undo that batch after an independent title correction on another row | Passed; all 100 subject changes reversed, independent title retained |
| Attempt undo after a later title correction on an affected row | One conflict reported; all rows and transaction counter unchanged |
| Watch the corrected subject selection | Initial callback plus batch callback; independent title correction did not emit a changed result |
| Run `db.verify()` after the workflow | Passed |

Single-run observations: import 52 ms; batch update 13 ms; reopen 4 ms; selective undo 22 ms. Final checkpointed file: 348,160 bytes. These are workload observations, without repeated measurements or a competitor baseline. They are not a throughput benchmark. CSV parsing, a graphical interface, real catalog data, and a crash during this particular workflow were not exercised.

Scratch script: `/private/tmp/minidb-catalog-probe-20260915.mjs`. Results: `/private/tmp/minidb-catalog-usecase-s1rR0C/results.json`. From the repository, the local script runs with `node --import tsx /private/tmp/minidb-catalog-probe-20260915.mjs`.

Important constraints from code inspection and probing:

- **History reduces the usable record size.** The original 2,200-byte example was a failing test point, not the ceiling. The follow-up verifies a maximum of 2,001 bytes for a same-length ASCII replacement in `t(id, value)` with key `1`, and 1,972 bytes when the catalog schema also stores `Example Press` and `History`. Other fields, keys and JSON escaping reduce available space. Validate the encoded receipt. Real book records fail in substantial numbers; see the size gate above.
- **Undo checks whole-row current values.** A later change to another column on the same row still blocks the batch. It does not merge individual cells or skip conflicting records. Changes made and then restored to identical values are not detected as intervening edits. There is no tracking of logical dependencies between different rows.
- **History stores data changes, not reusable transformation programs.** Operation labels, timestamps and import provenance need an application metadata table. Schema changes are not covered by row undo. Keep the first schema and internal primary keys fixed.
- **The current package runs in Node.** A local browser UI would need a Node host and a transport for watch results. There is no ready browser storage adapter, sync, or concurrent ownership of one file.
- **Views and history need bounded workloads.** Watches rerun queries after relevant commits; history lookup scans receipts. The engine lacks general string functions and aggregates. Implement a small set of transformations in the application; measure larger workloads before expanding scope.

## Smallest useful validation

Use a fixed record schema with an internal ID, title, publisher and subject. Import a source CSV into a separate project database, validate sizes, and offer one bulk replacement operation with a before/after view. Persist the operation description, expose history and conflict messages, and export the current records to a new CSV. Keep the source file intact. Large descriptions and arbitrary schema editing are outside this initial experiment.

Before any prototype, measure real exports and ask a cataloguer whether independent corrections commonly overlap on different columns of the same records. The first check is now complete and unfavorable for full-record book cleanup. The second is still pending. Only if a narrower scope passes both checks would the earlier three-user reuse trial be appropriate. No interviews or outreach have been performed.

If those users mostly edit overlapping columns on the same records, the current whole-row conflict policy may prevent the advertised task; evaluate cell-level history before expanding the engine. If they prefer OpenRefine's existing workflow, there is little justification for this application. The existing database learning material remains independently usable.
