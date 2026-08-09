# Autonomous dual-lane Repro, ReportModel, and asynchronous evidence

Normative contract for Spark Goal/Repro autonomy, model-reproduction progress, human evidence requests, deterministic reporting, and Workbench projection.

## Purpose

A reproduction run must expose the end-to-end execution surface as early as possible without weakening formal correctness. Spark therefore maintains two concurrent lanes:

- **Explore** advances reachability, may execute out of order, and may use reversible bridges, adapters, stubs, fallbacks, or constrained assumptions.
- **Normative** preserves the authoritative `decompose → establish evidence → converge → harden` order and retires typed steps only after their formal requirements pass.

The primary user view is a stable Document Artifact and its sibling Workbench projections. It must answer, in order:

1. What is the status, stage, acceptance Profile, and formal progress?
2. Where is the current numerical blocker, and what single-variable experiment is active?
3. What is the smallest next action, and what binary result passes it?
4. Which conclusions are established, and where is their evidence?

This contract does not create another scheduler, Task graph, Evidence store, human-interaction ledger, or Artifact kind.

## Core invariants

1. Explore reachability is not correctness and contributes zero to formal progress.
2. A shortcut is dispatchable only when it creates or binds a stable unresolved item.
3. Diagnostic observations and specialist completion are candidates; they cannot retire a Normative step.
4. Candidate evidence may complete out of order. Normative retirement remains dependency-ordered and cursor-ordered.
5. Goal/Repro human questions are durable asynchronous evidence requests. They never attach a blocking continuation to the autonomous turn.
6. `waiting_decision` is a domain/report status, not a scheduler stop instruction. Independent work continues when ready.
7. `ReportModel` is built from structured facts. Markdown and A2UI are sibling projections; neither is parsed back into execution state.
8. Completion requires all formal gates, the frozen technical target, unresolved discharge, required hardening, and reviewer acceptance.
9. Workspace paths, Spark Evidence refs, and user-visible Artifact refs are distinct namespaces.
10. A stable per-run Document Artifact is the canonical human report page. A workspace `report.md` is an optional explicit export only.

## Ownership

| Domain | Authoritative owner | Owns | Must not own |
| --- | --- | --- | --- |
| Repro semantics | `@zendev-lab/spark-repro` | lanes, Profile, gates, progress, numerical frontier, unresolved items, ordered retirement, ReportModel input semantics | scheduling, Artifact persistence, transcript parsing |
| Task graph | `@zendev-lab/spark-tasks` | Project Tasks, readiness, claims, TaskRun attribution | Repro gate retirement, duplicate frontier state |
| Autonomous execution | Spark daemon | Loop timing, invocation admission, leases, retry, restart recovery, durable human waits/events | formal correctness inference, frontend-derived state |
| Product composition | `@zendev-lab/spark-extension` | tool policy, owner adapters, ReportModel composition, evidence validation, Artifact projection request | another Repro store or scheduler |
| Human interaction | daemon broker + shared protocol; Hub outbox/read model | durable request lifecycle, correlation, answer event, UI projection | synthesized answers, timeout-as-user-decision |
| User-visible products | Artifact owner; Hub/TUI/A2UI adapters | stable Document content/revision and read-only projections | technical gates, internal Evidence bodies, report-to-state parsing |

Task Sessions, `assign`, and controlled Workflows reuse the daemon scheduler. A specialist may produce an observation or evidence candidate; only the owner session may reconcile it into Normative state.

## Data flow and single source of truth

```text
manifest + Repro/Goal state + lanes + validation ledger + eval + repositories
                                  + daemon usage summary
                                           │
                                           ▼
                                      ReportModel
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
          structured summary    stable Markdown    Workbench A2UI
          JSON/wire projection  Document Artifact  projection
                                                               └──▶ Widget/Hub/TUI projections
                                     │
                                     └── optional explicit standard-Markdown export
```

The structured summary is a versioned, storage-neutral sibling projection used for bounded wire/persistence compatibility. It is not a second ReportModel store and cannot be parsed from Markdown. Widget/Hub/TUI may consume ReportModel directly or that typed summary adapter, never rendered text.

Forbidden reverse edges:

```text
report.md ─X─▶ ReportModel / gate / progress / UI
Artifact Markdown ─X─▶ Repro state
A2UI action ─X─▶ arbitrary tool or formal gate
transcript prose ─X─▶ frontier / decision / completion
```

An Artifact update failure cannot change technical state. A presentation projection may be stale or unavailable while the Repro facts remain valid. The UI must label that condition rather than infer replacement facts.

## Lane model

### Explore lane

`exploreFrontier` records the furthest observed stage/Profile boundary reached by executable work. Explore work may:

- run an official or reference-supported smaller topology;
- insert a reversible adapter or bridge;
- stub one unavailable integration boundary;
- execute a later surface probe before an earlier Normative gate retires;
- fan out independent shape, dtype, topology, checkpoint, or UI investigations.

Every shortcut must bind an unresolved item with:

```text
id
kind: bridge | adapter | fallback | stub | assumption | mismatch
ownerStepId or ownerTaskRef
createdAt and planRevision
impactScope
reversibility and rollbackAction
dischargeCriterion
dischargeStatus: open | discharging | discharged | superseded
observationRefs / evidenceRefs
```

Explore cannot set `technicalGoal.achieved`, accept a gate, finish a Task, or mark the run complete.

### Normative lane

`normativeCursor` identifies the earliest unretired typed step. Retirement requires:

- all dependencies retired;
- a passing typed verifier bound to the current step definition and plan revision;
- required formal Evidence refs resolved from the authoritative Evidence store;
- a current canonical direct-user receipt for decision/approval authority;
- no required unresolved item still open.

Evidence candidates that arrive for later steps remain in a candidate buffer. If completion timestamps are `S3 < S2 < S1`, the only valid retirement log is `S1 → S2 → S3`.

### Numerical frontier

The model distinguishes three claims:

| Boundary | Meaning | Example |
| --- | --- | --- |
| Native module boundary | Last exact native module input and first unequal native module output | RMSNorm input exact; RMSNorm output differs |
| Derived reference boundary | Earliest unequal stage in an explicit, separately executed reference decomposition | FP32 mean-square differs in a replay |
| Native internal boundary | Instrumented evidence from the actual fused/native kernel internals | native reduction intermediate differs |

A derived post-output replay cannot establish a native internal boundary. UI and reports must carry `established | not_established` independently for all three.

`numericalFrontier` contains:

```text
lastGood: step / layer / module / operator / tensor / rank
firstBad: same location vocabulary or not_established
equalityRule: raw_bits | normalized_hash | tolerance
comparedInventory: quantified denominator or unquantified
exactCoverage: tensors / elements / steps / topology
maxAbsDiff / maxUlp / signedZero
activeBlocker
```

Unknown inventory is `unquantified`, never zero.

## Profile

Every gate, validation, experiment, frontier, conclusion, and progress claim binds a Profile. The run may retain multiple observed Profiles, but vNext has exactly one frozen `acceptanceProfile`. In this contract version its `modelScope` must be `minimum_complete`; `probe`, `reduced`, and `full` remain representable observed scopes but carry zero formal weight. A future contract may make another scope formally eligible only by introducing a new version, explicit denominator, and migration—not by reinterpreting an existing run.

| Axis | Vocabulary | Rule |
| --- | --- | --- |
| Model scope | `probe`, `reduced`, `minimum_complete`, `full` | The acceptance target freezes one scope. `minimum_complete` retains every required mechanism with the smallest non-toy official-weight graph. `full` means the complete official parameter graph. |
| Compute scope | `forward`, `backward`, `optimizer`, `checkpoint` | An optimizer transaction includes forward, backward, update, and required optimizer-state facts. |
| Steps | `completed / target` | Single-step reachability is not multi-step alignment. The denominator must be frozen. |
| Topology | `validationTopology` with `dp`, `tp`, `pp`, `ep`, `etp`, `cp`, `sp`, `worldSize`, plus `strategies[]` | Use official/reference-supported strategies. Each strategy records `axis`, stable `id`, `source=official|reference`, `revision`, and `configDigest`. If one device cannot hold the acceptance Profile, PP/EP/TP are valid acceptance topology, not an automatic scope expansion. |
| Runtime | framework, device, dtype, hardware, model revision, config digest | Different runtime facts create a different Profile binding. |

A topology may not silently drop `etp` or another frozen dimension because an older projection lacks a field. Compatibility readers render it as unknown and remain fail-closed. Strategy equality canonicalizes by `axis + id + source + revision + configDigest`; the complete sorted set and all topology counts must match the frozen acceptance Profile in one formal entrypoint receipt. Separate partial-topology or partial-strategy gates cannot be unioned into parity.

## Validation Matrix

Invocation path and evidence authority are orthogonal:

| Field | Values | Meaning |
| --- | --- | --- |
| `invocationClass` | `owning_entrypoint`, `isolated_diagnostic` | How the work ran |
| `evidenceClass` | `entrypoint`, `probe` | Whether the result may advance a formal gate |

A diagnostic can be launched through an owning entrypoint and still remain `probe`. A row contributes to formal progress only when all are true:

```text
evidenceClass == entrypoint
verdict == accepted
Profile == frozen acceptance Profile
gate denominator is known
Evidence refs resolve and pass their verifier
```

Each row carries Profile, repetitions, verdict, exact scope, command/receipt path, Evidence refs, and any Artifact refs. Probe rows remain visible in diagnostic history but have zero formal weight.

## Status and scheduler activity

### Domain status

`status` is derived, never hand-written:

- `active`: incomplete, with no current human decision/approval blocking the Normative cursor.
- `waiting_decision`: at least one pending durable human request blocks a required Normative retirement or fenced action.
- `complete`: all completion conditions pass at `delivery`.

### Scheduler activity

`schedulerActivity` is independent:

- `running`: at least one invocation is executing or reconciliation is active.
- `ready`: dispatchable independent work exists.
- `dormant`: no current dispatch/reconcile action exists; future evidence may reactivate the run.
- `sealed`: terminal complete projection; no new autonomous work is admitted.

The normative 3×3 legality matrix groups `running|ready` as progressing:

| Status \ activity class | Progressing (`running|ready`) | Dormant | Sealed |
| --- | --- | --- | --- |
| `active` | legal | legal when neither frontier has work | illegal |
| `waiting_decision` | legal and preferred when independent work exists | legal only when every remaining action depends on pending evidence | illegal |
| `complete` | illegal | illegal | required |

`waiting_decision + running` means “human attention is needed for one retirement, while independent work continues.” It must not be rendered as globally paused or stopped.

## Typed transitions

- **DL-01 — Explore advance:** a reachable execution observation advances `exploreFrontier`; formal progress and `normativeCursor` remain unchanged.
- **DL-02 — Shortcut registration:** creating a bridge/adapter/fallback/stub atomically creates an open unresolved item before the shortcut becomes dispatchable.
- **DL-03 — Candidate arrival:** specialist output enters the candidate buffer with Profile, plan revision, step digest, and provenance; it retires nothing.
- **DL-04 — Ordered retirement:** the owner verifies the current cursor candidate, dependencies, Evidence refs, and unresolved discharge, then advances exactly one Normative step; consecutive already-verified candidates may retire in order in the same reconciliation.
- **DL-05 — Async request:** a Goal/Repro ask persists a detached evidence request and returns `pending` immediately; no autonomous tool promise waits for the answer.
- **DL-06 — Local waiting:** a pending request bound to the cursor derives `status=waiting_decision`; independent Explore/evidence work remains dispatchable and may derive `schedulerActivity=running|ready`.
- **DL-07 — Answer reconciliation:** one idempotent AnswerEvent is delivered to the owning session; only a matching request id, plan revision, step digest, expected answer kind, and direct-user provenance may create decision Evidence or release the bound retirement.
- **DL-08 — Stale/duplicate/cancel:** stale, duplicate, cancelled, archived, empty, or synthetic answers remain in history/diagnostics and do not change the cursor, gate, unresolved status, or fenced action count.
- **DL-09 — Unresolved discharge:** an open item becomes discharged only when its typed discharge criterion and formal evidence pass; an observation or successful Explore run is insufficient.
- **DL-10 — Completion:** the reviewer derives `complete + sealed` only after all required steps/gates, target Profile, unresolved items, Tasks, hardening/recovery validations, and approvals pass.
- **DL-11 — Restart:** daemon reconstruction re-derives both frontiers, pending requests, activity, candidate buffer, and idempotency acknowledgements without duplicate dispatch or retirement.
- **DL-12 — Projection:** ReportModel/Artifact/A2UI revisions may change only after canonical facts change; presentation revision never changes technical gates.

## Asynchronous evidence requests

Goal/Repro use a detached `EvidenceRequest` specialization of the shared human-interaction protocol. It binds:

```text
humanRequestId
interactionRequestId / askRef
ownerSessionId
goalOrReproId
modeScope
planRevision
ownerStepId or unresolvedId
stepDefinitionDigest
requestHash
expectedAnswerKind
lifecycle: pending → answered | cancelled | archived
```

The daemon remains durable truth. Hub, channels, and TUI project the same request. Answer settlement writes one idempotent AnswerEvent keyed by `humanResponseId + interactionRequestId`.

In active Goal/Repro:

- canonical Ask accepts only detached asynchronous delivery;
- omitted/default blocking delivery, explicit blocking delivery, and `autoAnswer=true` fail with a stable `AUTONOMOUS_ASYNC_ONLY` policy error before UI/broker invocation;
- legacy Ask aliases cannot bypass the guard;
- reviewer timeout never synthesizes a user decision;
- an approval fences only its bound external/destructive action.

Ordinary non-autonomous sessions retain their existing interaction policy.

### Required behavior matrix

| ID | Setup / event | Required observable result |
| --- | --- | --- |
| `AE-01` | Active Goal/Repro calls Ask without delivery | `AUTONOMOUS_ASYNC_ONLY`; no UI wait, broker wait, or pending blocking continuation |
| `AE-02` | Active Goal/Repro calls explicit blocking delivery | Same fail-closed result as `AE-01` |
| `AE-03` | Active Goal/Repro requests `autoAnswer=true` | Same fail-closed result; reviewer fallback is not invoked |
| `AE-04` | Legacy Ask alias attempts any of `AE-01..03` | Same policy guard and stable error code |
| `AE-05` | Detached request binds the Normative cursor while independent Explore work is ready/running | `status=waiting_decision` and `schedulerActivity=ready|running`; independent dispatch continues |
| `AE-06` | Direct user answer matches request, owner, revision, step digest, and answer kind | Exactly one AnswerEvent and one decision Evidence candidate; owner reconciliation may release only the bound retirement/action |
| `AE-07` | Same human response is delivered twice | Second delivery is acknowledged as duplicate; no second Evidence, retirement, dispatch, or Artifact revision |
| `AE-08` | Answer targets an old plan revision or step digest | Preserved as stale diagnostic history; zero technical mutations |
| `AE-09` | Request is cancelled or archived before answer | Late answer is non-settling history; no gate or cursor mutation |
| `AE-10` | Daemon restarts with a pending request and running/ready independent work | Request, correlation, activity, and idempotency reconstruct; no duplicate request/dispatch; independent work resumes |
| `AE-11` | Pending request exists and every remaining action depends on it | `waiting_decision + dormant`; no busy poll or semantic-stagnation increment from elapsed waiting alone |
| `AE-12` | Synthetic reviewer timeout result resembles a user answer | Rejected as direct-user decision Evidence; no gate or fenced action release |

## Formal progress

Stage weights remain:

| Stage | Weight |
| --- | ---: |
| `contract` | 5 |
| `reference` | 10 |
| `target` | 25 |
| `alignment` | 55 |
| `delivery` | 5 |

For stage `s` with known eligible gate weights:

```text
stageFraction(s) = acceptedEligibleWeight(s) / totalEligibleWeight(s)
stageContribution(s) = stageWeight(s) × stageFraction(s)
formalProgress = Σ stageContribution(s)
```

A gate is **formally eligible** when the frozen contract requires that gate at the `minimum_complete` acceptance Profile and the gate declares an exact `validationTopology + strategies[]` match. Eligibility is independent of gate outcome: pending, failed, and accepted required gates all remain in `totalEligibleWeight(s)`. A gate contributes to `acceptedEligibleWeight(s)` only after its accepted status is backed by the required current-plan Evidence. Explore, probe, reduced/full observed Profiles, diagnostic observation, active experiment, child-run terminal status, Task count, and token usage are never formally eligible and contribute zero.

The denominator is the frozen inventory of all formally eligible gate weights across every stage, not the subset that has already produced accepted Evidence. If the frozen contract cannot enumerate that complete required inventory or any required gate weight is unknown, `progress.quantified=false` and `percent=null`. Surfaces render `unquantified`, not an estimate disguised as formal precision. A separate explicitly labelled forecast may exist in future but cannot share the formal progress field.

### Formal Evidence verifier boundary

Resolving an `evidence:*` ref proves only that a structured record exists. It contributes no formal weight until a current verifier produces a receipt with this stable shape:

```text
schema: spark.repro.formal-evidence-receipt/v1
evidenceRef
reproId
requirementId or stepId
planRevision
stepDefinitionDigest
invocationClass: owning_entrypoint
evidenceClass: entrypoint | probe
profileDigest
topologyDigest
verifierId / verifierVersion
verdict: accepted | rejected
verifiedAt
stale: boolean
superseded: boolean
```

The `profileDigest` covers the normalized frozen `minimum_complete` acceptance Profile. The `topologyDigest` covers the exact normalized `validationTopology + strategies[]`; partial matching is forbidden. A gate enters `acceptedEligibleWeight` only when the receipt resolves to the same current Repro and gate, the revision and definition digest are current, invocation class is `owning_entrypoint`, evidence class is `entrypoint`, both digests match the frozen contract, `verdict=accepted`, and both `stale` and `superseded` are false. Missing receipt, diagnostic/probe class, failed verifier, another Repro, stale revision, Profile/topology mismatch, or superseded Evidence all carry zero numerator weight. A plain `EvidenceStore.tryGet(ref)` success is never a formal verifier.

The receipt is an output of the registered verifier, not a field callers may self-assert in a work summary. ReportModel, Markdown, A2UI, transcripts, and historical review records cannot manufacture or amend it. Verification tests must cover every rejected case above plus one complete current receipt.

### Reproducible examples

| Example | Contract | Reference | Target | Alignment | Delivery | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Contract only | 1/1 | 0/1 | 0/1 | 0/1 | 0/1 | `5%` |
| Early alignment | 1/1 | 1/1 | 1/1 | 1/22 | 0/1 | `5 + 10 + 25 + 55×(1/22) = 42.5%` |
| Delivery pending | 1/1 | 1/1 | 1/1 | 22/22 | 0/1 | `95%` |
| Unknown alignment denominator | 1/1 | 1/1 | 1/1 | `accepted=1,total=?` | 0/1 | `unquantified / null` |

A run with `0/100` exact aligned optimizer steps may still have accepted contract/reference/target gates, but its alignment contribution must follow the frozen gate denominator rather than an arbitrary “work completed” estimate.

## Active experiment

One active experiment is rendered in full:

```text
hypothesis
onlyVariable
command
repetitions
expectedResult
falsifier
stopCondition
outputEvidencePaths
```

The hypothesis must be falsifiable, and exactly one variable changes. A missing field makes the experiment non-runnable. The report separately shows whether the experiment is formal `entrypoint` validation or a `probe`.

Resource-supported alternatives are autonomous. OOM is not a human decision while another official/reference-supported topology or resource class remains. A human decision is reserved for frozen-contract change, ambiguous reference ownership, scope expansion, exhausted supported resource/topology choices, framework-global behavior change, or external publication approval.

## ReportModel

`ReportModel` is versioned and storage-neutral. It includes:

```text
format / generatedAt / reproId / run identity / freshness
strongestClaim
status / schedulerActivity / stage
exploreFrontier / normativeCursor / retirementBlocks
acceptance Profile and formalProgress
run contract and source/config digests
formal gates and structured failures
Validation Matrix
numerical frontier and active experiment
pending evidence requests and independent ready/running work
smallest next action and binary pass criterion
conclusions and notEstablished
evidence index
repository states
recent accepted events
handoff / release decision
stable report Artifact binding
optional daemon token usage summary
```

Stored status, progress, technical completion, and close gate are re-derived and checked rather than trusted.

### Human view order

The first screen/sections must present:

1. strongest claim plus status, stage, Profile, formal progress, and scheduler activity;
2. failed/open gate, last-good/first-bad, active blocker, and active experiment;
3. smallest next action and binary pass criterion;
4. conclusions, not-established scope, and evidence index.

Long logs, tensor dumps, checkpoint bytes, and full inventories remain referenced evidence. ReportModel field ids and Evidence facts are locale-neutral; human copy is rendered at the surface boundary. Chinese-localized surfaces use Chinese-first operator labels and do not fall back to mixed-language state names when a Chinese translation exists.

### Document Artifact

Every run has one stable Markdown Document Artifact ref. Content updates increment its revision; identical content is a no-op. Progress metadata always carries stage and a compact label. It carries `percent` only when `progress.quantified=true`.

The Artifact is presentation, not a technical state owner. Artifact content uses standard Markdown only—no Spark MDX or A2UI syntax.

### Optional file export

A bench may explicitly export `outputs/report.md` for offline handoff. The export must be a byte-identical derivative of ReportModel and may be checked for staleness. It is not required for the live Artifact page, must not be parsed into UI/state, and must not be simultaneously hand-maintained.

The compatibility `sync_file` path remains bounded to a cwd-local regular non-symlink UTF-8 file and the product size limit. Artifact-only projection does not require a temporary report file.

## Reference namespaces

| Field | Shape | Owner and purpose |
| --- | --- | --- |
| `evidencePaths` | normalized workspace-relative regular-file paths | Bench validation receipts, logs, checker JSON, inventories; never a Spark ref |
| `evidenceRefs` | `evidence:*` | Spark internal provenance ledger; formal gate and conclusion proof |
| `artifactRefs` | `artifact:*` | User-visible Documents, issues, and GitChanges |
| `askRef` | `ask:*` plus wire correlation | Canonical human decision navigation/proof binding |

Fail-closed examples:

1. `evidence:abc` in `evidencePaths` is rejected.
2. `experiments/e050/comparison.json` in `evidenceRefs` is rejected.
3. `artifact:report` in gate Evidence or `evidence:gate` in `artifactRefs` is rejected.

Historical mixed fields migrate by classification into separate arrays. A migration never treats a path as accepted Evidence or a user summary record as canonical direct-user Ask evidence.

## Completion and close gate

`complete` requires all of:

- Normative cursor past all required steps in dependency order;
- every required formal gate accepted with current Evidence;
- acceptance Profile reaches required steps and exact frozen topology/strategies;
- every completion-required unresolved item discharged;
- required Project Tasks complete;
- restart/recovery, stale/duplicate answer, and hardening validations pass;
- no pending approval for delivery or external publication;
- completion reviewer verdict `achieved`, with no blockers.

Explore at `delivery`, an exit-zero run, a passing probe, a complete Artifact, or 100% reachability cannot satisfy this gate.

## Versioned migration

Migration is an owner adapter from legacy structured records into new structured records. It never reads Markdown, A2UI, transcript prose, or historical percentage text.

Every adapter emits one machine-checkable result rather than ad hoc `null`/omitted/default values:

```text
schema: spark.repro.migration-result/v1
reproId
sourceSchema
sourceDigest
migrationRevision
idempotencyKey
status: pending | applied | blocked
unknownFields[]
quarantinedValues[]
legacyEstimatedPercent?: number
evidencePaths[]
evidenceRefs[]
artifactRefs[]
promotedEvidenceRefs[]
checkpoint: { phase, lastAppliedOperation, sourceDigest }
```

Each `unknownFields[]` item contains `fieldPath`, `reason`, `sourceSchema`, and `formalEligibility=false`; it is never normalized to zero or to a default topology value. Each `quarantinedValues[]` item contains `sourceField`, `rawKind`, `reason`, `classifiedAs: unknown | path | evidence_ref | artifact_ref`, and `promoted=false`. `promotedEvidenceRefs` remains empty unless a current formal verifier receipt independently authorizes that exact ref. `legacyEstimatedPercent` is diagnostic-only and is never copied into canonical `progress.percent`.

`idempotencyKey` binds `reproId + sourceSchema + sourceDigest + migrationRevision`. The checkpoint is committed with each applied operation so a partial write resumes from the same source digest. A digest mismatch or non-empty invalid vNext record blocks migration and preserves the original bytes; it is not replaced with empty state. Replays may observe an already-applied operation but may not duplicate Evidence, AnswerEvents, unresolved items, Artifact pages, Tasks, or TaskRuns.

| Legacy fact | vNext treatment |
| --- | --- |
| `work-summary/v1 profile.model` / `profile.compute` | Map only recognized values to `modelScope` / `computeScope`; missing `full`, runtime, `etp`, or topology dimensions become typed unknowns and keep affected gates ineligible |
| `evidenceKind=formal|diagnostic` | Preserve as legacy evidence authority; do not infer `owning_entrypoint` or accepted `entrypoint` without a current invocation receipt and verifier |
| Existing gate percentage | Recompute from eligible frozen-Profile gates; if a required denominator cannot be reconstructed, keep the old number only as `legacyEstimatedPercent` diagnostic and set formal percent to `null` |
| Pending decision with typed `askRef` | Preserve navigation and pending status; do not synthesize an answered EvidenceRequest, direct-user provenance, or AnswerEvent |
| Existing `evidenceRefs` / `artifactRefs` | Retain values in their own namespace; classify a historical mixed field into separate arrays, with ambiguous values quarantined and no evidence promotion |
| Existing `reportArtifactRef` | Reuse the stable per-run Document Artifact binding; first vNext projection updates that Artifact rather than creating another page |
| Existing `spark-summary.json` | Parse only through its versioned structured adapter and re-derive canonical fields; never use its rendered Markdown sibling as migration input |
| Existing `outputs/report.md` | Stop live maintenance after the stable Artifact revision succeeds; retain only when the bench explicitly enables the compatibility export |
| Legacy active human wait | Reconcile through the shared human-request owner; do not reissue or convert it to async evidence unless correlation and lifecycle are complete |

Backfill is idempotent per Repro id, source schema, source digest, and migration revision. Restart after any partial write resumes from the durable checkpoint without duplicate Evidence, AnswerEvents, unresolved items, Artifact pages, Tasks, or TaskRuns. Migration reads structured records only. Markdown, A2UI, transcript prose, and historical percentage text are never inputs. A migration that cannot prove a field records the typed unknown/open item above; it never guesses.

## Delivery stack

The implementation is one GitChange with four dependent PR layers. Spark Tasks remain granular ownership/evidence units rather than PR topology.

1. **Contract** — this specification fixes the versioned lane/Profile/progress/ReportModel, formal verifier, namespace, and migration contracts. It does not claim that runtime enforcement or migration is available in this layer; executable schemas, adapters, and tests land in dependent layers. No daemon scheduling change.
2. **Async Evidence** — autonomous Ask guard, shared durable EvidenceRequest/AnswerEvent binding, hook reconciliation, direct-user provenance, restart/idempotency tests. No dual-frontier dispatch yet.
3. **Dual-lane Runtime** — ordered Normative retirement, Explore frontier, unresolved accounting, independent scheduling/recovery, Goal integration, and completion fence.
4. **Workbench & Rollout** — deterministic Artifact-first/A2UI/Hub/TUI projections, compatibility export, dogfood migrations, kill switch, browser/restart/E2E validation, and operator documentation.

A layer may merge only when its own fail-closed tests pass and all prior layers remain green. The unrelated Pi provider-auth compatibility change—GitHub PR **#225**, branch `fix/pi-role-auth-compat`—must not enter this stack.

## Recovery, stagnation, and rollout

Daemon restart reconstructs activity and idempotency from existing owners. No frontend timer reactivates work. Pending evidence requests survive restart and do not by themselves count as semantic stagnation.

A Repro settlement is unchanged only when both ready frontiers are empty, there is no candidate/AnswerEvent to reconcile, and the semantic fingerprint is unchanged. A pending request can coexist with dormant only when every remaining action depends on it.

Rollout uses explicit capabilities for dual-lane state, async EvidenceRequest, and ReportModel version. An old reader receives typed read-only/unknown projections; it must not downgrade async interaction to blocking, infer missing Profile fields, invent a percentage, or drop unresolved/request/Artifact bindings.

A kill switch stops admission of new autonomous ticks. It does not delete evidence, requests, unresolved items, or reports, and never changes completion.

## Dogfood acceptance scenarios

The GLM-5.2 dogfood workspace established the following required regression scenarios:

1. A historical hand-maintained `58%` without a gate denominator migrates to `unquantified`, not canonical progress.
2. Mixed path/`evidence:` values split into `evidencePaths` and `evidenceRefs` without promotion.
3. A stable Document Artifact replaces a hand-maintained `outputs/report.md`; validators remain presentation-independent.
4. A post-output RMSNorm replay may establish a derived reference boundary but cannot claim native fused-kernel internals.
5. A read-only numerical audit must not rewrite its comparison output.
6. Project Roles and Workflows resolve from one explicit project/worktree root; nested cwd/state roots cannot silently select unrelated `.agents` resources.
7. Concurrent successful `spark run --wait` invocations must retain exit code zero even if workspace-client release is stale or already released.
8. A new GitChange must freeze the requested remote trunk commit; a stale local trunk or unrelated open commit cannot enter the stack.
