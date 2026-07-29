Spark repro drive tick — Stage 5/5: Deliver (deliver), phase=implement.
Goal Contract (draft): Reproduce the target behavior with inspectable evidence
Plan revision: 1. Difficulty: 8/10; 8 materialized subgoals. Stop Guard: 0/3 unchanged settlements.

Milestone-driven reproduction workflow. Stages are linear (setup → scaffold → reproduce → scale → deliver) and each stage is advanced through explicit orchestration.

Orchestration loop:
- Plan stage-scoped subgoals and concrete task plans.
- Compute the dependency-ready safe_local task frontier.
- Use assign to dispatch independent ready tasks in parallel.
- Never dispatch ask_decision or ask_approval authority tasks; they remain owner-only.
- Reconcile child run and task status, then validate evidence and receipts before the owner settles.

Current typed plan steps:

Current evidence-backed requirements:
  [ ] [evidence] pr-submitted — PR submitted
  [ ] [validation] no-runtime-patches — No runtime patches remain

Next: research "PR submitted", store the findings as evidence, then call repro({ action: "record", requirementId: "pr-submitted", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }).

Stage gate (gate-C): PR submitted, no runtime patch — evaluation is derived from recorded proof and cannot be force-passed.

Repro drive requirements:
- Operate in the selected phase (implement); use its tool policy for plan or implement work.
- The main session owns planning and reconciliation; use assign only for the independent safe_local ready frontier, while ask_decision and ask_approval remain owner-only.
- When blocked by a missing user decision, ambiguous requirement, unclear baseline/source, conflicting evidence, failing validation whose next step is unclear, or any problem the user can unblock, call ask immediately with a concrete question. Do not guess, invent substitutes, or end the turn with only a prose blocker report when ask can resolve it.
- Advance milestones with repro record/evaluate/advance. Never treat prose, an unverified ref, or a bare boolean as proof.
- Before ending every repro turn, leave a verifiable checkpoint. If the turn produced a coherent set of repository changes and committing is authorized and safe, create a small git commit promptly. Never include unrelated pre-existing changes.
- If a safe commit is not appropriate yet, show the work completed in the turn: cite concrete evidence refs or file paths, summarize the relevant diff, report commands/tests and their results, or ask about the exact blocker. Do not end with only a progress claim.
- If blocked on an external dependency the user cannot resolve, report that blocker; otherwise prefer ask over /repro stop.
- Before ending this daemon-owned tick, call repro({ action: "settle", reason: "..." }). The driver is dormant by default; only settle may schedule the next tick.
- If settle returns Recover Ask, call canonical ask immediately with one concrete unblock question. Do not schedule around the Ask gate.

Implement-phase guidance:
- Execute the planned tasks in the main session: write code, run tests, and fix failures.
- If a failure, missing credential, unclear expected behavior, or ambiguous fix path needs a user decision, call ask before inventing a workaround.
- Record the matching evidence-backed requirement proof before advancing.
