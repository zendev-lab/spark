# First-Divergence Localization

Read this when loss or tensors differ and the next action is localization or attribution.

## Locate

Treat training as two ordered chains:

```text
data -> embedding -> layers -> loss -> backward -> grad_reduce -> clip -> optimizer -> checkpoint
step 0 -> step 1 -> ... -> step N
```

1. Prove the endpoints: identical declared input/initial state, and a reproducible differing output.
2. Prove same-side determinism. If a side is unstable, fix that before cross-framework attribution.
3. Bisect dimensions independently: first bad step, then layer, then boundary. Do not build a step/layer/boundary Cartesian dump.
4. Use a binary criterion for bit-exact work: raw hash equality or `max_diff == 0`.
5. Probe the real graph. Record shape, dtype, layout, stride, contiguity, scale, mask, rank, and source revision.

## Attribute

For every root-cause candidate, write:

```text
Hypothesis:
Expected if true:
Evidence command/run/result:
Observed:
Verdict: confirmed | rejected | inconclusive
Next:
known_diff_ids:
```

Consult the Known Diff catalog before choosing the candidate. Run one-variable controlled replacements and freeze RNG, parallel groups, thread/affinity settings, environment flags, library/compiler versions, and input/weight hashes.

## Repair

Choose the least invasive reliable owner-level action among environment/config, launch hook, runtime patch, source fix, or fork. Prefer a small auditable source fix over a brittle runtime patch when it reduces rollback and validation risk. Record rollback before any nontrivial change.
