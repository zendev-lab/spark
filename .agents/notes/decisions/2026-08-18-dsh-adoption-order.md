# 2026-08-18: DSH adoption order

## Decision

Adopt DeepSeek Harness (DSH) progressively. Do not swap the Spark kernel.

Priority ≈ (product + architecture + unlock + maintenance) / (migration cost +
coupling risk). Every DSH change must declare:

1. **Delete** — Spark plumbing removed
2. **Gain** — capabilities available immediately
3. **Unlock** — later work that becomes cheaper

Reject a change that only makes Spark look more like DSH.

Recommended mainline: `LLM → SystemPrompt + Tools → Context/Scope → Skill →
Agent`. Compaction waits on Session/Agent. Jobs and Subagent are capability
gains; they do not replace daemon Fleet or delegation.

Hard constraints:

- `dsh-scope` is required before `ctx.tools.restrict()` / `presentAs()`.
- Spark owns approval with `tools/pre-execute` returning allow/deny. Do not
  adopt `dsh-user-approval` for Phase 2; it needs an open DSH agent turn and
  session audit log.
- Do not take over `dsh-session`. SessionStore / sessionProjections stay a
  Phase 4 gate. Agent-loop, compaction, jobs, and subagent wait on that gate.
  **Superseded for persistence by
  [`2026-08-20-dsh-session-persistence.md`](./2026-08-20-dsh-session-persistence.md)**
  and **for Cordis composition / `dsh-agent-loop` by
  [`2026-08-20-dsh-cordis-composition.md`](./2026-08-20-dsh-cordis-composition.md).**
  Session projections remain Spark-owned until a later decision. Compaction,
  jobs, and subagent still wait on later owner decisions.
- `dsh-jobs` / `dsh-subagent` are in-process and do not replace daemon durable
  Fleet.

Phase 2 lands as runtime composition, register bridge, prompt assembly,
`ctx.tools.execute`, `ctx.tools.guard()` for driver-target binding, then
native `spark-files` / `spark-tool-web` plugins. Composition-only spikes are not
standalone product PRs.

## Rationale

Phase 1 already isolated Pi compatibility and mounted `dsh-llm` on a
process-local Cordis island. The remaining cost is Spark-owned tool dispatch,
prompt assembly, and host registry. Adopting those seams first deletes the
largest duplicate plumbing and unlocks later scope/skill work. Taking
agent-loop or session persistence earlier would couple Spark's daemon Session
to DSH before the delete/gain ratio is measurable.

## Consequences

Driver-authority consent is independent of DSH and lands first. Later DSH PRs
must keep Spark policy, reconcile, and daemon ownership. Package budget,
layer direction, and owner APIs remain the merge gate, not DSH API coverage.
