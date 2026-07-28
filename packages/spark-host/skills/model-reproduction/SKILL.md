---
name: model-reproduction
description: Evidence-backed cross-framework model reproduction, numerical alignment, scaling, and delivery.
disable-model-invocation: true
---

# Model Reproduction

Use this core only inside an active Spark repro drive. It is loaded explicitly for the first daemon tick of a new `reproId`; do not reload it on later ticks unless the user asks.

## Authority

1. Workspace `AGENTS.md`, frozen manifests, task contracts, and recorded user decisions outrank this skill.
2. On conflict, keep the unchanged stricter applicable requirement, record the conflict, and ask when resolution changes scope, gates, or external state.
3. This skill supplies methodology. It never weakens acceptance criteria or proves a gate by itself.

## Entry Rules

- Inspect `repro status`, workspace instructions, the frozen goal contract, the current plan revision, existing evidence, and the last accepted frontier before acting.
- Verify a runnable competitor/reference baseline before a baseline probe. If it is absent, ask how to construct it; never invent a toy substitute.
- Preserve real model code, official weights, declared device/dtype, independent framework execution, native entrypoints, and immutable source provenance when the contract requires them.
- Change one experiment variable at a time. Put diagnostics outside production paths and prove hooks are non-interfering before relying on them.
- Do not repeat accepted work without contradictory evidence. Continue from the last accepted frontier.

## Progressive References

Resolve paths relative to this `SKILL.md` and read only what the current work needs:

- `references/setup.md`: baseline, environment, data, and goal-contract work.
- `references/scaffold.md`: repository ownership, native entrypoints, and buildable structure.
- `references/reproduce.md`: forward/backward/optimizer alignment and formal validation.
- `references/scale.md`: step, model, and parallel scale-out after smaller gates pass.
- `references/deliver.md`: production migration, patch ablation, reports, and PR evidence.
- `references/localization.md`: first-divergence localization and falsifiable attribution.
- `references/observability.md`: dump contracts, projections, coverage, and reporting.
- `references/speedup.md`: offline replay and minimal failing cases.
- `references/lessons.md`: anti-patterns, environment traps, and deletion claims.
- `references/known-diffs/catalog.md`: normalized Megatron/Fleet Diff candidates.
- `references/known-diffs/source-notes.md`: preserved source excerpts behind the catalog.
- `references/provenance.md`: snapshot origins, revisions, and hashes.

## Known Diff Procedure

Before revising a repro plan, defining an experiment protocol, attributing a mismatch, or recording numerical evidence:

1. Search `references/known-diffs/catalog.md` by stage, boundary, operator, symptom, model feature, and framework.
2. Read every plausible entry and its linked source note. Treat entries as prior candidates, never universal facts.
3. Cite applicable stable IDs in the plan/protocol/evidence/report as `known_diff_ids`. If none match, cite `KNOWN-DIFF-NONE` and record the search terms.
4. Revalidate the candidate on the current model, profile, shape, layout/stride, dtype, versions, and real graph. A catalog status does not satisfy a repro requirement.
5. Preserve rejected and superseded outcomes; do not recycle a rejected candidate without new contradictory evidence.

## Evidence Discipline

- Locate mismatches as `first_bad_step`, `first_bad_layer`, and `suspected_boundary`; also retain the last exact boundary.
- State the observation projection for every claim: input, loss, named tensor, optimizer stage, checkpoint, or full trace.
- Bind claims to commands, run/profile IDs, immutable hashes, result paths, and canonical `evidence:` refs.
- A probe is diagnostic. Advance a gate only with the formal native entrypoint and the contract's required repetitions, steps, artifacts, and numerical threshold.
- Keep implementation patches default-off when required, scoped to the owning repository, shape-independent, and validated on at least two representative real shapes/layouts before generalizing.

## Stop Conditions

Stop and ask instead of guessing when a baseline is missing, an immutable input would need mutation, a gate or source-of-truth conflict is material, an external/destructive action lacks authority, or three settlements make no semantic progress. Before ending a daemon repro tick, call `repro settle` exactly as the repro tool contract requires.
