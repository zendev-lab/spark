# Capability sentinels

Capability sentinels are a small, deterministic validation lane for Spark's
highest-risk autonomous surfaces: Goal, Loop, and Repro. They are intended to
answer two release questions before broader suites finish:

1. Can a user enter, inspect, continue, and stop each capability through its
   canonical public command/tool boundary?
2. Do the daemon-owned safety and recovery contracts reject severe invalid
   transitions?

Run the lane from the repository root:

```bash
pnpm run test:capability
```

The runner selects a bounded set of daemon tests. Those tests also remain part
of the ordinary daemon suite, so this lane adds no second test owner. The
repeated non-blocking CE lane is documented in
[`nightly-capability-ce.md`](./nightly-capability-ce.md).

## Sentinel matrix

| Contract | Owner test | Failure intercepted |
| --- | --- | --- |
| Public Goal, Loop, and Repro entry surfaces | `spark-tools-capability-sentinel.test.ts` | Missing registration, broken persistence, unusable status/stop paths |
| Evidence-backed Goal completion | `spark-tools-capability-sentinel.test.ts`, `store/loop-cycle-review.test.ts` | Bare completion claims, missing Evidence, unexpected extra ticks |
| Stale Goal settlement fencing | `spark-tools-capability-sentinel.test.ts`, `spark/loop-goal-settlements.test.ts` | An old review completing a replacement Goal, duplicate settlement after restart |
| Open-ended Loop lifecycle | `spark-tools-capability-sentinel.test.ts`, `store/loop-cycle-review.test.ts` | Loop acquiring completion authority, failed scheduling, token use during a skipped tick |
| Repro continuation and stagnation | `spark-tools-repro-lifecycle.test.ts` | Continuing without `settle`, infinite unchanged ticks, missing Recover Ask |
| Trusted Repro decision/completion evaluation | `spark/repro-loop-evaluator.test.ts` | Model-dependent decision gating, non-durable formal proof, forged complete status |

## Hard budgets

The public-surface sentinel fails when a scenario exceeds its explicit public
surface-call or invocation count. Its host adapters throw if a model Role or
reviewer is invoked, and the test verifies that the daemon token-usage table
remains empty. This keeps the pull-request lane deterministic and provider-token
free.

The selected tests use temporary workspaces, an in-memory SQLite database when
restart behavior is not under test, deterministic timestamps, and typed
Evidence receipts. Assertions target public tool results, durable state, daemon
invocations, and persisted settlement records rather than prompt wording or
production-source fragments.

## Triage

A failure should identify the first broken contract rather than be converted
into an aggregate score:

- inspect the failing Vitest case and its public command/tool action;
- inspect Loop status, generation, binding, and invocation counts;
- inspect Goal review Evidence and settlement status;
- inspect Repro stage, Stop Guard, pending Ask, and whether `settle` scheduled a
  successor;
- treat any model/reviewer call or token-usage row in the public-surface test as
  a sentinel failure, even when the final state appears correct.

## Deliberate exclusions

This lane does not measure model intelligence, prompt quality, browser
rendering, package installation, or live-provider compatibility. Those need
separate scripted-provider, process-fault, and low-frequency live-canary lanes;
they must not weaken these deterministic contracts or turn severe failures into
an averaged benchmark score.
