# @zendev-lab/spark-extension

Spark product extension composition root for native TUI, headless, and
structurally compatible extension hosts.

The package registers Spark commands, tools, shortcuts, renderers, and lifecycle
policy by composing the task, workflow, role, memory, ask, and host-neutral
capability packages. It does not own their durable stores.

The internal report-summary composition (`src/repro-report-summary.ts`) is the pure composition
boundary for report producers. It joins a canonical
`spark.repro.work-summary/v1` value with the daemon-owned public token usage
aggregate as `{ format: "spark-repro-summary/v1", work, tokenUsage? }`. It does
not read transcripts, persistence stores, or report Markdown.

The public `repro({ action: "project_report", workSummary: ... })` runtime bridge
passes the supplied facts through `buildSparkReproWorkSummary`, requires their
`reproId` to match the current durable Repro run, resolves every accepted formal
gate against the durable Evidence store, reads token usage through the public
daemon `usage.summary` RPC, and atomically writes each of
`outputs/spark-summary.json` and its deterministic `outputs/report.md`
projection. A usage RPC failure produces a warning and omits the optional token
projection; it never changes the derived technical status, progress, or goal.
`repro({ action: "sync_report" })` then reloads and validates the same envelope,
requires the Markdown bytes to match that typed projection, resolves accepted
evidence again, and uses its canonical title, stage, status (including
`waiting_decision`), and percentage to update the stable per-run Markdown
Document Artifact. It does not infer report metadata from the legacy session
Repro state.

An external benchmark must start the durable run with
`repro({ action: "start", reproId: manifest.run_id })`. This makes the daemon
ledger, causal child executions, canonical summary, Bench run, and stable report
Artifact share one identity; an already-active run rejects a different requested
identifier.

The same canonical `repro({ action })` surface composes the Repro-owned
three-lane lifecycle. `/repro <objective>` persists one internal `work_enqueue`
intent and immediately reserves the three stable lane Sessions and their
isolated GitChanges. Subsequent terminal TaskRuns advance the typed
Implementation → Exactness → Formalize → Exactness refresh → Implementation
refresh checkpoint chain automatically. `lane_result_record` is the only
public three-lane result mutation and may only replay Evidence already attached
to its exact terminal TaskRun; `work_register`, `work_rematerialize`,
`finding_record`, `mismatch_record`, `handoff_record`, `formalize_bind`, and
`resolution_record` are not public actions.

The extension resolves Evidence and GitChange Artifacts through their owners
and reconciles temporary work through TaskGraph. Root transcript compaction does
not own or truncate the three-lane checkpoint: continuation reloads durable
routes, bindings, receipts, TaskRuns, and bounded Session projection. Formalize
mutations still require the canonical integrator Session to own one attached
native `gh-stack` GitChange. The extension does not create another scheduler,
progress store, Git topology, or public alias.
