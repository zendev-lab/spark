# Nightly capability continuous evaluation

Nightly capability continuous evaluation (CE) repeats Spark's deterministic
Goal, Loop, and Repro sentinels to detect intermittent failures, test-inventory
drift, and runtime variance that a single pull-request run cannot expose. It is
provider-token free and does not replace the binary sentinel contracts in
[`capability-sentinels.md`](./capability-sentinels.md).

The repeated lane runs in `.github/workflows/ce-behavior.yml`. Ordinary CI
already executes the selected sentinel tests once through the daemon suite on
every pull request; CE owns only repeated statistical sampling. The scheduled
and manual default is eight repetitions, daily at 18:37 UTC (03:37 JST). The
workflow shares one runner setup with scripted-provider CE, remains non-blocking,
and retains the combined behavior reports for 30 days.

## Run locally

```bash
pnpm run test:capability:ce
```

The default is eight independent processes. Override bounded settings with
environment variables:

```bash
SPARK_NIGHTLY_CE_RUNS=12 \
SPARK_NIGHTLY_CE_MAX_FAILURE_RATE=0 \
SPARK_NIGHTLY_CE_MAX_DURATION_P95_MS=30000 \
pnpm run test:capability:ce
```

The runner accepts equivalent `--runs`, `--output-dir`,
`--max-failure-rate`, `--max-duration-p95-ms`, and `--run-timeout-ms` options.
A custom output directory must be a non-root child of `reports/`; the runner
rejects paths that could overlap repository source.

## Pass semantics

The lane passes only when all of the following remain true:

- every expected repetition produces a report;
- every repetition exposes exactly the same case inventory;
- no repetition emits duplicate samples for one case;
- every case stays within the configured failure-rate budget (zero by default);
- every case stays within the configured p95 duration budget;
- each underlying sentinel still satisfies its public-surface, invocation, and
  zero-token hard budgets.

A case that passes seven runs and fails one is a failure, not an 87.5% success.
Missing samples and inventory drift are also failures rather than being removed
from the denominator. The reusable daemon agent-runtime behavior-CE aggregator
(`apps/spark-daemon/src/product/host/agent-runtime/behavior-ce.ts`) preserves those distinctions for future scripted-provider and live
canary evaluations.

## Reports

The default output directory is `reports/capability-ce/`:

| Path | Contents |
| --- | --- |
| `report.json` | Versioned configuration, run records, case summaries, budgets, and final result |
| `experiment.json` | Source and evaluator snapshots, fixed configuration, invalid runs, and original samples for version comparison |
| `summary.md` | Human-readable table also written to the GitHub Actions step summary |
| `raw/run-NN.json` | Original Vitest JSON reporter output |
| `raw/run-NN.meta.json` | Exit code, duration, assertion counts, timeout, and report paths |
| `raw/run-NN.log` | Captured stdout, stderr, and process-level failure context |

Reports are CI artifacts and must not be committed.

## Compare versions

Run CE in each version's clean checkout with the same settings, retaining both
`experiment.json` files. Both checkouts must contain the experiment recorder.
The source commit comes from local Git, including on developer machines; a CI
environment variable cannot replace the checkout identity.

```bash
pnpm run test:capability:compare -- \
  /path/to/baseline/experiment.json /path/to/candidate/experiment.json
```

The comparison emits JSON to stdout. Exit code zero means `unchanged` or
`improved`; `candidate_failed`, `regressed`, `incomparable`, and malformed
input exit nonzero. The output identifies both commits and the SHA-256 of each
parsed experiment serialized with `JSON.stringify`, so repeated evaluations of
the same commit remain distinguishable. Preserve both original artifacts.
Existing `report.json` files remain unchanged and cannot substitute for an
experiment artifact.

Comparability requires clean, unchanged before/after snapshots, matching
evaluator and dependency digests, Node/OS/CPU metadata, repetition count and
budgets, complete identical case inventories, and no invalid runs. The recorder
checks that every declared sentinel file exists and contributes assertions to
each run. Failed assertions are valid observations; process, timeout, reporter,
or missing-file failures invalidate comparison.

The evaluator fingerprint conservatively includes tracked tests, fixtures,
test-support and testing directories, scripts, JS/TS configuration files,
package manifests, TypeScript configurations, the workspace definition, Node
version file, and the behavior-CE aggregator. The dependency fingerprint covers
`pnpm-lock.yaml`. Changing these inputs requires a new baseline; even unrelated
test changes can invalidate an old comparison. Untracked source or edits during
the run keep ordinary diagnostic reports useful but make comparison
`incomparable`.

The comparator validates the artifact and recomputes summaries from samples.
It never trusts an imported success summary. A candidate must satisfy the fixed
CE budgets and must not introduce additional failures in any individual case.
`improved` means fewer observed failures with no per-case regression;
`unchanged` means equal failure counts. p95 durations are reported and remain
subject to the existing absolute budget, but faster timing alone does not earn
an improvement verdict.

These are diagnostic comparisons of deterministic sentinels, not statistical
proof of model capability, experiment isolation, or authorization to promote a
version. Snapshots are provenance records, not attestations: they do not capture
every environment variable, installed dependency byte, host load, or source
change that was reverted before the final snapshot. Keep the recorder and
original reports outside an untrusted candidate's write authority when using
them in a future autonomous search loop.

## Triage

Start with `summary.md`, then inspect the first failing case and its corresponding
raw run:

- a mixed pass/fail case is a flake or a hidden timing/state dependency;
- a missing case usually means a process failure, reporter failure, or changed
  test selection;
- an unexpected case means the shared sentinel inventory changed without the CE
  contract being reviewed;
- a duration-only failure requires separating host contention from a persistent
  regression before changing the budget;
- `@runner` failures identify process timeout, non-zero exit, missing reporter
  output, or an empty test run.

Do not raise failure-rate or duration limits merely to make the lane green.
First reduce nondeterminism, bound the operation, or split a genuinely different
cost class into its own CE lane.

## Deliberate boundary

This lane measures deterministic capability stability, not model intelligence
or live-provider compatibility. A secret-backed live canary should remain a
separate low-frequency lane with explicit model-call, tool-call, token, and wall
clock budgets. Its probabilistic samples may use the same CE aggregator, but
must not weaken these zero-token owner-boundary sentinels.
