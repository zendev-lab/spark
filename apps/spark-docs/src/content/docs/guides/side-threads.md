---
title: Side Threads
description: Ask read-only tangent questions and deliberately hand useful context back to the parent session.
---

Side Threads are daemon-owned, read-only child conversations attached to a
parent TUI session. They are useful for investigating a tangent without
polluting the main conversation.

## Basic flow

Inside the native TUI:

```text
/btw show
/btw ask What assumptions does this module make about retries?
/btw handoff summary Add the retry finding to the parent context.
```

`show` creates or reuses the child and displays its generation, status, model,
thinking level, pending work, and recent visible exchanges.

## Reset and configuration

```text
/btw reset contextual
/btw reset tangent
/btw model inherit
/btw thinking high
```

A reset closes the current child incarnation, seals its bounded close receipt,
then starts a new Side Thread generation and Session incarnation under the
same stable Session ID. Model and thinking overrides apply only to the child.

## Read-only boundary

Side Threads receive read-only tool effects. Writes, command execution, policy
changes, and external side effects are denied by the host. An answer can
recommend a change, but it cannot truthfully claim that it performed one.

`handoff full` or `handoff summary` explicitly admits the selected result to the
parent and resets the child after acceptance. Use handoff only when the tangent
belongs in the main session.

When the parent closes, the daemon closes the Side Thread first. Its full
transcript and Invocation content are discarded; bounded summary, usage,
execution profile, and explicit Evidence remain available to authorized
diagnostics. Reset preserves the prior incarnation's receipt metadata but does
not restore its transcript or reopen any child Session.
