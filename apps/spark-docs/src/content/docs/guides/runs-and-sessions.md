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
spark tui --session-id <session-id>
```

Session identity preserves conversation and execution continuity. It does not
override workspace binding or permission checks.

Every workspace has one protected Administrator root Session. Role, Skill,
Task, and Workflow work runs in owner-bound child Sessions. Their active state
comes from queued/running Invocations, not UI timers. Native session view
`status` uses the same three values (`idle`, `queued`, `running`); a queued
Invocation is not collapsed to `running`. Owned temporary children
close with their owner and normally discard full transcripts; retained public
Sessions alone can be restored with the same stable ID, incarnation, and transcript.
New TUI, Hub, and ACP conversations are retained scoped children of that root.
Channel conversations use the same parent but keep Channel routing and state
binding. Loop activity rolls up from its `driver` or `driver_tick`
child without exposing the child's private prompt.

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
- Use `spark` or `spark tui` for interactive exploration and steering.
- Use Hub Web to observe and control existing daemon work from the browser.
