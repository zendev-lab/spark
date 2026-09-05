# Frozen code-location and patch-verification experiment

This opt-in experiment measures whether a Spark-generated strategy improves a fixed
model's repairs of historical Spark regressions. It does not promote strategies into
production or claim recursive self-improvement.

The [completed GPT-6 run](results/gpt6-r1/RESULTS.md) found no reliable improvement:
the selected candidate passed 4/10 holdout trials against the baseline's 5/10.
Its full evidence dataset can be audited offline without model calls.

- `tasks.json` pins the production source commit, eight historical repair commits,
  regression mechanisms and the development/holdout assignment.
- `cases.json` owns the independent public and hidden acceptance cases. Correct
  source must pass every case; each injected regression must fail its task.
- `protocol.json` owns the model, budgets, repetitions, candidate limit, selection,
  stopping rule and uncertainty policy. Freeze it before any scored model call.
- `results/<run>/receipt.json` is a reviewed, machine-readable research receipt.
  `evidence.json.gz` and its hashed `trials/*.json.gz` shards are its explicitly exported source dataset: frozen manifests,
  provider/tool traces, Spark Evidence records, patches and raw grader observations.
  These curated reproducibility datasets are source artifacts; working snapshots,
  credentials and exploratory/local reports are excluded from export and Git.

The tasks replay the historical failure mechanisms in one pinned current source
snapshot. They are not exact historical checkouts. All eight defects coexist in each
solver snapshot so another task cannot reveal the correct held-out implementation.
The solver sees production files and its current prompt; only the trusted evaluator
sees the task manifest, historical repairs, tests and hidden expected values.

The observer adapters exercise production modules. Filesystem cleanup and SQLite
checks run with real temporary storage; Git/PR command responses use frozen fixtures.
This is module-level repair acceptance, not whole-service end-to-end acceptance.

The solver uses Spark's production agent loop, host, provider integration and Files
tools. The existing DSH test composition supplies real plugins, not a scripted model.
Independent observations run under macOS `sandbox-exec` with no network or access to
host/evaluator files. A boundary probe must pass before a run can be frozen.

See the [maintainer runbook](../../.agents/notes/runbooks/strategy-experiment.md) for
reproduction, credential setup, artifact audit and interpretation.
