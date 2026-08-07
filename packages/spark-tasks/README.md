# spark-tasks

Generic project/task/plan/run capability plus a session-bound TODO tool for Spark capability hosts.

`@zendev-lab/spark-tasks` owns task graph contracts, readiness, claims, task plan-item persistence, task-run records, and the canonical `task_read`, `task_write`, `assign`, and `todo` tools. Prefer constructing `TaskGraphStore` and `TaskTodoStore` with explicit host-owned paths. The exported default stores read `.spark/projects.json` and `.spark/todos/*`.

The public task surface is split by capability: `task_read` is read-only inspection, `task_write` mutates project/task graph state (including `action: "plan_update"` for the claimed task's plan items), and `assign` is the explicit spawn surface for ready-task scheduling. `task_write({ action: "plan" })` also supports a narrow existing-task dependency-only patch: pass exactly one `taskRef`, `name`, or exact `title` selector plus the complete replacement `dependsOn` array. This preserves the task plan and plan items and skips unchanged-plan readiness review, but retains all dependency safety checks. The normative contract lives in [`docs/specs/tools.md`](../../docs/specs/tools.md#state-and-execution).

Tasks durably link atomic user-facing outputs through `artifactRefs`.
`task_write({ action: "artifact_link" | "artifact_unlink", taskRef,
artifactRef })` is idempotent and verifies the Artifact at the product
composition boundary. Task persistence lazily defaults older records to an
empty list. Tasks do not own worktrees or PR topology, and this model adds no
separate Workstream aggregate.

The `todo` tool is a separate, session-bound checklist for standalone next-steps that are not tied to a claimed durable task. It survives reload for the session and is rendered alongside project tasks in the widget. Task plan items behave like a checklist too, but they live on `task.plan.items` and are edited through `task_write({ action: "plan_update" })`, so `task` de-emphasizes the word "TODO" for durable work.

`roleRef` fields and the persisted `role-run` claim kind are attribution for hosts that execute tasks through reusable role specs. New task planning should normally use `kind` as an executor hint and leave role binding to the host/runtime boundary.
