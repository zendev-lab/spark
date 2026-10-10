# Daemon simplification — deferred Tier-2 items and their acceptance criteria

Date: 2026-08-18
Status: accepted (documentation only; no code change this round)
Owner: daemon
Source: `spark-find-simplifications daemon` audit (Tier 2). Reference the audit
candidates by number below.

## Context

The daemon simplification search identified thirteen Tier-2 runtime
simplifications. Seven were implemented in the same round (periodic-tick
reconcile removal, mail-queue drain heads, notification scan fairness,
uplink poll downgrade, write-only table drop, retention first-pass merge,
close-receipt SQL filter). The six below change observable timing, durability,
or operator visibility and were deferred until their stated acceptance
criterion is met. Each criterion must be satisfied and tested before the
corresponding change lands; until then the current behavior is correct and
kept.

## Deferred items

1. **Double 1 s mailbox scan (2.4)** — `runSessionMailQueueDrainLoop` and
   `runNotificationReconcileLoop` both read and parse every `mailbox.json` each
   second via `allStoredMessages()`. Selectors are disjoint (request mail vs
   channel-notification targets), so this is scan-cost overlap, not
   double-processing.
   Acceptance criterion: notification targets are keyed off the durable
   `channel_deliveries` pending rows (or a shared single-pass scan returns both
   selectors) while preserving notification retry timing and FIFO order;
   equivalence proven by existing `session-notification-delivery` /
   `session-mail-queue` suites staying green plus a bounded-scan benchmark.

2. **Workspace-client lease expiry inside reads (2.6)** —
   `listWorkspaceClients` (and `listWorkspaces`) run `expireWorkspaceClientLeases`
   before every SELECT (`store/workspaces.ts:1810-1816`, `:1763`); the task-claims
   loop re-reads every 15 s. The write-in-read is the read-your-writes design.
   Acceptance criterion: expiry moves to one dedicated bounded sweep (the
   storage-maintenance pass is the natural home) and every read site declares
   `reconcileLeases: false`, with a documented "expired row visible as
   connected" window ≤ the sweep interval and a test proving a dead owner's
   lease still expires within that window.

3. **Mailbox delivery status write-time projection (2.8)** — the mailbox
   per-target status is projected only by the notification reconcile scan
   (`session-notification-delivery.ts:136-179`); the delivery worker
   (`channels/delivery-outbox.ts:303`) never writes it even though its payload
   carries `sessionId`/`messageId`.
   Acceptance criterion: the delivery worker projects the mailbox receipt at
   completion time through an injected mailStore callback, and the scan-side
   repair is kept as the idempotent crash-window fallback; a test simulates a
   crash after the row is terminal and before the projection lands and proves
   the next scan repairs without resending.

4. **`session_request_completion_deliveries` table (2.9)** — the table
   re-tracks "wake submitted", already idempotent on
   `session.request.completion.wake:${sourceInvocationId}` in the invocations
   store, with its own claim/lease machinery.
   Acceptance criterion: the table is replaced by a paged scan of terminal
   invocations whose task carries `sessionMail.wake`/`notifyOnCompletion`,
   duplicate submission is impossible via the existing idempotency lookup, and
   the operator visibility provided by `last_error`/`attempt_count` is either
   dropped by decision or re-homed in logs; restart behavior proven by the
   `session-request-completion-notify` suite.

5. **Two reply state machines (2.10)** — `outbox` kind `channel.reply`
   (inline-stream recovery only, `channels/reply-delivery.ts:95`) and
   `channel_deliveries` kind `reply`. They are mutually exclusive per
   invocation today (`channelReplyOwnedFromResult`, `spark/session-run.ts:1070`).
   Acceptance criterion: inline-stream recovery (`recovery`/`updateText`/
   `rerouteToMessage` handles) folds into `channel_deliveries` payload fields
   with a serialized-state migration, a replay-safety proof for recovery
   handles, and `reply-delivery`/`session-run` suites green on the new shape.
   This is a design change; do not attempt without a separate design note.

6. **Task-claim renewal at write time (2.11)** — the 30 s managed-session
   heartbeat renews only `daemon_workspace_clients`; main task-graph claims are
   renewed by the 15 s reconcile loop (`task-claims/reconciler.ts:89-105`).
   Acceptance criterion: renewal rides the heartbeat with the graph lock's
   retry policy (`MAIN_TASK_CLAIM_STORE_LOCK_RETRY_DELAYS_MS`) without ever
   blocking the heartbeat, and renew-vs-expiry race windows are proven by the
   `task-claims/*` suites. The expiry sweep itself must stay (inherently a
   scan).

## Follow-up

Each item above is tracked by its acceptance criterion; land the change only
with the criterion's test. The Tier-3 legacy-migration exit criteria remain a
separate governance task (SPARK.md migration-status section).
