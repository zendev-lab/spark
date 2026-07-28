# Scale Stage

Read this reference while the active stage is `scale`.

## Preconditions

- Do not scale around a failing smaller gate unless the frozen contract or a recorded user decision explicitly defines a different dependency order.
- Preserve each topology as a separate evidence profile. Single-GPU, EP, TP, PP, and CP results are not interchangeable.
- Freeze one axis at a time: steps, model size, sequence/batch shape, or parallel topology.

## Scale-Out Protocol

- Carry forward exact configs, source revisions, data/token manifests, checkpoint provenance, determinism controls, and accepted patches.
- Re-establish same-side determinism and checkpoint readback at each new profile.
- For distributed runs, record rank-local input/loss, collective groups and order, dispatch order, reduction dtype, optimizer sharding, and per-rank artifacts.
- Compare before/after collective boundaries so a distributed mismatch is localized to compute, dispatch, reduction, clip, optimizer, or checkpoint.

## Acceptance

- Run the target step count and convergence/performance checks required by the goal contract.
- Keep numerical and performance gates separate; a faster run does not excuse numerical drift.
- Cite the smaller accepted profile and the exact new variable. Record a new evidence receipt rather than replacing earlier profiles.
