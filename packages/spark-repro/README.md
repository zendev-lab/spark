# spark-repro

`@zendev-lab/spark-repro` owns host-neutral reproduction semantics. Hosts provide
persistence, evidence lookup, canonical user interaction, scheduling, and rendering.

Spark does not bundle a model-specific reproduction skill. The reproduction
workspace owns its methodology, templates, and project-specific diagnostics;
Spark supplies the generic state, scheduling, and evidence boundaries.

## Canonical work summary

New cross-surface Repro state is written through
`@zendev-lab/spark-repro/work-summary`. `SparkReproWorkSummary` is the canonical
projection input for composition, Cockpit, and benchmark integrations; it does not
depend on Artifact storage, daemon state, or transcript text.

Its capability stages are `contract → reference → target → alignment → delivery`,
weighted `5 / 10 / 25 / 55 / 5`. Status is derived rather than written:

- any typed pending decision produces `waiting_decision` and must carry its canonical
  typed `askRef` so Cockpit can navigate to the owning Ask;
- no pending decision and unfinished gates produces `active`;
- all formal gates plus the technical target produce `complete` at `delivery`.

Only accepted formal gates for `minimum_complete` contribute progress. Probe,
reduced-profile, diagnostic, and active-experiment work remains visible at the
frontier but contributes no percentage. The technical target is achieved only when
`minimum_complete` has a ready reference and target, reaches `requiredSteps`, and
validates exactly the declared reference-parity distributed strategies in one formal
run at the frozen `validationTopology`; separate partial-topology gates cannot be
unioned into parity.

Evidence and user-visible artifacts use separate namespaces. Gates, decisions,
experiments, and conclusions carry `evidenceRefs`; `artifactRefs` bind presentation
artifacts, with optional `reportArtifactRef` identifying the stable per-run Markdown
report Document.

## Legacy session protocol

The package root remains the compatibility execution and persistence model for
existing session snapshots. It keeps the fixed
`setup → scaffold → reproduce → scale → deliver` evidence gates and its existing
versioned migrations. Migrating those stored stages, plans, subgoals, and extension
adapters requires an explicit versioned adapter; callers must not reinterpret them as
the new work-summary stages in place.

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

Stored v1/v2/v3 snapshots migrate to v4. Invalid legacy proof is removed,
affected contracts/steps/gates reopen, and no legacy boolean is promoted into a
user decision or passing validation.

The setup stage first verifies whether the reference implementation named in
the contract is runnable. An unavailable reference is a blocking user decision:
ask how to construct or obtain it before any baseline probe, and do not invent
a substitute. Setup then researches reuse/adapt/new
implementation options and real-module/eager alignment paths before recording
the corresponding user decisions. Eager execution is a diagnostic path by
default, not silent evidence that the real module path is aligned.
