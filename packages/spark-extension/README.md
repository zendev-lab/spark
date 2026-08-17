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
three-lane lifecycle. `work_register` and `work_rematerialize` are lane-scoped.
Terminal `spark.repro.lane-result/v1` Evidence is validated and automatically
routed through the existing TaskGraph, Artifact, Session, and human-request
owners; `lane_result_record` is the recovery entrypoint. Manual finding,
handoff, Formalize binding, and resolution actions remain compatibility and
operator-recovery surfaces.

Implementation and Exactness receive independent WorkItem-by-lane candidate
GitChanges. Formalize uses one generation-bound stack-integrator Session and
canonical native `gh-stack` GitChange, with one Draft stack entry per WorkItem.
The driver may create scoped candidates and first Draft PRs, but has no path to
force-push, mark Ready, merge, close, change a PR base, or clean external state.
The extension derives routing intents and invokes owner APIs; it does not create
another scheduler, progress store, Git topology, Session owner, or public alias.
