# Faster Reproduction Loops

Read this when a training rerun is too expensive for each hypothesis.

## Offline Boundary Replay

1. Dump all inputs immediately before an already exact boundary on both sides.
2. Preserve real dtype, shape, layout, stride/contiguity, scale, mask, RNG state, and environment.
3. Write a minimal script that imports only the suspect operator and replays the real tensors.
4. Iterate on one hypothesis in seconds, then confirm the mechanism on the real graph and formal entrypoint.

If upstream tensors already differ, the replay cannot attribute the current operator.

## Minimal Failing Case

Reduce in cost order while preserving the failure:

1. batch, sequence, steps, ranks, and layers;
2. unrelated blocks, leaving the relevant attention/MLP/expert path;
3. data variability, only if the failure remains representative;
4. stochasticity, clip, and optimizer accumulation.

When a reduction removes the failure, restore the last removed dimension. A random contiguous toy is not representative of a known non-contiguous real-graph failure.

## Iteration Discipline

- Prefer a flag/config A/B before adding dumps.
- Reuse accepted prefix checkpoints only when checkpoint provenance and readback are validated.
- Parallelize only orthogonal experiments that do not share mutable worktrees, ports, GPUs, or environment state.
- Validate small before large, but never use the small result to satisfy a larger formal gate.
