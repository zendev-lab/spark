# @zendev-lab/spark-roles

Owns reusable `RoleSpec` definitions, semantic Model Type settings, anonymous `RoleRun` execution, the canonical `role` tool, and the dedicated `skill_delegate` execution surface.

## Storage and models

Role Markdown loads from project `.agents/roles/**/*.md`, user `~/.agents/roles/**/*.md`, builtins, and loaded extensions. Every current `RoleSpec` has a stable `revision`, semantic `modelType`, declared `capabilities`, and an `owned` or `persistent` instantiation policy. Role files do not carry `model` or `defaultModel`; Spark model bindings live separately in project `.spark/role-model-settings.json` and user `$SPARK_HOME/role-model-settings.json` or `$XDG_CONFIG_HOME/spark/role-model-settings.json`. Resolution order is explicit run model, project Model Type settings, then user Model Type settings.

The persisted settings schema is v2 and keys `modelTypes` by open semantic names such as `coordination`, `exploration`, and `implementation`. Spark read-migrates v1 `roleModels` entries through the builtin role-to-type mapping. If multiple legacy role entries collapse onto one Model Type with conflicting models, migration fails closed until the user chooses one mapping.

## Public surface

- `role({ action: "list" | "get" | "create" })` manages reusable definitions.
- `role({ action: "call" })` runs one fresh anonymous Role invocation.
- `role({ action: "model_list" | "model_get" | "model_set" | "model_delete" })` manages model settings.
- `skill_delegate({ skill, instruction, inputs? })` loads one exact model-invocable Skill internally and runs it through a fresh anonymous Skill Worker.

A Skill Worker receives the selected Skill body and the explicit delegation packet, not the parent transcript. It inherits the active model and a fixed direct-work tool profile. It cannot call Roles or Sessions, delegate another Skill, mutate Task state, or publish Git, Artifact, or Evidence state. The parent session remains responsible for decomposition, durable coordination, verification of consequential claims, and user-facing synthesis.

Use `skill_delegate` when a Skill can own a self-contained unit of work and the parent should hand over execution instead of interpreting the Skill itself. Read `SKILL.md` when the parent session must directly follow the Skill. Do not explicitly read and delegate the same Skill by default.

Persistent identity, lifecycle, bindings, continuity, calls, and mail belong to canonical `session`. `role` and `skill_delegate` must not accept persistent session lifecycle or mail parameters.

Builtin role identities, Model Types, and capability profiles are:

- `administrator → coordination = read + net + exec + write + interact + spawn` for workspace coordination;
- `explorer → exploration = read + exec` for non-mutating local repository and environment probes;
- `researcher → research = read + net` for source, documentation, issue, PR, and prior-art research;
- `reviewer → verification = read + net` for independent verification;
- `executor → implementation = read + net + exec + write` for approved implementation.

`scout` is a hidden compatibility alias for `explorer`; `worker` is a hidden compatibility alias for `executor`. New configuration and user-facing selection expose only the canonical names.

New research tasks default to `researcher`; tasks that need executable local probes select `explorer` explicitly. Builtin Roles do not receive interactive or orchestration tools and report blockers upward.

Managed Task execution remains the Task/Workflow scheduler's responsibility; direct Role and Skill Worker calls do not claim Tasks or create Task Evidence.
