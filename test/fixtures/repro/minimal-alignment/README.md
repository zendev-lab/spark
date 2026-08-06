# Minimal alignment fixture

This fixture is the deterministic first task for the Repro Golden Journey.

Run the immutable reference:

```bash
node verify.mjs reference
```

It must pass all vectors.

Run the intentionally divergent target:

```bash
node verify.mjs target
```

It must fail before repair. The localized defect is the denominator in
`target/normalize.mjs`: the target uses `variance + epsilon`, while the reference
uses `sqrt(variance + epsilon)`.

A valid repair changes the target implementation and makes the same verifier pass
without modifying `test-vectors.json`, `verify.mjs`, or the reference implementation.
The future process-level journey will perform that repair in a managed
`git_change` worktree, record the before/after commands as Evidence, and deliver a
Draft PR plus Repro report.
