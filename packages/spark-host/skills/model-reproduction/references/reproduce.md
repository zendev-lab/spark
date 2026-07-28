# Reproduce Stage

Read this reference while the active stage is `reproduce`.

## Evidence Ladder

Advance claims independently through:

1. input/token contract;
2. initial parameters and checkpoint inventory;
3. forward boundaries and loss inputs;
4. backward named gradients;
5. grad reduce and clipping;
6. optimizer state/update and model copyback;
7. checkpoint save/readback;
8. multi-step loss and tensor progression.

A pass at one level does not imply the next.

## Alignment Workflow

- Establish same-side determinism before cross-framework comparison.
- Start from the last accepted frontier. Locate the first divergence on the real graph and record last-good plus first-bad boundaries.
- Use `references/localization.md` for bisection and attribution. Consult and cite `references/known-diffs/catalog.md` before choosing a candidate mechanism.
- Use controlled A/B experiments with one variable, frozen inputs/environment, explicit expected outcomes, and a predeclared stop condition.
- Keep diagnostic and formal runs separate. After a mechanism is confirmed and implemented in the owner, rerun the nearest gate from the formal native entrypoint.

## Numerical Claims

- Bit-exact means raw equality under the declared representation; tolerance, rounded logs, or a lower loss do not satisfy it.
- Compare semantically paired tensors, accounting for explicit and audited layout/shard transforms. Never flatten unrelated partitions into an apparent match.
- Report tensor counts and element counts together, with real denominators, `max_abs_diff`, ULP when useful, signed-zero count, and first mismatch.
- Repetitions, hooks, configs, commands, hashes, and result inventories must be symmetric across frameworks.

## Patch Acceptance

A candidate patch needs OFF failures, ON passes, non-interference guards, representative real shapes/layouts, focused owner tests, and a formal regression. Record whether the result is `confirmed`, `rejected`, or `inconclusive`; only confirmed formal evidence can move a gate.
