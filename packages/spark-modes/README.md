# spark-modes

Host-neutral operating-lens primitives for Spark-style agents.

## Purpose

`@zendev-lab/spark-modes` owns the per-turn **mode** vocabulary and rendering mechanics:

- `plan` and `execute` built-in lenses. Investigation and research are activities within `plan`, not separate lenses.
- `assist`, `loop`, `goal`, `repro`, and `workflow` turn loops.
- Open mode registry for host-defined custom lenses.
- Pure action-tool descriptor and action evaluation helpers (library default tool name `mode`; Spark native hosts register `mode`).
- System-prompt marker and requirements assembly helpers.

### Why Spark says `mode` while this package says `mode`

`spark-modes` is a host-neutral mechanism package: “mode” means any registered lens id. Spark’s durable session operating axis is only `plan | execute`, so the Spark native tool and specs use the name **`mode`** (`mode({ action })`). Hosts pass `createModeTool({ name: "mode", label: "Mode" })`.

The package is mechanism only. It does not persist mode state and does not import Spark extension, spark-cli, goal, workflow, task, or role runtime code.

## Boundary

Hosts resolve and render the Session mode. Durable Goal, WorkflowRun, and Loop state stays with its owning runtime and remains orthogonal to the mode.
