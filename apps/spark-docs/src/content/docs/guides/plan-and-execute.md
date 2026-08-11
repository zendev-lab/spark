---
title: Plan and implement a change
description: Turn a goal into verifiable tasks, implement the approved plan, and inspect the result.
---

Start with the outcome you want. You do not need to choose an execution
mechanism before Spark understands the work.

```bash
cd <workspace>
spark
```

Then describe the goal in ordinary language:

```text
Fix the login failure without changing the public API. Run the relevant tests
and show me the evidence before calling it complete.
```

## Five names you will see

| Name | Meaning |
| --- | --- |
| Workspace | The repository or directory where Spark is working |
| Session | The continuing conversation and its context |
| Task | One verifiable piece of the requested work |
| Run | One execution attempt |
| Artifact | A durable result such as a preview, issue, or pull request |

These five names are enough for the main workflow. Operator details remain
available in the CLI reference when you need them.

## Create a plan

Use `/plan` when the change needs investigation or more than one meaningful
step:

```text
/plan Fix the login failure. Inspect the current implementation first, create
verifiable tasks, and do not implement them yet.
```

Spark investigates the workspace and creates or refines durable tasks. Review
the proposed scope, success conditions, dependencies, and validation commands.
Adjust them with ordinary language:

```text
Keep the database migration out of scope. Add a browser regression test to the
success conditions.
```

## Implement the approved plan

When the plan is ready:

```text
/execute Execute the approved plan and stop if a required decision is
missing.
```

Spark works through ready tasks until the plan completes, validation fails, or
it needs your input. When a material choice cannot be made safely, answer the
question in the current session or open `/inbox`.

## Run an independent frontier with Fleet

Use Fleet when the approved plan has at least two ready tasks that can safely
run against non-overlapping GitChange targets:

```text
/fleet Dispatch the safe ready frontier and stop for any failed isolation
preflight or material decision.
```

The Fleet owner coordinates; it does not edit source, mutate Git, run Cue, or
start Role, Skill, or Workflow workers directly. `assign` is the only dispatch
path. Each Task must already link an attached `git_change` Artifact. If a Task
links one GitChange, Spark can infer it. If it links more than one, its execution
policy must identify a primary target and the exact writable target set. Fleet
does not create or guess worktrees.

Tasks with any common writable target run serially. Disjoint target sets may run
in parallel. A reusable worker stream is the same owner Session, Project, Role,
primary target, and complete writable target set. Consecutive Tasks in one
stream reuse the same worker Session and context; `continuity: "fresh"` opts out.
For a multi-repository Task, the primary worktree is the default cwd while all
listed targets are locked and write-authorized for that run.

The Fleet projection reports:

- `recommended`: at least two safe, disjoint target sets are dispatchable now,
- `running` and `workers`: active TaskRuns and reusable worker Sessions,
- `ready`: dependency-ready Tasks before target/resource admission,
- `attention`: blocked or failed Tasks requiring owner action,
- `done`: completed Tasks.

When a worker finishes, its completion mail wakes the owner. Spark reconciles
the TaskRun and resource reservation first; it does not treat mail text as completion
truth. The owner then explicitly recovers and retries (within `maxAttempts`),
continues unrelated ready work, asks you, or waits. Leaving Fleet stops new
dispatch but does not cancel admitted workers; re-entering resumes from durable
TaskGraph, TaskRun, resource reservation, and Session Registry state.

Every run freezes its execution scope. Worktree writes, Git targets, and
local Cue execution must remain in the authorized target set; readonly Tasks
cannot write, and isolated-result Tasks can write only below their own
`.spark/task-results/<jobId>`. Missing, moved, stale, cross-Workspace, traversing,
symlink-escaping, unlisted secondary, and remote Cue targets fail closed.

## Inspect the result

The current session shows the implementation summary and validation results.
For a wider view, start Hub Web:

```bash
spark hub
```

Open the same Workspace and Session, then inspect:

- **Summary** for the current outcome and remaining work,
- **Tasks** for plan progress and blockers,
- **Changes** for structured changes supplied by the runtime,
- **Artifacts** for previews, issues, or pull requests actually produced by the run.

An empty Changes or Artifacts section means that the runtime did not publish
that result; Hub Web does not infer it from chat text.

## Choose another execution style only when needed

- Use [`spark run`](/guides/runs-and-sessions/) for one foreground result.
- Use [`spark bg`](/guides/runs-and-sessions/) when the shell should return immediately.
- Use [automation](/guides/automation/) for a durable goal, repeated work,
  evidence-gated reproduction, or a saved workflow.
