# First-Divergence Incident

Read this reference after a formal comparison first reports a mismatch.

## Incident Contract

Freeze the failing parent run, source/config/input hashes, comparison projection,
and last accepted evidence. Give the incident a stable id. Do not edit the
failing evidence or silently rerun with a different environment.

Create evidence in this order:

1. Find `first_bad_step` from per-step hashes.
2. Replay only that step from the last accepted checkpoint.
3. Find `first_bad_layer` and the last exact layer.
4. Classify the suspected compute, dispatch, collective, clip, optimizer, or
   checkpoint boundary.
5. Fan out falsifiable hypotheses only when they can use isolated results.
6. Confirm one mechanism with a single-variable control.

Parallel hypotheses are discovery evidence, not a verdict. Require an
independent mechanism review before creating a fixer Task. Preserve rejected and
inconclusive hypotheses so they are not recycled without new contradictory
evidence.

## Stop Rule

If the same boundary and hypotheses produce no new evidence across the bounded
attempt policy, report a concrete blocker. Do not broaden dumps, patch multiple
variables, or move to a larger profile merely to create activity.
