# spark-repro

`@zendev-lab/spark-repro` owns the host-neutral v4 reproduction protocol. Hosts
provide persistence, evidence lookup, canonical user interaction, scheduling,
and rendering.

The protocol keeps the fixed `setup → scaffold → reproduce → scale → deliver`
evidence gates and adds four durable structures:

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
or become `done` without evidence. Decision and approval step evidence is
additionally verified by the host as canonical Ask evidence.

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

The setup stage first verifies whether a runnable competitor/reference baseline
already exists (typically a Megatron implementation). Missing baselines are a
blocking user decision: ask how to construct or obtain them before any baseline
probe, and do not invent a substitute. It then researches reuse/adapt/new
implementation options and real-module/eager alignment paths before recording
the corresponding user decisions. Eager execution is a diagnostic path by
default, not silent evidence that the real module path is aligned.
