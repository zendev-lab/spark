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
/reload
/inbox
```

Model, thinking level, session selection, and queued input are available when
needed. They are controls for the current interaction, not separate product
features. New sessions use `high` thinking by default; an explicit session or
saved user setting continues to take precedence.

`/status` prints the complete daemon, current session, active work, usage, and
turn-queue summary directly. It does not open an action picker.

If a retryable daemon invocation fails, `/retry` creates one new linked attempt
through the daemon and observes that invocation. It does not replay the failed
row or submit the prompt again with the old idempotency key. A model response
that terminates without visible text or a tool call first uses Spark's bounded
in-invocation continuation policy; `/retry` remains the explicit recovery after
that budget is exhausted. An unknown admission outcome is different: Spark
automatically reconciles the same submit identity so it cannot create a
duplicate turn.

`/reload` fully replaces the TUI worker process while preserving the current
daemon session and its effective workspace directory. The new worker reattaches
and hydrates durable history and daemon-owned running work; it does not replay
the prompt passed when Spark first launched. Draft editor text, overlays,
scroll position, and other in-memory UI state reset. Spark refuses the reload
until any in-flight command, submission, or retry has settled and a submitted
prompt has received a durable daemon identity, so local work cannot disappear
with the old process.

Bare slash commands enter their final TUI destination directly instead of
opening an intermediate action bar. For example, `/model` opens the model
selector, `/settings` shows the settings overview, `/queue` inspects the live
queue, and bare `/goal`, `/loop`, or `/repro` shows that lifecycle's status.
`/thinking` opens the final thinking-level selector directly.

The editor's Up and Down keys recall editor history hydrated from durable
`user` prompts in the attached session, including prompts that predate the
current TUI process. Non-empty local slash command input is added before
dispatch, whether it succeeds or reports an error, but those command entries
remain in the current TUI process only: they are not written to the transcript,
daemon prompt history, or user files, and `/reload` clears them. Inputs beginning
with `//` remain ordinary prompts. PageUp and PageDown scroll the visible
transcript; Ctrl+PageUp and Ctrl+PageDown remain available for moving through a
multiline editor draft. Submitting new input returns the transcript to its
latest line.

Esc still cancels active work first. When the session is idle and the editor is
empty, press Esc twice within 500 ms to leave the conversation and open the
unified session hierarchy.

## Inspect the current session

Use `/inspect` or Ctrl+K to open the local session inspector:

```text
/inspect
/inspect tasks
/inspect artifacts
/inspect repro
/inspect off
```

It shows projections already published to this TUI. It is not Hub Web and does
not create another execution owner. Run `spark hub` in another
terminal for cross-session and workspace supervision.

When the daemon projects an active Repro, the transcript keeps a compact
Implementation / Exactness / Formalize summary with counts, blockers, pending
handoffs, and the last `formalizedTip`. Ctrl+K opens the Repro panel first;
Shift+Ctrl+K cycles inspector panels. In the Repro panel, press 1, 2, or 3 to
select a lane, use the arrow keys or J/K to select a bounded work item, and
press Enter to open its existing Task, Run, Git Change, and Evidence
projections. Each lane row also shows its binding revision and status, current
route or refresh action, TaskRun, and candidate or canonical Git Change. Esc
returns from detail to panel, then from panel to transcript.

The TUI never derives lane state from transcript text, prompts, or elapsed
time. Narrow terminals preserve the newest transcript content and composer
before inspector detail. After `/reload`, panel focus and selection reset while
the new worker reprojects the same daemon-owned Session and Repro state; settled
Asks are not replayed.

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
