# spark-repro

`@zendev-lab/spark-repro` owns host-neutral reproduction semantics. Hosts provide
persistence, evidence lookup, canonical user interaction, scheduling, and rendering.

Spark does not bundle a model-specific reproduction skill. The reproduction
workspace owns its methodology, templates, and project-specific diagnostics;
Spark supplies the generic state, scheduling, and evidence boundaries.

## Autonomous vNext contract

The normative three-lane, asynchronous-evidence, Profile/progress, numerical
frontier, ReportModel, and completion semantics are defined in
[`../../.agents/notes/contracts/autonomous-three-lane.md`](../../.agents/notes/contracts/autonomous-three-lane.md).
`SparkSessionRepro` v9 implements that contract as structured state, while the
`./three-lane-work-summary` entrypoint defines the pure
`spark.repro.work-summary/v2 -> v3` migration used by projection adopters.
Legacy work-summary/v1-v2 and session v1-v7 records migrate only through
explicit structured adapters; callers must not emulate vNext by parsing reports
or adding another scheduler/store.

## Canonical work summary

New cross-surface Repro state is written through
`@zendev-lab/spark-repro/three-lane-work-summary`.
`SparkReproWorkSummaryV3` is the canonical ReportModel input for composition,
Hub, and benchmark integrations; it does not depend on Artifact storage,
daemon state, or transcript text. The v2 builder remains the validated formal
authority submodel and compatibility input, and only the Repro-owned pure
migration/projection may wrap it with three-lane facts.

Its capability stages are `contract → reference → target → alignment → delivery`,
weighted `5 / 10 / 25 / 55 / 5`. Domain status and scheduler activity are
derived independently:

- a decision/approval retirement block produces `waiting_decision`, while
  independent work may remain `running` or `ready`;
- no human retirement block and unfinished Formalize work produces `active`;
- all formal gates, ordered Formalize retirement, completion-required unresolved
  discharge, terminal tasks, and the technical target produce `complete + sealed`
  at `delivery`.

Implementation records reversible reachability only. Exactness owns first-bad
localization and mismatch classification. Formalize owns ordered retirement;
out-of-order candidates remain buffered until dependencies,
current plan revision, step-definition digest, Evidence, and unresolved discharge
all pass. Every bridge, adapter, fallback, stub, assumption, or mismatch binds a
stable typed unresolved item before use.

Only accepted `entrypoint` rows in the Validation Matrix at the frozen
`minimum_complete` acceptance Profile contribute progress. Probe,
reduced/full observed Profile, diagnostic, Implementation/Exactness, Task, token-usage, and
active-experiment work remains visible but contributes zero. Unknown required
gate denominators serialize as `quantified=false` and `percent=null`.

A Profile binds model scope, compute scope, frozen step denominator, exact
`dp/tp/pp/ep/etp/cp/sp/worldSize`, canonical strategy identities, and runtime
facts. In v2, `worldSize = dp × tp × pp × cp × max(ep, etp)` and each active
axis has exactly one frozen strategy identity. Legacy missing topology/runtime
facts remain typed `unknownFields`; they cannot enter formal progress.
The technical target is achieved only when `minimum_complete` has a ready
reference and target, reaches `requiredSteps`, and validates the complete exact
reference-parity topology and strategy set in one owning-entrypoint receipt;
separate partial-topology gates cannot be unioned into parity.

Evidence and user-visible artifacts use separate namespaces. Gates, decisions,
experiments, and conclusions carry `evidenceRefs`; workspace-local machine
receipts use distinct `evidencePaths`; `artifactRefs` bind presentation
artifacts, with optional `reportArtifactRef` identifying the stable per-run
Markdown Document. A standard-Markdown workspace export may be produced for
offline handoff, but it is not a state source or a required live-Artifact
intermediate.

## Command launch and checkpoints

`/repro <objective>` is the product entrypoint. The command owner derives and
persists one strict `spark.repro.work-enqueue/v1` intent and its deterministic
Implementation start route before it creates a GitChange, Task, lane Session,
or TaskRun. Replaying the command or recovering after a process crash therefore
resumes the same WorkItem and route instead of duplicating execution resources.

The three lane Sessions have stable runtime identities. Implementation starts
from the frozen trunk or current Formalize revision; Exactness and Formalize may
be reserved immediately but become runnable only after their typed upstream
route is materialized. Each binding revision records the exact `originRouteId`
that created it. Terminal results, direct-user answers, forward handoffs, and
backward refreshes form durable checkpoints; transcript text and model context
are never recovery authority.

Session context compaction may remove Root or lane narration, but it must not
rewrite, synthesize, or discard a Repro checkpoint. The bounded Session snapshot
keeps only a projection suitable for continuation; the owner resumes from the
persisted WorkItem, routes, bindings, receipts, TaskRun envelopes, Evidence, and
GitChange revisions. The first turn after compaction may inspect `status`, but it
must not replay `/repro <objective>` or create replacement lane Sessions.

An `attention_request` is a checkpoint, not a terminal lane result. The request
is projected to Root through the existing Ask/EvidenceRequest owner. A direct
user AnswerEvent creates a `resume_binding` route that reuses the original lane
Session and GitChange, including across daemon restart and context compaction.

`spark.repro.three-lane-session/v2` rejects stale or foreign results with a
stable receipt without consuming a later valid result. Only a Formalize
resolution advances `formalizedTip`, and an Exactness-to-Implementation refresh
must name its parent Formalize resolution.

## Versioned session protocol

The package root remains the compatibility execution and persistence model for
session snapshots. SparkSessionRepro v9 adds a versioned three-lane binding over
the existing five-stage plan/subgoal protocol. Migrating v7 maps Explore
observations into Implementation, creates empty Exactness state, and does not
promote legacy proof into Formalize retirement. A later plan revision preserves observation and
unresolved identities, but resets revision-bound candidates and retirement rather
than inferring them from legacy `done` status.

The legacy protocol includes four durable structures:

- a Goal Contract with objective, constraints, non-goals, success criteria,
  required evidence, and explicit authority boundaries;
- a complete typed Step plan whose steps each have one goal, `doneWhen`,
  `evidenceRequired`, authority, and optional dependencies;
- append-only Plan Revisions; unchanged stable step definitions retain their
  progress, while changed definitions reopen fail-closed;
- a semantic Stop Guard that fingerprints inspectable progress and requests a
  Recover Ask after three unchanged settlements.

Changing the Goal Contract returns it to `draft`, clears its freeze evidence,
and reopens `repro-contract-frozen`. A plan revision must include at least one
step for every configured stage, use unique stable ids, and have an acyclic
dependency graph. Difficulty is an integer from 1 to 10 and enforces adaptive
minimum plan sizes of 4, 6, 8, 11, or 13 steps; the fixed five-stage coverage
requirement still applies. A step cannot start before its dependencies finish
or become `done` without a passing typed StepVerifier result. `safe_local`
steps are worker-dispatchable and require structured proof bound to the current
definition and `doneWhen`. `driver_local` steps use the same evidence proof but
remain owner/driver-only and are never dispatched to workers. `ask_decision`
and `ask_approval` steps additionally require a current canonical Ask receipt
bound to the exact Step.

Setup is research-first and separates three requirement kinds:

- `evidence` records facts established by evidence refs;
- `decision` records receipt-backed user-answer evidence and the selected value;
- `validation` records a command, result evidence ref, and pass/fail result.

Readiness and stage gates are derived from these records. Callers cannot pass a
gate by writing a bare boolean.

Normal driver success is dormant. A daemon-owned tick must call `repro settle`
after leaving a verifiable checkpoint. A changed semantic fingerprint schedules
the next tick; three unchanged settlements stop automatic continuation and
require one concrete canonical Ask. Safe transient execution retry/backoff
remains daemon-owned and is deliberately separate from semantic stagnation.

Stored v1-v8 snapshots migrate to v9. Invalid legacy proof is removed,
affected contracts/steps/gates reopen, and no legacy boolean or proof is promoted
into a user decision, passing validation, Implementation observation, Exactness
finding, candidate, unresolved discharge, or Formalize retirement. V8 lane
bindings remain read-only compatibility facts because their originating route
cannot be proven; an explicit command-derived enqueue may safely rematerialize
the same WorkItem.

The setup stage first verifies whether the reference implementation named in
the contract is runnable. An unavailable reference is a blocking user decision:
ask how to construct or obtain it before any baseline probe, and do not invent
a substitute. Setup then researches reuse/adapt/new
implementation options and real-module/eager alignment paths before recording
the corresponding user decisions. Eager execution is a diagnostic path by
default, not silent evidence that the real module path is aligned.
