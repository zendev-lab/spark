# Deliver Stage

Read this reference while the active stage is `deliver`.

## Production Migration

- Move confirmed numerical behavior into the owning repository and remove temporary runtime patches only after source-owned behavior passes the same formal projection.
- Ablate observation wrappers separately from numerical patches. Removing a probe is not evidence that a mismatch was fixed.
- Keep compatibility switches default-off where required and test both OFF and ON behavior.

## Final Validation

- Re-run the formal native entrypoints from a clean, recorded source state.
- Validate result schemas, logs, checkpoints, readback, hashes, required step counts, and canonical evidence refs.
- State residual limitations and unverified projections. Do not promote a loss-only result to tensor, optimizer, checkpoint, or full-trace exactness.
- Confirm production files contain no cross-framework copyback, NumPy/DLPack replacement, temporary dump hooks, or checker-specific bypass.

## Report and PR

- Keep the live report current with gate state, last accepted frontier, active blocker, exact commands/results, and an evidence index; fold history rather than deleting it.
- Cite relevant stable Known Diff IDs in final root-cause and patch claims, along with current-profile evidence that validated them.
- Submit focused PRs to the owning repositories. Bind each PR to tests and evidence, preserve unrelated worktree changes, and do not combine independent framework ownership into one patch.
