# spark-invocation

`@zendev-lab/spark-invocation` is the dependency-light contract at Spark's
execution-admission boundary.

The daemon creates one immutable `SparkInvocationService` for an admitted
`Invocation -> ExecutionAttempt -> DSH Turn`. The service freezes Session,
attempt, Role, mode, model, cancellation, and narrow process-local ports. The
Cordis plugin exports that exact snapshot as `ctx.sparkInvocation`; it does not
own durable state, scheduling, provider discovery, or terminal transitions.

```ts
import { createSparkInvocationService } from "@zendev-lab/spark-invocation";
import { createSparkInvocationPlugin } from "@zendev-lab/spark-invocation/plugin";
```

The main entry also contains the structural, dependency-light call contracts
used while assembling an Invocation: tools, interactions, Role execution,
typed refs, and execution-scope admission. These are value and ABI definitions,
not another product composition or state owner.
Project, roadmap, Task, TaskRun, and review models are owned directly by
`@zendev-lab/spark-tasks`. Executable host behavior lives only in
`apps/spark-daemon/src/product`; durable domain state remains with its declared
owner.

Node-local path resolution and JSON file I/O are owned by
`@zendev-lab/spark-platform-node`, and copy-language selection is owned by
`@zendev-lab/spark-text-rendering`.

## Invariants

- A service snapshot and its attempt identity are frozen before mounting.
- One durable attempt can reserve at most one DSH Turn.
- The plugin is process-local and writes only the ignorable correlation event
  in the already-owned DSH Session log.
- Capability contracts remain structural and optional; adapters do not gain a
  second host or discovery mechanism.
- Persisted Session, Invocation, Task, Artifact, and Evidence identifiers do
  not depend on the source workspace name.

Changes to admission identity require focused service/plugin tests plus daemon
Invocation and restart/recovery coverage. Changes to a shared call shape must
also update the owner implementation and every supported product composition.
