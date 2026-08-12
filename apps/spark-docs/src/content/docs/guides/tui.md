---
title: TUI
description: Use ordinary language first, then reveal only the local controls needed for the current session.
---

Start the terminal interface from the workspace where Spark should operate:

```bash
spark
```

## Start with the outcome

Ordinary input is the primary interface:

```text
Fix the failing login test without changing the public API. Show validation
evidence before calling it complete.
```

You do not need to select tools, a Loop, or a command plane first. Use
`/plan` for a multi-step change, `/execute` after the plan is ready, and
`/fleet` when confirmed ready Tasks have independent existing worktree targets.

## Everyday controls

The short help keeps the common path bounded:

```text
/help
/plan <goal>
/execute [focus]
/fleet [focus]
/status
/stop [reason]
/retry
/inbox
```

Model, thinking level, session selection, and queued input are available when
needed. They are controls for the current interaction, not separate product
features. New sessions use `high` thinking by default; an explicit session or
saved user setting continues to take precedence.

`/status` prints the complete daemon, current session, active work, usage, and
turn-queue summary directly. It does not open an action picker.

Bare slash commands enter their final TUI destination directly instead of
opening an intermediate action bar. For example, `/model` opens the model
selector, `/settings` shows the settings overview, `/queue` inspects the live
queue, and bare `/goal`, `/loop`, or `/repro` shows that lifecycle's status.
`/thinking` opens the final thinking-level selector directly.

The editor's Up and Down keys recall durable `user` prompts from the attached
session, including prompts that predate the current TUI process. Local slash
commands are not added to that prompt history. PageUp and PageDown scroll the
visible transcript; Ctrl+PageUp and Ctrl+PageDown remain available for moving
through a multiline editor draft. Submitting new input returns the transcript
to its latest line.

Esc still cancels active work first. When the session is idle and the editor is
empty, press Esc twice within 500 ms to leave the conversation and open the
unified session hierarchy.

## Inspect the current session

Use `/inspect` or Ctrl+K to open the local session inspector:

```text
/inspect
/inspect tasks
/inspect artifacts
/inspect off
```

It shows projections already published to this TUI. It is not Hub Web and does
not create another execution owner. Run `spark hub` in another
terminal for cross-session and workspace supervision.

The older `/hub` spelling remains executable as a compatibility alias but
is hidden from normal completion.

## Reveal more only when needed

- `/help` shows the short everyday path.
- `/help commands` groups active commands by common work, automation,
  workflows, sessions, and advanced controls.
- `/help all` additionally shows compatibility aliases and diagnostic metadata.
- `/automate` helps choose Goal, Loop, Repro, or Workflow, then pre-fills the
  existing canonical command without starting it.

This hierarchy keeps the command catalog searchable without making users learn
every registered extension command before their first task.
