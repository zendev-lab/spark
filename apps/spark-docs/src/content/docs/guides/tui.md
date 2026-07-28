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

You do not need to select tools, a driver, or a command plane first. Use
`/plan` for a multi-step change and `/implement` after the plan is ready.

## Everyday controls

The short help keeps the common path bounded:

```text
/help
/plan <goal>
/implement [focus]
/status
/stop [reason]
/retry
/inbox
```

Model, thinking level, session selection, and queued input are available when
needed. They are controls for the current interaction, not separate product
features.

## Inspect the current session

Use `/inspect` or Ctrl+K to open the local session inspector:

```text
/inspect
/inspect tasks
/inspect artifacts
/inspect off
```

It shows projections already published to this TUI. It is not the Web Cockpit
and does not create another execution owner. Run `spark cockpit` in another
terminal for cross-session and workspace supervision.

The older `/cockpit` spelling remains executable as a compatibility alias but
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
