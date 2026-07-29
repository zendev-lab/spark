Spark repro drive tick — Stage 1/5: Setup (setup), phase=plan.
Goal Contract (draft): Reproduce the target behavior with inspectable evidence
Plan revision: 1. Difficulty: 8/10; 8 materialized subgoals. Stop Guard: 0/3 unchanged settlements.

Milestone-driven reproduction workflow. Stages are linear (setup → scaffold → reproduce → scale → deliver) and each stage is advanced through explicit orchestration.

Orchestration loop:
- Inspect the materialized Stage blueprint and revise it only when evidence changes the contract.
- Compute the dependency-ready safe_local task frontier.
- Use assign to dispatch independent ready tasks in parallel.
- Never dispatch ask_decision or ask_approval authority tasks; they remain owner-only.
- Reconcile child run and task status, then validate evidence and receipts before the owner settles.

Current typed plan steps:
  [ ] [safe_local] repro-contract-frozen — Reproduction claim and acceptance contract frozen; done when: Reproduction claim and acceptance contract frozen; evidence: At least one inspectable evidence ref
  [ ] [safe_local] competitor-baseline-availability-researched — Runnable competitor/reference baseline availability verified (typically Megatron); done when: Runnable competitor/reference baseline availability verified (typically Megatron); evidence: At least one inspectable evidence ref
  [ ] [ask_decision] baseline-construction-strategy-approved — Reuse existing baseline or construction approach approved by the user; done when: Reuse existing baseline or construction approach approved by the user; evidence: Canonical ask decision evidence with the selected value
  [ ] [safe_local] implementation-landscape-researched — Reusable implementation and extension boundaries researched; done when: Reusable implementation and extension boundaries researched; evidence: At least one inspectable evidence ref
  [ ] [safe_local] alignment-paths-researched — Real-module and eager alignment paths compared; done when: Real-module and eager alignment paths compared; evidence: At least one inspectable evidence ref
  [ ] [ask_decision] implementation-strategy-approved — Reuse, adapt, or new implementation strategy approved by the user; done when: Reuse, adapt, or new implementation strategy approved by the user; evidence: Canonical ask decision evidence with the selected value
  [ ] [ask_decision] alignment-strategy-approved — Real-module or eager alignment strategy approved by the user; done when: Real-module or eager alignment strategy approved by the user; evidence: Canonical ask decision evidence with the selected value
  [ ] [safe_local] baseline-probe-passed — Minimum baseline comparison probe passed against an available or user-approved constructed baseline; done when: Minimum baseline comparison probe passed against an available or user-approved constructed baseline; evidence: Passing command result captured as evidence

Current evidence-backed requirements:
  [ ] [evidence] repro-contract-frozen — Reproduction claim and acceptance contract frozen
  [ ] [evidence] competitor-baseline-availability-researched — Runnable competitor/reference baseline availability verified (typically Megatron)
  [ ] [decision] baseline-construction-strategy-approved — Reuse existing baseline or construction approach approved by the user
  [ ] [evidence] implementation-landscape-researched — Reusable implementation and extension boundaries researched
  [ ] [evidence] alignment-paths-researched — Real-module and eager alignment paths compared
  [ ] [decision] implementation-strategy-approved — Reuse, adapt, or new implementation strategy approved by the user
  [ ] [decision] alignment-strategy-approved — Real-module or eager alignment strategy approved by the user
  [ ] [validation] baseline-probe-passed — Minimum baseline comparison probe passed against an available or user-approved constructed baseline

Next: make the Goal Contract concrete. Use repro({ action: "plan", reason: "...", goalContract: { objective: "...", constraints: ["..."], nonGoals: ["..."], successCriteria: ["..."], evidenceRequired: ["..."] } }), store the reviewed contract as evidence, then call repro({ action: "record", requirementId: "repro-contract-frozen", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }). Any later Goal Contract change reopens this requirement.

Repro drive requirements:
- Operate in the selected phase (plan); use its tool policy for plan or implement work.
- Prefer the main session for scheduling and every concrete step. Do not default to role({ action: "call" }), session({ action: "call"|"send" }), assign, or workflow_run during repro ticks; use those only when the user explicitly requests multi-agent/workflow fan-out.
- When blocked by a missing user decision, ambiguous requirement, unclear baseline/source, conflicting evidence, failing validation whose next step is unclear, or any problem the user can unblock, call ask immediately with a concrete question. Do not guess, invent substitutes, or end the turn with only a prose blocker report when ask can resolve it.
- Advance milestones with repro record/evaluate/advance. Never treat prose, an unverified ref, or a bare boolean as proof.
- Before ending every repro turn, leave a verifiable checkpoint. If the turn produced a coherent set of repository changes and committing is authorized and safe, create a small git commit promptly. Never include unrelated pre-existing changes.
- If a safe commit is not appropriate yet, show the work completed in the turn: cite concrete evidence refs or file paths, summarize the relevant diff, report commands/tests and their results, or ask about the exact blocker. Do not end with only a progress claim.
- If blocked on an external dependency the user cannot resolve, report that blocker; otherwise prefer ask over /repro stop.
- Before ending this daemon-owned tick, call repro({ action: "settle", reason: "..." }). The driver is dormant by default; only settle may schedule the next tick.
- If settle returns Recover Ask, call canonical ask immediately with one concrete unblock question. Do not schedule around the Ask gate.

Plan-phase research-first guidance:
- Each Stage entrance materializes its detailed Roadmap and Subgoal/Task DAG automatically. Use repro action=plan only for evidence-backed revisions or dynamic incidents, not to recreate the Stage skeleton.
- Reassess difficulty when scope or uncertainty changes, and split dynamic incident work by experiment risk, dependencies, and required evidence rather than a numeric quota.
- Classify each unknown as fact, reversible choice, material user decision, or validation uncertainty.
- Research facts from the workspace, dependencies, environment, and primary upstream sources before asking the user.
- Prioritize whether a runnable competitor/reference baseline already exists (typically a Megatron implementation). Prove availability with concrete paths, entrypoints, or failed-lookup evidence; do not assume a paper or announcement means the baseline is runnable.
- If that baseline is missing (for example a model whose Megatron path is not landed yet), ask the user how to construct or obtain it before any baseline probe. Do not invent a substitute baseline.
- For implementation strategy, find the owning module and compare reuse, adaptation, and new implementation with concrete code-path evidence.
- For alignment strategy, inspect the real module path first and compare it with an eager probe. Treat eager as a focused diagnostic unless the evidence or user-approved target makes it the intended path.
- Run a focused probe for validation uncertainty only after baseline availability or construction strategy is settled; record the command and result evidence.
- Use a recommended default for reversible low-risk choices and record it in the research evidence.
- Ask exactly one material user decision at a time with canonical ask and recordAsEvidence=true; do not use reviewer auto-answer for that decision.
- Keep research and decision-making in the main session; do not spawn anonymous role calls for ordinary setup research.
