---
title: Runs and sessions
description: Choose foreground, background, interactive, and resumed Spark execution.
---

## Foreground headless work

`spark run` waits for the headless run and prints its result:

```bash
spark run "Review the current diff."
spark run --json "Return a machine-readable repository summary."
```

Resume a known session when continuity matters:

```bash
spark run --resume <session-id> "Continue with the next verified step."
```

## Background work

`spark bg` submits a daemon invocation and returns its receipt. Without an
explicit session, Spark creates an invocation session identifier:

```bash
spark bg --json "Run the repository validation and report failures."
```

Submit more work to an existing session:

```bash
spark bg --session <session-id> "Re-run only the failing check."
```

Inspect the invocation through daemon commands instead of starting another
executor:

```bash
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason "No longer needed" --json
```

## Interactive sessions

List daemon sessions and attach from the same workspace:

```bash
spark daemon session list --json
spark web
```

Session identity preserves conversation and execution continuity. It does not
override workspace binding or permission checks.

Every workspace has one protected Administrator root Session. Ordinary
workspace conversations are retained children of that root. Every runtime
conversation is a Session. Role is a static definition bound at runtime
through `roleBinding`. The human operator is not a Role; the Administrator
root is always bound to builtin `administrator`. Any Session with child
lineage is a subsession regardless of whether its origin is a Side Thread,
TaskRun, Workflow, driver, driver tick, or Invocation. A child with an
explicit Role bind — created by `session spawn|fork` — is a subagent. That
word is presentation language, not a second runtime type. Official DSH
`subagent` / `subagent_fork` tools are a compatibility mapping onto
`session spawn|fork` plus `session send`; the native session tool remains
callable on its own. A daemon-backed Agent receives a creation-time snapshot
of every currently enabled and available model. The fresh-child `subagent`
tool exposes DSH's provider/model/reasoning selection fields; an omitted route
inherits the parent Session and an explicit pair is revalidated against the
daemon catalog when the child is created. `subagent_fork` keeps the parent
route so its inherited transcript prefix remains reusable. The daemon
atomically freezes the selected provider, model, supported reasoning level, and effective output
ceiling on the child Session. That ceiling is the minimum of the requested or
inherited limit and the model catalog limit, then each model call applies its
context-safety limit. The tool result waits for the child Invocation's durable
terminal state; disposal requests cancellation and waits for the child to go
idle. A Web-only fallback without daemon execution authority advertises no
AgentOptions support and rejects execution instead of creating a local owner.
Their active state
comes from queued/running Invocations, not UI timers. Native session view
`status` uses the same three values (`idle`, `queued`, `running`); a queued
Invocation is not collapsed to `running`. Owned temporary children
close with their owner and normally discard full transcripts; retained public
Sessions alone can be restored with the same stable ID, incarnation, and transcript.
New local-web, Hub, and ACP conversations are retained scoped children of that root.
Channel conversations are separate daemon-scoped root Sessions and require no
Workspace; Hub displays them outside the Workspace tree. Parent self
activity remains separate from bounded descendant activity. A driver or
driver-tick child shares the parent's durable FIFO serialization key, so a tick
and manual input queue instead of running concurrently; ordinary children and
Repro lanes serialize independently on their own Session IDs.

Spark 0.4.0 performs the supported intermediate upgrade from Session registry
v6 to v7 and Repro v9 to v10. The current daemon upgrades registry v7 to v8,
including eligible legacy Channel children. Each step creates a backup, stages
the migration, and reads the staged result back before committing it. Older or
ambiguous state fails closed; upgrade through the intermediate release before
starting a newer daemon. See [daemon-global Channels](/guides/channels/) for
Channel-specific conflict behavior.

Before an owned temporary Session discards content, Spark seals one bounded
close receipt. Role and Skill children reuse their reported outcome and final
assistant result. Task and Repro children reuse the Task completion summary;
`task_revision` receipts also collect the Invocation, Evidence, and Artifact
references from that incarnation. If no valid semantic result exists, Spark
stores a deterministic metadata-only fallback and still removes the content.
The receipt is queryable Session metadata, not Evidence or Memory.

## Creating Role-bound Sessions

Create or select a static Role first. From a tool-enabled Session, `spawn`
creates an empty child and `fork` creates a child with an independent copy of
the current Session's stable transcript prefix:

```ts
session({ action: "spawn", roleRef: "role:project-executor", name: "Implementation" })
session({ action: "fork", roleRef: "role:builtin-reviewer", name: "Review" })
```

CLI callers name the supervisor explicitly:

```bash
spark daemon session spawn --supervisor <session-id> --role-ref <RoleRef> --json
spark daemon session fork --supervisor <session-id> --role-ref <RoleRef> --json
```

Neither command sends an instruction or creates an Invocation. Trigger work in
the returned child separately:

```ts
session({
  action: "send",
  kind: "request",
  toSessionId: "<child-session-id>",
  message: "Run the focused verification and report evidence."
})
```

A fork never shares a writable transcript tail with its parent. Parent and
child append and compact independently. If the parent transcript changes while
the stable prefix is copied, Spark retries once and then returns
`session_transcript_changed` rather than creating a torn child.

## Sending work between Sessions

A Session request without `onActive` is an idle-only attempt. Spark submits it immediately when the target is idle. If the target is queued or running, Spark persists nothing and returns `session_mail_target_active`, prompting the caller to retry with one explicit policy:

- `onActive: "queue"` stores the request in the target's durable FIFO queue. Each target accepts at most three pending requests; a full queue fails without storing another message.
- `onActive: "interrupt"` cancels the target's current invocation before submitting the new request.

Notifications still persist without triggering target execution.

## Which mode should you use?

- Use `spark run` for one foreground result.
- Use `spark bg` when the shell should return after durable submission.
- Use `spark web` for interactive exploration and steering.
- Use Hub Web to observe and control existing daemon work from the browser.
