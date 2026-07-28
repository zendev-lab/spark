---
title: Collaboration and channels
description: Distinguish roles, sessions, Side Threads, and message-platform channels before coordinating work.
---

## Four collaboration objects

| Object | Use it for | Lifetime and authority |
| --- | --- | --- |
| Role | Reusable responsibility, model, and instructions | Definition, not an execution identity |
| Session | Continuing conversation, execution identity, and mailbox | Durable and daemon-owned |
| Side Thread | Read-only tangent attached to one parent session | Child session with explicit handoff |
| Channel | Feishu, Infoflow, or QQ Bot conversation | Adapter bound to a daemon session |

Choose a Role when the responsibility should be reusable. Choose a Session
when work needs an independent history, queue, or durable identity. Use a
[Side Thread](/guides/side-threads/) for a bounded read-only tangent.

## Session requests and notifications

Sessions can send another local session:

- a **request**, which queues the exact body as work; or
- a **notification**, which records information without starting work.

The default accepted wait confirms admission, not completion. A completed wait
can return a bounded terminal result. Timeouts stop the sender's wait, not the
target execution. Completion summaries return to the originating session so it
can continue without polling.

The `session` agent tool, TUI `/inbox`, and `spark daemon session inbox`
perform list/read/ack through daemon RPCs. Frontends and extension hosts do not
open another session's mailbox files directly.

## Message-platform channels

Channel adapters normalize an inbound platform message, bind it to a workspace
session, and submit it through the daemon. They do not own task, session, or
execution truth. Outbound delivery fails closed when a provider response is
ambiguous, avoiding an automatic duplicate send.

For a smaller remote attack surface, a channel-bound agent receives only four
canonical tools:

- `session` sends requests or notifications to another session.
- `ask` pauses for structured user input.
- `context` previews bounded registered context providers.
- `todo` tracks the current session's checklist.

Shell execution, role fan-out, assignment, and workflow execution remain
disabled on that surface.

## ACP clients

`spark acp` is a stdio adapter for compatible editor clients. It uses canonical
daemon sessions for text prompts, cancellation, streamed updates, and tool
permission. It is an adapter, not another session store or executor.
