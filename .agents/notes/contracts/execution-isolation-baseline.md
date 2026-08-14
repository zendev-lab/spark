# Execution isolation baseline

This source-process baseline measures the current single-daemon execution fault domain before an
execution-attempt process boundary is introduced. It is a diagnostic contract, not a claim that the
daemon already isolates invocations or cleans up descendant processes. The normative replaceable
attempt identity, fencing, crash, capability, and worker-import rules are in
[`execution-attempts.md`](./execution-attempts.md).

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
[`test/process/execution-isolation-baseline.schema.json`](../../../test/process/execution-isolation-baseline.schema.json).

## Fixtures and interpretation

All scheduler fixtures use concurrency `2`; the control probe samples the process every `100ms`.
The report records OS, Node version, commit, invocation timeouts, fixture parameters, max and p95
probe gaps, invocation timestamps, RSS, per-fixture `liveChildPidCount`, and child PID lifecycle. All
timestamps are Unix milliseconds, durations are milliseconds, and memory is bytes; those units are
schema constants rather than prose conventions.

| Fixture | Classification | Contract |
| --- | --- | --- |
| Idle | `control` | Records normal probe jitter without turning runner latency into a pass/fail condition. |
| Five-second synchronous CPU | `event-loop-blocked` | Produces a probe gap of at least `4000ms`; another session cannot finish before the CPU fixture releases. |
| Unresolved async provider | `async-wait` | Another session finishes before provider release; max and p95 probe gaps remain observational. |
| Abort-ignoring async tool | `session-fence-occupancy` | Timeout makes the terminal row visible, but the same-session successor stays queued until the real executor settles; max and p95 probe gaps remain observational. |
| 12 MiB attachment materialization | `sync-io` | Exercises the current synchronous base64 decode and file writes and records exact materialization start/completion/duration, before/across/after probe gaps, p95, and RSS. |
| Hung external child | `external-child-lifecycle` | Uses asynchronous spawn and records production cancellation separately from harness TERM/KILL, child exit, executor settlement, and session-fence release; probe gaps remain observational. |

The hung-child fixture deliberately labels cleanup as `test-harness` and
`productionCleanupObserved: false`. Its `cancelAtMs` and `aliveAfterProductionCancel` fields end the
production observation. `harnessCleanupAtMs`, TERM/KILL timestamps, and the per-fixture teardown
count then prove that the test did not leak a child, but must never be cited as existing daemon
process-group ownership. `executorSettledAtMs` and `sessionFenceReleasedAtMs` are observed separately
so a durable terminal row cannot be mistaken for released session execution authority. A future
execution-attempt implementation should replace that negative baseline with daemon-owned cooperative
cancellation, `SIGTERM`, bounded grace, and `SIGKILL`, while retaining generation and PID-start
fencing.

## Threshold meaning

The `4000ms` CPU threshold is intentionally broad enough for a five-second busy loop while still
proving whole-event-loop starvation. Async-provider responsiveness is asserted through invocation
ordering rather than a wall-clock upper bound: the independent invocation must finish before the
provider is released. Abort-ignoring and hung-child responsiveness is asserted through terminal,
executor-settlement, child-lifecycle, and Session-fence ordering. Probe gaps remain observational
because runner scheduling, GC, filesystem, and base64 performance are machine-dependent, but p95
coverage, exact attachment timing, and the complete child lifecycle remain mandatory.

The process contract also mutates a valid report and proves that the schema rejects missing required
fields, missing environment metadata, and illegal measurement units. Failures should be interpreted
by classification before changing contracts. Do not turn runner timing into product behavior, and
do not report test-harness child cleanup as production behavior.
