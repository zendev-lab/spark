# Public tools and commands

This file names stable agent-facing capabilities. Schemas and result types live with their owner packages.

## Foreground commands

- `/plan` researches and creates/refines verifiable tasks without executing them.
- `/implement` claims and completes ready work.
- `/loop` starts a daemon-owned recurring Loop and must schedule each next tick; `/loop fresh <objective>` resets the hidden execution session for every tick while keeping the logical owner's state.
- `/goal` uses reviewer-backed decisions and reviewer-gated completion.
- `/workflow` executes a selected saved workflow; `/ultracode` explicitly opts into approval-gated fan-out.
- `/btw` opens and controls the daemon-owned, read-only Side Thread associated with the current parent session.

Session phases are `plan` and `implement`; research is a task/workflow capability, not a third
phase. Repro adds a Goal Contract, typed steps, explicit plan revisions, and evidence-derived gates.
Setup verifies the reference implementation named in the contract, asks how to obtain or construct
it when unavailable, and probes only an available or user-approved baseline. No caller can pass a
gate with a bare boolean.

Goal and repro keep planning and reconciliation in the main session. They call `ask` for material
user decisions instead of guessing. Repro ticks are dormant by default: `repro settle` schedules a
continuation only after semantic progress, and three unchanged settlements require a Recover Ask.

### Native `/btw`

Spark-native TUI registers one `/btw` command, not a family of colon-suffixed slash commands:

```text
/btw [show]
/btw ask <question>
/btw reset <contextual|tangent>
/btw handoff <full|summary> [instructions]
/btw model <inherit|provider/model>
/btw thinking <inherit|off|minimal|low|medium|high|xhigh>
```

`show` creates or reuses the parent's child through the daemon and displays its mode, generation, status, effective model/thinking settings, pending count, and recent visible exchanges. `ask` submits to that child; `reset` starts a new generation; model/thinking commands set or clear child-only overrides; handoff admits the pinned current head to the parent and resets the child after acceptance. Generation, head, idempotency, isolation, and read-only enforcement are daemon contracts, not TUI state.

TUI and Hub use the same daemon-owned Side Thread contract; presentation stays separate from lifecycle, isolation, and handoff semantics. Full lifecycle and safety semantics are in [`sessions-and-channels.md`](./sessions-and-channels.md#side-threads).

## State and execution

- `task_read` inspects task, project, workspace, project-list, and run state.
- `task_write` selects projects and plans, claims, finishes, recovers, or updates tasks. New tasks and any update that changes task-plan content require an objectively verifiable plan. To change only an existing task's dependency set, `action: "plan"` accepts one exact `taskRef`, `name`, or `title` selector plus `dependsOn`; the array atomically replaces the complete set (`[]` clears it), preserves plan items, and skips unchanged-plan readiness review while still rejecting unknown, cross-project, cancelled-prerequisite, self, and cyclic edges.
- `assign` dispatches the ready frontier and dry-runs by default. Callers may
  pass an explicit `taskRefs` allowlist; an active Repro requires the verified
  safe frontier and fails closed without it.
- Each Task may carry an `executionPolicy` with continuity, isolation,
  comparison side, per-side GPU count, minimum GPU memory, topology class,
  node exclusivity, concurrency keys, timeout, and bounded attempts. Paired
  comparisons reserve the requested GPU count independently for Reference and
  Target.
- The scheduler reconstructs active leases from queued/running TaskRuns after
  restart. Terminal TaskRuns release their GPU and concurrency-key leases.
  Operators can provide a precise node inventory through
  `SPARK_TASK_RESOURCE_INVENTORY`; otherwise Spark uses
  `CUDA_VISIBLE_DEVICES`, then a bounded `nvidia-smi` probe. Topology-qualified
  Tasks remain deferred until the inventory declares the requested class.
- Repro-specific saved workflows are available as
  `builtin:repro-stage-orchestrate`, `repro-module-sweep`,
  `repro-first-divergence`, `repro-change-loop`, `repro-long-horizon`,
  `repro-axis-qualify`, `repro-topology-compose`, `repro-evidence-review`, and
  `repro-delivery-sync`. They coordinate bounded work inside one Project Task;
  durable Project Task dispatch and promotion still belong to `assign` and the
  owner Repro Session.
- Repro extension roles cover distributed running, first-divergence
  localization, confirmed precision fixes, exclusive performance benchmarks,
  and independent numerical audits. Workflow agents may select a loaded Role
  with `roleRef`; Role specs still cannot ask, spawn, dispatch Tasks, or promote
  gates.
- `todo` mutates the session-bound standalone checklist; its current state is projected automatically rather than fetched in normal agent flow.
- `phase` owns the Session operating state. `goal`, `loop`, `workflow`, and `repro` bind domain contracts to the daemon Loop without creating executor kinds.
- Repro reporting uses two explicit write actions. External benchmarks first bind identity with `repro({ action: "start", reproId: manifest.run_id })`. `repro({ action: "project_report", workSummary })` then validates canonical work facts, derives status/progress/technical completion, joins only the daemon-owned `usage.summary` projection for that same `reproId`, and writes `outputs/spark-summary.json` plus its deterministic `outputs/report.md` projection; it never scans a transcript. `repro({ action: "sync_report" })` verifies those Markdown bytes against the typed summary before updating the stable per-run Markdown Document Artifact. Missing usage yields a warning and an envelope without `tokenUsage`; it cannot change any technical gate.
- `workflow` lists, reads, and runs controlled `builtin:`, `workspace:`, or `user:` selectors. Project definitions live only at `.agents/workflows/<id>/WORKFLOW.md`; top-level scripts and inline source are rejected.

### Hook-projected state

The `spark.todos` context provider reads durable Session TODO state at model-round start. A changed snapshot is current for that round and supersedes older snapshots for the same provider; clearing the checklist emits one tombstone. Provider content is hidden `runtime_data/untrusted`: statuses and identifiers are state facts, while checklist text remains data rather than instructions. Unchanged snapshots are not appended repeatedly, and session compaction or switching resets the delivery cursor so current state is projected again.

TODO mutations still reload the durable store and validate their target at execution time; a hook snapshot is never a write precondition. `context({ action: "preview", providerIds: ["spark.todos"] })` is the explicit diagnostic path. `todo({ action: "list" })` remains a deprecated compatibility read for this migration and is not part of normal model guidance.

Task and goal state may adopt this projection pattern only after their multi-session write paths expose revision, lease, or equivalent conflict validation. Until then, historical summaries and hook text do not replace the scoped `task_read` and `goal({ action: "status" })` authority rules.

Direct role/session calls do not create task attribution.

These commands and their tools send `loop.*` controls to the
daemon. TUI, Hub, and compatible extension hosts never own their timer,
generation, retry, or next-turn continuation. The full runtime contract is in
[`daemon-autonomous-loops.md`](./daemon-autonomous-loops.md).

## Deliberation

- `fusion({ action: "deliberate" })` is an opt-in Spark-native capability that runs two to four
  bounded leaf opinions concurrently and asks one bounded Judge leaf for strict structured
  comparison. The calling session model remains the Writer; Fusion never writes the user-facing
  final answer itself.
- Panel and Judge leaves have no tools and cannot recurse into Fusion. Input and perspective text
  are untrusted data under fixed system briefs. Invalid prose is not accepted as structured
  success, and one surviving panel never becomes fabricated consensus.
- Fusion is approval-gated, sequential at the public tool boundary, and absent from the default
  extension profile because one call fans data out to multiple model invocations. Enable it
  explicitly with `--extension @zendev-lab/spark-fusion/extension` or equivalent host config.
- In `alignment`, consider Fusion only after runtime evidence localizes the first
  divergence and multiple plausible hypotheses remain, evidence conflicts, or the latest verdict
  is inconclusive. Skip it when the next single-variable experiment is already clear and cheap.
  Send only a bounded current evidence summary with original evidence refs, and do not repeat a
  consultation until evidence or hypotheses materially change.
- Fusion failure is non-blocking: continue SOLO. Its result may recommend one cheap
  single-variable experiment, but the main repro session remains the sole writer and executor.
  Fusion cannot confirm a runtime claim, emit a verdict, satisfy proof or a gate, or create
  evidence or an Artifact; Artifact kinds remain exactly
  `issue | git_change | document`.

## Evidence and context

- `ask` is the only structured question surface; cancellation is not approval.
- `evidence` is an **agent-internal ledger** (not Hub/user UI): compact provenance-backed `record | trace | knowledge | document` notes. Prefer `format=json` bodies `{ summary, data? }`. Tool-result side channels publish `evidence.update` (not `artifact.update`).
- `artifact` owns product-facing atomic deliverables only:
  `issue | git_change | document`. `git_change` is one aggregate containing
  one owning worktree and one native GitHub PR stack; stack entries are not
  separate Artifact refs. Its lifecycle is mutated only through
  `git({ action })`, with `gh stack` as topology authority. `document` owns
  typed content and revision/progress metadata. New writes accept Markdown,
  safe MDX-lite, sanitized HTML, or read-only Artifact-preview A2UI; Spark UI, plain text, JSON,
  and unknown Document media are legacy-read-only. Preview is a view opened
  with `artifact({ action: "open_preview" })`, not an Artifact kind.
  `artifact({ action: "sync_file" })` accepts only a cwd-local regular,
  non-symlink UTF-8 file up to 32 KiB. Identical syncs are no-ops;
  metadata-only changes preserve the content revision.
  Legacy v1 `pr`/`preview` records are normalized lazily on read without
  destructive bulk migration. Product tool results publish `artifact.update`.
  The separate daemon-bound Repro Workbench may render the same A2UI protocol
  interactively inside its owning Session, but it accepts only the closed typed
  Loop-control vocabulary and never changes Artifact preview behavior.
- `task_write({ action: "artifact_link" | "artifact_unlink" })` maintains
  durable, idempotent `Task.artifactRefs`. This slice deliberately adds no
  `Workstream` aggregate and no Task parent/subtask relation.
- `memory` is the only public memory tool: `memory({ action, kind? })` with `kind: "entry" | "learning" | "candidate"` (default `entry`). Durable entries, evidence learnings, and recall candidates share this surface. Pi-memory aliases (`memory_write`/`memory_read`/`scratchpad`/`memory_search`/`memory_status`) are opt-in (`enablePiCompatAliases`; Pi product entry on, Spark native off). Reflection pipelines also live in `@zendev-lab/spark-memory` (under `.spark/memory/reflections/`).
- `context` lists/previews registered bounded providers and accepts no arbitrary provider prompt.

## Roles and sessions

- `role` manages reusable definitions/model settings and fresh anonymous calls. It does not accept session lifecycle, mail, `resource=session`, or `sessionId`.
- `session` manages persistent lifecycle, bindings, calls, classification, and mail. List/get expose surface, activity, lifecycle, adapters, and external keys.
- `send kind=request` asynchronously submits the exact body to an unarchived local session. Default `wait=accepted` returns after acceptance; when the target reaches a terminal status the daemon submits one completion-summary turn on the sender so it can synthesize immediately. `wait=completed` polls for a bounded terminal result without a second wake and without cancelling execution on wait timeout.

Both call paths share one headless host and `SparkAgentSession`. Full policy is in [`sessions-and-channels.md`](./sessions-and-channels.md).

## Shell and files

`spark-cue` tools (`cue_exec`, `cue_run`, `cue_script`, `script_run`, `script_eval`, `cue_jobs`, `cue_resources`, `cue_schedule`, `cue_scope`, `cue_history`) provide direct-exec jobs and scripts. `cue_resources` — inspect resource providers and snapshots.

Local Cue execution inherits the immutable session cwd. Relative `cue_exec.cwd` and script paths resolve from that cwd; `cue_scope` may change only cue-shell's tool-local scope and never mutates the Spark session cwd. SSH profiles do not translate local paths: `cue_exec` requires an absolute remote cwd (or `SPARK_CUE_REMOTE_CWD` supplied by the profile/host), and other remote execution also requires that explicit remote cwd.

`script_run`/`script_eval` support cue-shell and Python. Python uses `uv run --script <path>` or `uv run --script -`; `venv` is python-only, and `scope` is not a `script_run`/`script_eval` parameter. Cue-shell scripts use `RunScript { path, input }` in a fresh isolated scope.

`spark-files` provides bounded `read`, `write`, `edit`, `grep`, and `find`; `ls` is not registered by default. Relative paths use the immutable session cwd. `read` has one UTF-8 text protocol: it always renders the raw-content SHA-256 version and stable `LINE#HASH:text` anchors for the returned window, with matching structured metadata; the byte limit applies to this final rendered output, including anchors. Read pagination accepts positive integers only; LF, CRLF, CR-only, mixed separators, and a UTF-8 BOM are reported as metadata, while invalid UTF-8 fails explicitly. `write` has no blind compatibility path: `expectedVersion` is required and must be the version returned by `read`, or `missing` for create-only intent. It uses a same-directory temporary file plus fsync/rename and rejects stale rewrites. Spark serializes writes by canonical target path inside one process (including symlinked parent aliases), rejects direct symbolic-link targets, and therefore gives same-version in-process Spark writers one winner. `edit` commits through the same atomic content-version check. Supplying a `git_change` `artifactRef` resolves the Artifact from the owning workspace store and then routes relative paths to its attached worktree; it never creates a second `.spark` store inside that worktree. Cross-process and non-cooperating external writers remain an optimistic-concurrency race; atomic replacement also detaches the replaced name from any sibling hard links rather than mutating their shared inode.

Spark-native hosts execute Files in process. The external Pi product retains its
own native file and search tools and must not register Spark replacements. The
explicit daemon Files adapter is migration/test-only, not a supported Pi
product surface. Remaining additive Pi-compatible Artifact, Git, and Lens tools
may use typed daemon RPC: they may start the daemon once and retry only a
failure proven to occur before dispatch. Predictable cwd and operation-id
failures return structured tool results; a post-dispatch mutation failure is
never replayed through typed or legacy transports. Full compatibility admission
and removal rules are in
[`pi-product-compatibility.md`](./pi-product-compatibility.md).

These are working-tree mechanisms, not Graft state. Graft remains sealed and
opt-in; it is not loaded by Spark's default extension profile or base prompt,
and its source is unchanged by the Git workflow refactor.

## Tool execution policy

Tool owners declare one canonical `policy` with `effect`, sibling-call
`executionMode`, domains, phases, and approval. A tool may refine that
conservative registration envelope with argument-aware `resolvePolicy`; the
host resolves the concrete call policy before scheduling or approval. Legacy
top-level effect/execution/approval fields remain compatibility inputs, but
conflicts or malformed declarations fail closed to unknown effect, sequential
execution, and required approval.

Registered tools and active tools are distinct. Only active tools enter the model schema or prompt manifest. A batch executes concurrently only when every call resolves to an active, approval-free `read` tool with `executionMode=parallel`; mixed, unknown, write-capable, or policy-changing batches stay sequential. Parallel results are committed to the transcript in the model's original call order, with a default concurrency limit of four.

## Web and host policy

`web_search`, `fetch_content`, `get_search_content`, and `code_search` treat fetched text as untrusted data. Credentials are configuration and must not appear in output.

Use one canonical action tool per stateful domain. Hosts may narrow surfaces;
channel-bound hosts expose only `session`, `ask`, `context`, and `todo`, and
permanently disable cue tools, `role`, `assign`, and `workflow`.
