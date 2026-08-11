# @zendev-lab/spark-roles

Owns reusable `RoleSpec` definitions, role model settings, anonymous `RoleRun`
execution, the canonical `role` tool, and the dedicated `skill_agent`
execution surface.

## Storage and models

Role Markdown loads from project `.agents/roles/**/*.md`, user `~/.agents/roles/**/*.md`, builtins, and loaded extensions. Role files do not carry `model` or `defaultModel`; Spark model bindings live separately in project `.spark/role-model-settings.json` and user `$SPARK_HOME/role-model-settings.json` or `$XDG_CONFIG_HOME/spark/role-model-settings.json`. Resolution order is explicit run model, project settings, then user settings.

## Public surface

- `role({ action: "list" | "get" | "create" })` manages reusable definitions.
- `role({ action: "call" })` runs one fresh anonymous Role invocation.
- `role({ action: "model_list" | "model_get" | "model_set" | "model_delete" })` manages model settings.
- `skill_agent({ skills, instruction, inputs? })` loads the selected
  model-invocable Skills exactly once and runs them through a fresh anonymous
  Skill Agent.

A Skill Agent receives the selected Skill bodies and the explicit delegation
packet, not the parent transcript. It inherits the active model and a fixed
direct-work tool profile. It cannot call Roles or Sessions, delegate another
Skill Agent, mutate Task state, or publish Git, Artifact, or Evidence state. The
parent session remains responsible for decomposition, durable coordination,
verification of consequential claims, and user-facing synthesis.

Use `skill_agent` when one or more Skills can own a self-contained unit of work
and the parent should hand over execution instead of interpreting those Skills
itself. Read `SKILL.md` when the parent session must directly follow a Skill.
Do not explicitly read and delegate the same Skill by default.

Persistent identity, lifecycle, bindings, continuity, calls, and mail belong to
canonical `session`. `role` and `skill_agent` must not accept persistent
session lifecycle or mail parameters.

Builtin role capability profiles are:

- `explorer = read + exec` for non-mutating local repository and environment probes;
- `researcher = read + net` for source, documentation, issue, PR, and prior-art research;
- `reviewer = read + net` for independent verification;
- `worker = read + net + exec + write` for approved implementation;
- `scout = read + net` as a compatibility role for existing tasks.

New research tasks default to `researcher`; tasks that need executable local probes select `explorer` explicitly. Builtin Roles do not receive interactive or orchestration tools and report blockers upward.

Managed Task execution remains the Task/Workflow scheduler's responsibility;
direct Role and Skill Agent calls do not claim Tasks or create Task Evidence.
