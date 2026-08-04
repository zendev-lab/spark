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
/implement Execute the approved plan and stop if a required decision is
missing.
```

Spark works through ready tasks until the plan completes, validation fails, or
it needs your input. When a material choice cannot be made safely, answer the
question in the current session or open `/inbox`.

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
