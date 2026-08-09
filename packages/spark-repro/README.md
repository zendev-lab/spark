# spark-repro

`@zendev-lab/spark-repro` owns host-neutral reproduction semantics. Hosts provide
persistence, evidence lookup, canonical user interaction, scheduling, and rendering.

Spark does not bundle a model-specific reproduction skill. The reproduction
workspace owns its methodology, templates, and project-specific diagnostics;
Spark supplies the generic state, scheduling, and evidence boundaries.

## Autonomous vNext contract

The normative dual-lane, asynchronous-evidence, Profile/progress, numerical
frontier, ReportModel, and completion semantics are defined in
[`../../docs/specs/autonomous-dual-lane.md`](../../docs/specs/autonomous-dual-lane.md).
The `spark.repro.work-summary/v2` and `SparkSessionRepro` v7 adapters implement
that contract as structured state. Legacy work-summary/v1 and session v1-v6
records migrate only through explicit structured adapters; callers must not
emulate vNext by parsing reports or adding another scheduler/store.

## Canonical work summary

New cross-surface Repro state is written through
`@zendev-lab/spark-repro/work-summary`. `SparkReproWorkSummary` is the canonical
projection input for composition, Hub, and benchmark integrations; it does not
depend on Artifact storage, daemon state, or transcript text.

Its capability stages are `contract → reference → target → alignment → delivery`,
weighted `5 / 10 / 25 / 55 / 5`. Domain status and scheduler activity are
derived independently:

- a decision/approval retirement block produces `waiting_decision`, while
  independent work may remain `running` or `ready`;
- no human retirement block and unfinished Normative work produces `active`;
- all formal gates, ordered Normative retirement, completion-required unresolved
  discharge, terminal tasks, and the technical target produce `complete + sealed`
  at `delivery`.

`exploreFrontier` records reversible reachability only. `normativeCursor` owns
ordered retirement; out-of-order candidates remain buffered until dependencies,
current plan revision, step-definition digest, Evidence, and unresolved discharge
all pass. Every bridge, adapter, fallback, stub, assumption, or mismatch binds a
stable typed unresolved item before use.

Only accepted `entrypoint` rows in the Validation Matrix at the frozen
`minimum_complete` acceptance Profile contribute progress. Probe,
reduced/full observed Profile, diagnostic, Explore, Task, token-usage, and
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

## Versioned session protocol

The package root remains the compatibility execution and persistence model for
session snapshots. SparkSessionRepro v7 adds a versioned dual-lane binding over
the existing five-stage plan/subgoal protocol. Migrating v6 creates empty Explore
observations, candidates, and unresolved bindings and does not promote legacy
proof into Normative retirement. A later plan revision preserves observation and
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
or become `done` without a passing typed StepVerifier result. Safe-local steps require
structured proof bound to the current definition and `doneWhen`; decision and approval
steps additionally require a current canonical Ask receipt bound to the exact Step.

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

Stored v1-v6 snapshots migrate to v7. Invalid legacy proof is removed,
affected contracts/steps/gates reopen, and no legacy boolean or proof is promoted
into a user decision, passing validation, Explore observation, candidate,
unresolved discharge, or Normative retirement.

The setup stage first verifies whether the reference implementation named in
the contract is runnable. An unavailable reference is a blocking user decision:
ask how to construct or obtain it before any baseline probe, and do not invent
a substitute. Setup then researches reuse/adapt/new
implementation options and real-module/eager alignment paths before recording
the corresponding user decisions. Eager execution is a diagnostic path by
default, not silent evidence that the real module path is aligned.
