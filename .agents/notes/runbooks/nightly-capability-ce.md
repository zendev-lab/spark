# Nightly capability continuous evaluation

Nightly capability continuous evaluation (CE) repeats Spark's deterministic
Goal, Loop, and Repro sentinels to detect intermittent failures, test-inventory
drift, and runtime variance that a single pull-request run cannot expose. It is
provider-token free and does not replace the binary sentinel contracts in
[`capability-sentinels.md`](./capability-sentinels.md).

The repeated lane runs in `.github/workflows/ce-behavior.yml` as the
`capability-ce` job. Ordinary CI already executes the selected sentinel tests
once through the daemon suite on every pull request; CE owns only repeated
statistical sampling. The scheduled and manual default is eight repetitions,
daily at 18:37 UTC (03:37 JST). The job remains non-blocking and retains
capability reports for 30 days.

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
from the denominator. The reusable spark-turn behavior-CE
aggregator (`packages/spark-turn/src/behavior-ce.ts`) preserves those distinctions for future scripted-provider and live
canary evaluations.

## Reports

The default output directory is `reports/capability-ce/`:

| Path | Contents |
| --- | --- |
| `report.json` | Versioned configuration, run records, case summaries, budgets, and final result |
| `summary.md` | Human-readable table also written to the GitHub Actions step summary |
| `raw/run-NN.json` | Original Vitest JSON reporter output |
| `raw/run-NN.meta.json` | Exit code, duration, assertion counts, timeout, and report paths |
| `raw/run-NN.log` | Captured stdout, stderr, and process-level failure context |

Reports are CI artifacts and must not be committed.

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
