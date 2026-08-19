---
title: Collaboration and channels
description: Distinguish Role definitions, Session lineage, and message-platform routing before coordinating work.
---

## Three collaboration concepts

| Object | Use it for | Lifetime and authority |
| --- | --- | --- |
| Role | One reusable responsibility, authority overlay, and optional preloaded Skills | Definition and exact Skill composition frozen per Invocation |
| Session | Execution context, history, queue, and mailbox | Owner-derived persistent, scoped, or ephemeral lifetime |
| Channel | Feishu, Infoflow, or QQ Bot conversation | Routing alias bound to a scoped Session |

Choose a Role when behavior and capability policy should be reusable. The
Role Session follows its declared preloaded Skills directly; `skill_agent` is
for ad-hoc self-contained capabilities without a predefined Role. The
default Session binding is `none`, with no extra Role prompt. Every Workspace
has one protected persistent Administrator; other continuing conversations are
scoped Sessions. A Role call uses a one-Invocation ephemeral Session. Use a
[Side Thread](/guides/side-threads/) for a bounded read-only tangent; it is a
child Session with `side_thread` origin, not another runtime entity. Every child
origin is shown as a subsession in the same recursive TUI and Hub tree.

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

## MCP clients

`spark mcp` (or the companion `spark-mcp`) is an explicit read-only stdio
adapter for MCP clients. It delegates Memory status and list calls to the
canonical Spark Memory owner; it does not add another store, session, or
executor.

## ACP clients

`spark acp` is a stdio adapter for compatible editor clients. It uses canonical
daemon sessions for text prompts, cancellation, streamed updates, and tool
permission. It is an adapter, not another session store or executor.
