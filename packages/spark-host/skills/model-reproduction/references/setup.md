# Setup Stage

Read this reference while the active stage is `setup`.

## Freeze the Claim

- Translate the task into one falsifiable claim with explicit device, dtype, model/weight revision, data/token contract, framework paths, step counts, equality rule, artifacts, and non-goals.
- Separate implementation viability, approximate numerical acceptance, bit-exact alignment, scale, and delivery. Do not let an early observation satisfy a later claim.
- Record every user decision through canonical Ask evidence when the repro state requires a decision proof.

## Establish the Baseline

- First verify whether the declared competitor/reference implementation is runnable. Record repository revision, native CLI, environment, weights, and a minimal real probe.
- If no runnable baseline exists, stop and ask for a construction strategy. A toy model, eager rewrite, alternate weight, or host-side replay is not an implicit substitute.
- Keep reference and target execution independent. Cross-framework tensor transfer is diagnostic only and cannot feed a formal training path.

## Freeze Inputs and Environment

- Use run-local environments with explicit interpreters and loaded native-library paths. Record Python, framework, CUDA, cuDNN/NCCL, compiler, wheel tags, GPU, and determinism flags.
- Run dependency checks and a minimal GPU smoke test on both sides before numerical experiments.
- Preserve immutable source datasets. Derived token/native artifacts must be writable, content-addressed, and linked to source and tokenizer provenance.
- Make both frameworks independently load the same official tokenizer revision and emit native derivatives plus a shared manifest containing schema, dtype, shape, hashes, and provenance.

## Setup Evidence

A baseline probe receipt must identify the real module path, official weights, native command, exit status, finite output, and produced artifacts. It does not prove multi-step or bit-exact acceptance unless the frozen contract says so.
