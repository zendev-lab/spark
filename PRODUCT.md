# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary local Web user is a developer or maintainer who wants to start or continue one durable conversation with Spark. They should arrive at the current Session, understand its state, and send the next message without seeing or managing local service topology.

A Hub user coordinates work across the daemons they are authorized to access. They need cross-daemon attention, health, delegation, delivery, audit, and bounded recovery controls without becoming the owner of target execution. Workspace is a secondary project/context and Session grouping beneath its owning daemon.

## Product Purpose

Spark is a durable coding-agent product with two task-shaped browser surfaces. Local Web is conversation-first: start or resume a Session and steer it through messages. Hub is workbench-first: identify `Running`, `Needs you`, and `Failed` work across scopes and enter the owning Session within five seconds.

Local Web and Hub share one product model without sharing one page topology. Web presents local Sessions and Invocations through a chat-shaped experience and treats the local execution owner as an implementation detail. Hub adds daemon-scoped authentication, registry, audit, and coordination across authorized daemons through an attention workbench; internal Workspaces appear only when users need to group Sessions.

## Positioning

Spark Web is not a generic chat client, and Spark Hub is not a generic project dashboard. Their product truth comes from daemon-owned durable Sessions and Invocations, explicit human-wait states, lineage, recovery, and attributable Artifacts. Conversation is the interaction form, not a browser-owned queue; browser surfaces submit commands and render typed projections without inferring or recreating execution state.

## Operating Context

- Local Web is the chat-first browser surface for Spark on this computer. Its first viewport prioritizes a new-message composer or the current Session transcript and exposes no daemon selector, count, label, or topology.
- Hub is the workbench-first control plane for authenticated, cross-daemon coordination and remote access. Its first viewport prioritizes the attention queue.
- Web users move through recent conversations, the current Session, its active Invocation, human interactions, and Artifacts attached to that conversation.
- Hub users move through attention state across authorized daemons, durable Workspace and Session context, Invocation detail, recovery, and coordination controls. Workspaces are project/context/Session groups, never identities.
- In Hub, Daemon is the top-level authentication and connection unit. Workspace is the user-facing project/context and Session grouping beneath a daemon; it must not appear as a user account or primary identity switcher. Neither concept is a top-level identity in Web.
- Transcript is primary interaction context in Web and secondary audit context in Hub when a richer Work, Artifact, Change, or Task projection exists.

## Capabilities and Constraints

- The daemon is the only authoritative owner of persistent Sessions, Invocations, local execution, scheduling, retries, autonomous timing, and recovery.
- Hub owns cross-daemon registry, delegation, delivery, idempotency, audit, and bounded receipts. It does not own target execution, repositories, local Artifacts, or internal Evidence.
- User-facing hierarchy is surface-specific: Web uses `Workspace → Session → Invocation`; Hub uses `Daemon → Workspace → Session → Invocation`. Workspace means a project/context and its Session group, never an account or daemon boundary.
- Local Web and Hub must use the same protocol semantics, state vocabulary, visual tokens, accessibility behavior, and recovery language. Web uses a conversation topology; Hub uses a queue-detail workbench topology.
- Optimistic browser state must remain bounded and reconcile with authoritative projections.
- User-facing Artifact kinds remain `issue | git_change | document`.
- Loop states remain distinct: `scheduled`, `running`, `retry_wait`, `dormant`, `paused`, `blocked`, `completed`, and `stopped`.
- Supported locales must remain synchronized through the owned i18n catalogs.
- The Web/Hub information-architecture redesign does not need to preserve existing routes or navigation compatibility. A hard route cut is allowed.

## Brand Commitments

- The product name is Spark.
- Product language is direct, calm, operational, and explicit about authority, impact, and recovery.
- Primary UI copy should use user goals and durable work concepts. Implementation vocabulary belongs in diagnostics.
- Future work must not fabricate customers, testimonials, benchmarks, reliability claims, or deployment guarantees.

## Evidence on Hand

- Product intent and current direction: [`SPARK.md`](./SPARK.md)
- Public product overview: [`README.md`](./README.md)
- Repository and ownership invariants: [`AGENTS.md`](./AGENTS.md)
- Hub-specific product boundary: [`apps/spark-hub/AGENTS.md`](./apps/spark-hub/AGENTS.md)
- Existing Web, Hub, and shared UI implementations under `apps/spark-web`, `apps/spark-hub`, and `packages/spark-ui`
- Typed product semantics and projections under `spark-protocol` and the daemon product owner
- No external testimonials, benchmark corpus, or independently verified product-performance claims are currently part of the design evidence.

## Product Principles

1. **Conversation before operations in Web.** Lead with the current or next message; keep Invocation state, waits, and Artifacts attached to the owning Session.
2. **Attention before inventory in Hub.** Lead with work that is active, blocked, failed, or awaiting a decision across authorized daemons; offer Workspaces only as secondary project/context filtering.
3. **One model, task-shaped surfaces.** Web and Hub share protocol semantics, state vocabulary, recovery language, and visual primitives while exposing only the hierarchy each task requires.
4. **Authority stays visible.** Show where truth comes from, distinguish projected from optimistic state, and never imply that the browser owns execution.
5. **Recovery closes the loop.** Explain cause and impact, provide the safest available action, expose diagnostics progressively, and confirm restored state.
6. **Durable work is the identity.** Session lineage, Invocation progress, human intervention, and attributable Artifacts—not generic cards—define Spark's product character.

## Accessibility & Inclusion

All reachable states and controls must preserve semantic roles, labels, keyboard access, focus behavior, and explicit empty, loading, unavailable, permission, and error states. Mobile layouts must retain scope and status context when navigation collapses, and supported locales must remain functionally equivalent.
