Spark repro drive tick — Stage 2/5: Scaffold (scaffold), phase=implement.
Goal Contract (draft): Reproduce the target behavior with inspectable evidence
Plan revision: 1. Difficulty: 8/10; 16/11 minimum steps. Stop Guard: 0/3 unchanged settlements.

Milestone-driven reproduction workflow. Stages are linear (setup → scaffold → reproduce → scale → deliver); execute one typed plan step per tick.

Current typed plan steps:
  [ ] [safe_local] project-structure-created — Project structure created; done when: Project structure created; evidence: At least one inspectable evidence ref
  [ ] [safe_local] dependencies-buildable — Dependencies installed and buildable; done when: Dependencies installed and buildable; evidence: Passing command result captured as evidence

Current evidence-backed requirements:
  [ ] [evidence] project-structure-created — Project structure created
  [ ] [validation] dependencies-buildable — Dependencies installed and buildable

Next: research "Project structure created", store the findings as evidence, then call repro({ action: "record", requirementId: "project-structure-created", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }).

Repro drive requirements:
- Operate in the selected phase (implement); use its tool policy for plan or implement work.
- Prefer the main session for scheduling and every concrete step. Do not default to role({ action: "call" }), session({ action: "call"|"send" }), assign, or workflow_run during repro ticks; use those only when the user explicitly requests multi-agent/workflow fan-out.
- When blocked by a missing user decision, ambiguous requirement, unclear baseline/source, conflicting evidence, failing validation whose next step is unclear, or any problem the user can unblock, call ask immediately with a concrete question. Do not guess, invent substitutes, or end the turn with only a prose blocker report when ask can resolve it.
- Advance milestones with repro record/evaluate/advance. Never treat prose, an unverified ref, or a bare boolean as proof.
- Keep the deliverable report a live dashboard, not an append-only log: current status and one blocker card first, quantified gates next, long history behind progressive disclosure. Fold or rewrite stale sections instead of only appending, so low-signal detail cannot crowd out the current frontier.
- Treat a local commit as incomplete delivery. When a stage lands, push the branch and create or update its PR in the same turn, then record that PR state in the report. Do not batch PR work until the end.
- Before ending every repro turn, leave a verifiable checkpoint. If the turn produced a coherent set of repository changes and committing is authorized and safe, create a small git commit promptly. Never include unrelated pre-existing changes.
- If a safe commit is not appropriate yet, show the work completed in the turn: cite concrete evidence refs or file paths, summarize the relevant diff, report commands/tests and their results, or ask about the exact blocker. Do not end with only a progress claim.
- If blocked on an external dependency the user cannot resolve, report that blocker; otherwise prefer ask over /repro stop.
- Before ending this daemon-owned tick, call repro({ action: "settle", reason: "..." }). The driver is dormant by default; only settle may schedule the next tick.
- If settle returns Recover Ask, call canonical ask immediately with one concrete unblock question. Do not schedule around the Ask gate.

Implement-phase guidance:
- Execute the planned tasks in the main session: write code, run tests, and fix failures.
- If a failure, missing credential, unclear expected behavior, or ambiguous fix path needs a user decision, call ask before inventing a workaround.
- Record the matching evidence-backed requirement proof before advancing.
