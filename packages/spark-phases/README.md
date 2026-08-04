# spark-phases

Host-neutral operating-lens primitives for Spark-style agents.

## Purpose

`@zendev-lab/spark-phases` owns the per-turn **phase** vocabulary and rendering mechanics:

- `plan` and `implement` built-in lenses. Investigation and research are activities within `plan`, not separate lenses.
- `assist`, `loop`, `goal`, `repro`, and `workflow` turn loops.
- Open phase registry for host-defined custom lenses.
- Pure action-tool descriptor and action evaluation helpers (library default tool name `phase`; Spark native hosts register `phase`).
- System-prompt marker and requirements assembly helpers.

### Why Spark says `phase` while this package says `phase`

`spark-phases` is a host-neutral mechanism package: “phase” means any registered lens id. Spark’s durable session operating axis is only `plan | implement`, so the Spark native tool and specs use the name **`phase`** (`phase({ action })`). Hosts pass `createModeTool({ name: "phase", label: "Phase" })`.

The package is mechanism only. It does not persist phase state and does not import Spark extension, spark-cli, goal, workflow, task, or role runtime code.

## Boundary

Hosts resolve and render the Session phase. Durable Goal, WorkflowRun, and Loop state stays with its owning runtime and remains orthogonal to the phase.
