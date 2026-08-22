# 2026-08-20: Role is static; Session binds it; subagent is that child

## Decision

Role is a static catalog. Session is the only runtime conversation entity
and binds at most one Role through `roleBinding`. “Subagent” is presentation
language for a child Session with an explicit Role bind. It is not a schema,
store, owner kind, package, or fifth wire role.

Role definition representation stays `RoleSpec` (`spark-protocol/role-session`
plus `spark-roles`). Authoritative fields:

```text
ref, id, source, revision, description, systemPrompt,
capabilities, skills?, allowedTools?, allowedToolEffects?,
modelType, origin?, createdAt, updatedAt
```

On disk that is Markdown: known frontmatter keys above, body = `systemPrompt`.
Role files do not carry `model`, `defaultModel`, lifetime, `sessionId`, or a
wire role. Model routing stays in Role model settings keyed by `modelType`.
Foreign `role: subagent` Markdown in `~/.agents/roles` remains ignored.

Session bind representation stays the protocol discriminated union:

```ts
type SparkSessionRoleBinding =
  | { kind: "none" }
  | { kind: "inherit" }
  | { kind: "explicit"; roleRef: `role:${string}` };
```

Invariants:

- The Workspace Administrator root is always
  `{ kind: "explicit", roleRef: "role:builtin-administrator" }`. The human
  operator is not a Role and is never stored as one.
- `session({ action: "spawn" | "fork", roleRef })` creates a child with an
  explicit Role bind. That child is the subagent. Trigger it with
  `session({ action: "send", kind: "request" })`.
- Unbound Sessions (`kind: "none"`) remain legal for Skill Agent children and
  other non-Role origins. They add no Role prompt or Role capability ceiling.
- Transcript wire stays `system | user | assistant | tool`. `user` is the
  human; `assistant` is the bound Role or Skill Agent identity. Do not add a
  named-assistant worker into the parent log.

DSH mapping: compose official `@deepseek-ai/dsh-subagent` as the HOST
(`ctx.subagents`). `spark-session` exports Role-bound `spawn` / `fork`
providers and a Cordis plugin (`inject: ["subagents"]`) that registers them.
Official `subagent` / `subagent_fork` are a compatibility mapping, not a
second runtime. One-shot `start()` is `createChild` then `send(kind=request)`
— the same two primitives as `session({ action: "spawn" | "fork" })` plus
`session({ action: "send", kind: "request" })`. Those native session tools
remain the standalone surface. Persona maps onto Role (`executor` →
`role:builtin-executor`; missing persona defaults to builtin executor).
Daemon mounts `SubagentRuntime`, then the session plugin with
`createSparkDaemonSubagentHost` so `start()` stays `createManagedChildSession`
plus `session.send`. spark-web-dsh inserts the same plugin, disables stock
`subagent-spawn-in-process` / `subagent-fork-in-process`, and maps its managed
Cue `backgroundMode` for those tools to `one-shot` so the official tool hits
provider `start()` instead of the HOST continuation manager. It does not
disable the official HOST. Do not reimplement `ctx.subagents`. Do not add a
`dsh-spark` package. Spark providers do not advertise `prepareContinuable`.
Compaction and jobs remain later owner decisions.

## Rationale

`session spawn|fork` already require `roleRef`, and registry v7 already
rejects a root that is not builtin Administrator. Calling the main Session
“you”, treating Role as a wire enum or operator×agent pair, or vendoring DSH
`roles/*.json` personas would create a second identity system beside
`RoleSpec` + `roleBinding`.

DSH adoption order parked subagent behind SessionStore so Spark would not
mount an in-process DSH child runtime. Persistence and agent-loop have now
landed on the shared daemon Cordis root. Official `dsh-subagent` is the
named-provider registry; Spark owns the child Session. A homemade HOST or a
`spark-turn` plugin would duplicate the seam and sit in a package scheduled
for deletion.

## Consequences

- TUI, Hub, and `apps/spark-web` may label a Role-bound child “subagent”.
  They must project daemon `roleBinding` and lineage; they must not invent a
  session or role store.
- `skill_agent` stays the only public ad-hoc (non-Role) child.
- Builtin Roles remain `administrator | explorer | executor | reviewer`.
- `ctx.subagents` is official. Spark registers spawn/fork only. Durable
  one-shot children stay daemon Sessions. Official `subagent()` is
  create+send; `session spawn|fork|send` remain independently callable.
  web-dsh's SessionStore fallback is live-only and does not write Spark
  registry `roleBinding`.
- Do not create `@zendev-lab/dsh-spark`. Overlay remains spark-web-dsh.
- Providers do not implement `prepareContinuable`. Managed Cue presets map
  spawn/fork tools to `backgroundMode: one-shot` so the official tool cannot
  bypass Spark Role bind through the HOST continuation manager. Follow-up
  work may wait the admitted Invocation to completion for a DSH-shaped
  `SubagentRun.result`, and may surface the bind in the workbench inspector.
