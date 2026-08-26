# @zendev-lab/spark-task-runtime

Spark runtime adapter for executing one Spark task with a registered role.

Runtime resolves reusable `RoleSpec`s from `@zendev-lab/spark-roles` and adapts concrete role execution back into Spark task/run/Evidence state. Hosts inject a `SparkRoleInstructionExecutor` for daemon-native execution. Graph-level ready-task scheduling and durable workflow-run state live in `@zendev-lab/spark-workflows`; `@zendev-lab/spark-task-runtime` stays focused on one task execution at a time.

Responsibilities:

- run one ready task through a `RoleRegistry`
- adapt Spark tasks to the daemon-supervised Role Invocation port
- choose a concrete executor role for a single run when the caller did not assign one
- create a `role-run` task claim for the concrete run
- enforce run timeout/lease defaults
- refresh active claim leases with a heartbeat loop during non-dry-run execution
- sweep persisted expired claims with `sweepExpiredTaskClaims()`
- adapt `spark-roles` active-run tracking for timeout/reconciliation UI and kill/reply/steer result surfaces
- persist task-run Evidence through `@zendev-lab/spark-artifacts`
- read bounded role-run Evidence previews for background-run inspection
- compact historical role-run transcript Evidence through `collectRoleRunEvidenceRetentionPlan()`
- update `TaskRun` and task status on success/failure

Non-responsibilities:

- does not own role specs or role storage (`@zendev-lab/spark-roles`)
- does not own project/task/TODO/claim data structures (`@zendev-lab/spark-tasks`)
- does not schedule ready task waves or own `.spark/workflow-runs.json` (`@zendev-lab/spark-workflows`)
- does not provide generic Pi tools (`pi-*` packages)

Session lifecycle and continuity are not RoleRun fields. The daemon
`SessionSupervisor` derives them from the typed Owner; compatibility executor
arguments must not be persisted into RoleRun or Evidence projections.

Timeout semantics:

- Generic `@zendev-lab/spark-roles` timeouts abort the active run and reject with `RoleRunTimeoutError`.
- `@zendev-lab/spark-task-runtime` maps that generic error to Spark `RoleRunTimeoutError`, records the `TaskRun` as `running` with `failureKind: "runtime_timeout"`, and leaves the active role-run registry visible so the parent session can inspect or kill the run while cleanup completes.
- Other launch failures become failed Spark runs and clear the Spark active role-run tracker.
- Stale claim timeout means no heartbeat refreshed the lease; sweepers release the claim, mark the run `cancelled` with `failureKind: "claim_stale"`, and return the task to `pending` for retry.

Attribution:

- `roleRef` identifies the reusable role; it is not the concrete running actor.
- `runName`, `ownerSessionId`, and `runRef` identify the concrete run in `TaskRun` records and active `TaskClaim`s.
- Runtime-created Evidence records use task provenance and run-record data so outputs are attributed to the Spark task and concrete run while still retaining the role ref.

Use `runSparkTask()` for single-task execution. Use `@zendev-lab/spark-workflows` `runReadyTasks()` for graph-level ready task scheduling.
