# Reproduction Lessons and Anti-Patterns

Read this before claiming alignment/root cause/patch deletion, when a fix is shape-specific, or when environment artifacts are suspect.

## Environment Is Input

- System Python is mutable platform state, not a reproducible experiment input.
- Package name/version does not prove wheel ABI. Record loaded modules/shared objects and wheel tags, then run dependency checks and GPU smoke tests.
- Recheck the environment after every package change; shared dependency upgrades can silently alter other paths.

## Mechanisms, Not Samples

- Match semantic operation and call signature: shape, transpose, layout, stride/contiguity, dtype, accumulation order, and kernel family.
- A fix that switches implementation by observed sample shape is overfitting, not a mechanism. Validate the same mechanism on at least two representative real shapes/layouts.
- Preserve non-contiguous real-graph carriers in minimal repros.

## Claims, Not Narratives

- Logged loss aggregation may differ from the contract's rank-local or token-weighted scalar. Compare the declared semantic quantity.
- Use `confirmed`, `rejected`, or `inconclusive`. Never turn a smaller diff into `fixed`.
- State the observation projection and evidence path. A local exact operator cannot prove full training exact.
- Mark displaced conclusions `superseded`; do not silently delete history.

## Configuration Traps

- Parse environment booleans semantically; nonempty strings such as `"false"` are truthy in many languages.
- Thread compatibility flags through every derived branch and declare config fields explicitly.
- Do not mutate shared config during forward execution.
- Test the tensor that the live branch actually consumes, not an unused parent field.
