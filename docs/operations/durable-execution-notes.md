# Durable execution checkpoint notes

Status: design notes only. This is a mechanism comparison, not an adoption recommendation.

## External mechanisms

| System | Durable boundary | Retry caveat |
| --- | --- | --- |
| [Inngest](https://www.inngest.com/docs/learn/how-functions-are-executed) | successful `step.run` results are persisted and reused; waits and timers are durable | a failed step can run again, so Inngest requires retried side effects to be idempotent |
| [Restate](https://docs.restate.dev/guides/request-lifecycle) | Context operations and results are journaled; replay skips committed operations | `ctx.run` has retry policy; exactly-once claims depend on Restate-mediated invocation, journal, and communication boundaries |

These mechanisms do not provide an unqualified guarantee for every external effect. Any Spark design
must name the checkpoint, deduplication key, retry boundary, and external-system contract.

## Current Spark mapping

| Concept | Current owner | Remaining gap |
| --- | --- | --- |
| execution identity | daemon Invocation id inside an owner-bound Session; workflow and Loop refs are parent scopes | no single tool-step identity across every execution surface |
| checkpoint | workflow events/snapshots and invocation restart checkpoints | general tool/model side effects are not step-memoized |
| event history | daemon invocation events and Hub projections | projections are not a replay journal for the turn engine |
| retry | daemon invocation attempts and workflow retry policy | most retries restart the owning turn or run |
| wait | ask/approval lifecycle and driver scheduling | no general durable timer/await record for arbitrary work |

The daemon remains the execution owner. `SessionSupervisor` composes the
existing Session Registry and Invocation SQLite store; it is not a journal or
scheduler. Hub/TUI/ACP data is a projection, and `spark-loop` remains
continuation policy rather than a second execution journal. Crash probes should
therefore assert the `RoleSpec -> Session -> Invocation` owner chain and verify
that temporary child payloads are redacted only after their Invocations become
terminal.

## Small validation slice

Before proposing a new journal or external engine, test one daemon-owned operation with:

1. a stable execution and step key;
2. persisted input hash, status, and bounded result metadata;
3. crash points before dispatch, after dispatch, and after result persistence;
4. a documented rule for whether each crash retries, resumes, or fails closed;
5. an idempotent or deduplicated external effect.

Only extend the design if this slice demonstrates a recovery gap that existing invocation and
workflow state cannot represent.

## Non-goals

- Do not add Inngest or Restate as a production dependency from these notes.
- Do not claim general exactly-once execution for Spark.
- Do not migrate Hub schemas before a daemon-owned journal shape is validated.
