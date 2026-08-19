# @zendev-lab/spark-extension

Spark product extension composition root for native TUI, headless, and
structurally compatible extension hosts.

The composition-coupled headless role executor and host bootstrap live here
(`./headless-role-executor`, `./host`) because they statically import this
package's LLM island and extension factories. `spark-host` remains the
host-neutral runtime and must not import composition.

The package registers commands, tools, Roles, renderers, and host adapters. It
does not own persistent Session, Invocation, Task, Evidence, or Repro state.

Repro exposes only:

- `/repro <objective>` and `/repro start <objective>`;
- `/repro status`;
- `/repro stop`;
- `repro({ action: "start" | "status" | "stop" })`.

The extension forwards those controls to the daemon-owned Repro v10 owner. It
does not run a Repro scheduler, persist lifecycle JSON, scan transcripts, or
advance checkpoints from lifecycle hooks. Generic execute-mode continuation
also excludes Repro projects, so a lane cannot claim a sibling lane Task after
finishing its own checkpoint.

Exactly three Repro Role definitions are registered: Implementation, Exactness,
and Formalize. A Workspace may contain zero, one, or many repositories. Their
prompts therefore require explicit discovery and never assume that cwd is Git,
that a GitChange exists, or that a PR must be created.

Task completion review resolves its model through the same order as an
Invocation: explicit override, Session model, Role mapping, inherited ancestor,
then Workspace default. A missing Role mapping is not an error, which allows
lane Sessions to inherit and freeze the Root model at Repro start.
