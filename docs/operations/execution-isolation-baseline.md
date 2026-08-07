# Execution isolation baseline

This source-process baseline measures the current single-daemon execution fault domain before an
execution-attempt process boundary is introduced. It is a diagnostic contract, not a claim that the
daemon already isolates invocations or cleans up descendant processes.

## Run

Run the schema-validated process contract from the repository root:

```bash
pnpm exec vp test run --config vitest.process.config.ts \
  test/process/execution-isolation-baseline.test.ts
```

To inspect the complete versioned JSON report directly:

```bash
pnpm exec tsx apps/spark-daemon/scripts/execution-isolation-baseline.mts
```

The runner uses only temporary SQLite databases, attachment directories, fixture providers/tools,
and local child processes. It does not read the real daemon database, credentials, `.spark/` state,
or remote services. Reports are intentionally not committed because timestamps, RSS, PIDs, and
latency vary by machine. RSS is a whole-source-process observation across sequential fixtures, not
an isolated per-fixture allocation or leak measurement. The schema is
[`test/process/execution-isolation-baseline.schema.json`](../../test/process/execution-isolation-baseline.schema.json).

## Fixtures and interpretation

All scheduler fixtures use concurrency `2`; the control probe samples the process every `100ms`.
The report records OS, Node version, commit, invocation timeouts, fixture parameters, probe gaps,
invocation timestamps, RSS, and child PID lifecycle.

| Fixture | Classification | Contract |
| --- | --- | --- |
| Idle | `control` | Establishes normal probe jitter without an invocation. |
| Five-second synchronous CPU | `event-loop-blocked` | Produces a probe gap of at least `4000ms`; another session cannot finish before the CPU fixture releases. |
| Unresolved async provider | `async-wait` | Keeps all probe gaps below `250ms`; another session finishes before provider release. |
| Abort-ignoring async tool | `session-fence-occupancy` | Timeout makes the terminal row visible, but the same-session successor stays queued until the real executor settles. |
| 12 MiB attachment materialization | `sync-io` | Exercises the current synchronous base64 decode and file writes and records the resulting gap/RSS without imposing a machine-specific latency threshold. |
| Hung external child | `external-child-lifecycle` | Shows that scheduler timeout does not settle the executor or descendant; the fixture records PID and TERM/KILL timing. |

The hung-child fixture deliberately labels cleanup as `test-harness` and
`productionCleanupObserved: false`. Its PID cleanup only prevents a test leak; it must never be cited
as existing daemon process-group ownership. A future execution-attempt implementation should replace
that negative baseline with daemon-owned cooperative cancellation, `SIGTERM`, bounded grace, and
`SIGKILL`, while retaining generation and PID-start fencing.

## Threshold meaning

The `4000ms` CPU threshold is intentionally broad enough for a five-second busy loop while still
proving whole-event-loop starvation. The `250ms` async threshold allows ordinary host jitter around a
`100ms` probe without confusing pending Promise capacity occupancy with event-loop blocking.
Attachment I/O is observational because filesystem and base64 performance are hardware-dependent.

Failures should be interpreted by classification before changing thresholds. Do not weaken a bound
to hide a regression, and do not report test-harness child cleanup as production behavior.
