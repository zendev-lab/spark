# spark-driver

`@zendev-lab/spark-driver` is the driver authority for Spark loop and goal state and policy: lifecycle, tick, subgoal, and reviewer-gated completion primitives for capability hosts.

It intentionally exposes two related capabilities from one package boundary:

- **loop**: non-completing continuation substrate with an `active | paused` lifecycle. It can continue, wait, pause, retry, or report blockers. Absence is represented by clearing/null loop state.
- **goal**: goal objective/status primitives layered on the same continuation substrate, including prompt guidance for reviewer-gated completion. Goal state may become `active | paused | complete`, but the package itself does not register tools or decide Spark project/task success.

Spark uses these primitives as follows:

- Spark `/loop`: loop continuation without automatic completion.
- Spark `/goal`: loop-style continuation plus goal objective and reviewer-gated completion policy.

Non-responsibilities:

- does not parse or run workflow scripts (`@zendev-lab/spark-workflows`)
- does not schedule ready tasks or own workflow-run state
- does not register tools or slash commands (daemon product composition owns registration)
- does not make plain loop a completion authority; reviewer-gated completion is a goal-layer policy

## Package boundary (vs spark-host)

Keep `spark-driver` as a separate leaf. Its continuation state and goal policy are
reusable capability contracts; `spark-host` composes them with execution and
session adapters but must not become their owner.
