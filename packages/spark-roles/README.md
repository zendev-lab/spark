# @zendev-lab/spark-roles

Owns reusable `RoleSpec` definitions, Role-Skill composition, external Role model settings, ephemeral Role Invocation execution, the canonical `role` tool, and the ad-hoc `skill_agent` execution surface. A `RoleRun` is only the durable receipt/projection of a Role Invocation.

## Storage and models

Role Markdown loads from project `.agents/roles/**/*.md`, user `~/.agents/roles/**/*.md`, builtins, and loaded extensions. Every current `RoleSpec` has a content-addressed definition `revision`, semantic `modelType`, declared `capabilities`, and optionally up to eight ordered unique `skills`; Session Owner, not Role, derives lifetime. The definition revision includes Skill names. Immediately before execution, Spark resolves those exact names through normal Skill precedence, requires each Skill to be enabled and model-invocable, reads every complete `SKILL.md` source once, and rejects compositions above 64K characters. The execution composition revision includes the definition revision and ordered Skill source digests. The child Session receives the rendered Skill bodies and resource bases, while the run record retains the definition revision, composition revision, and digests.

Roles without `skills` retain the original prompt and revision behavior. A composed Role follows its preloaded Skills in the same Session; it does not call `skill_agent` for them. Role files do not carry `model` or `defaultModel`; Spark model bindings live separately in project `.spark/role-model-settings.json` and user `$SPARK_HOME/role-model-settings.json` or `$XDG_CONFIG_HOME/spark/role-model-settings.json`. Resolution order is explicit Invocation model, Session config, project Model Type settings, then user Model Type settings. A Role-bound Session fails closed when its Model Type has no mapping; only `none` Sessions may use supervisor or Workspace fallback.

The persisted settings schema is strict v2 and keys `modelTypes` by open semantic names such as `coordination`, `exploration`, and `implementation`. Daemon admission migrates v1 `roleModels` before runtime opens the store. If multiple legacy role entries collapse onto one Model Type with conflicting models, admission fails closed until the user chooses one mapping; runtime never dual-reads v1.

## Public surface

- `role({ action: "list" | "get" | "create" })` manages reusable definitions.
- `role({ action: "call" })` instantiates one fresh Invocation-owned ephemeral Session, invokes it, and closes it. It never enters Session list/mail/bind/archive/restore/resume surfaces.
- `role({ action: "model_list" | "model_get" | "model_set" | "model_delete" })` manages model settings.
- `skill_agent({ skills, instruction, inputs? })` runs an ad-hoc, self-contained capability with exact model-invocable Skills when no predefined Role owns the responsibility.

A Skill Agent receives the selected Skill bodies and the explicit delegation
packet, not the parent transcript. It currently selects a model through its
semantic Model Type; a missing binding fails instead of falling back. The child receives a fixed direct-work tool profile. It
cannot call Roles or Sessions, delegate another Skill Agent, mutate Task state,
or publish Git, Artifact, or Evidence state. The parent Session remains
responsible for decomposition, durable coordination, verification of
consequential claims, and user-facing synthesis.

Use `skill_agent` when one or more Skills can own a self-contained unit of work
and the parent should hand over execution instead of interpreting those Skills
itself. Read `SKILL.md` when the parent session must directly follow a Skill.
Do not explicitly read and delegate the same Skill by default.

Scoped identity, lifecycle, bindings, continuity, calls, and mail belong to canonical `session`. `role` and `skill_agent` must not accept persistent Session lifecycle or mail parameters.

Builtin role identities, Model Types, and capability profiles are:

- `administrator = read + interact + manage + spawn` for decomposition, delegation, monitoring, acceptance, and escalation; its tool allowlist excludes file write, exec, and network tools;
- `explorer = read + net` for local/external fact gathering;
- `executor = read + net + exec + write` for approved implementation;
- `reviewer = read + net` for independent verification and an accept/reject recommendation.

Explorer and Reviewer receive no execution, file-write, interactive, or further-delegation tools and return blockers to Administrator. Builtin model choices remain outside RoleSpec in project/user Role model settings.

Managed Task execution remains the Task/Workflow scheduler's responsibility;
direct Role and Skill Agent calls do not claim Tasks or create Task Evidence.
