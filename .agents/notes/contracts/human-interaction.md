# Human interaction

Canonical contract for structured human asks and approvals across daemon, Hub, channels, and in-turn TUI UI.

## Ownership

- **Daemon is truth** for durable waits (`daemon_human_waits`) and whether an interaction is still open.
- **Hub** owns a read model (`human_requests`, inbox items) plus an outbox for operator responses (`human_responses` delivery).
- **`spark-ask`** owns only the in-turn terminal UI state machine (tabs, drafts, focus). It must not become a second durable store.
- **Channels** (e.g. QQ buttons) project and settle the same daemon wait; they do not invent terminal statuses.

## Supported interaction kinds (daemon broker)

The durable daemon broker currently settles:

- `askFlow` — structured questions (primary Hub / channel path)
- `toolApproval` — approve/reject a tool call (projected as a single-choice ask wait, then mapped back to a `toolApproval` response)

Other protocol kinds (`confirmation`, `diffApproval`, `modelSelect`, `workflowPicker`) remain host/TUI-local until a broker path exists. Do not assume Hub inbox can settle them.

## Status vocabulary

Use the shared enums from `@zendev-lab/spark-protocol` (`human-interaction.ts`):

| Layer | Status set | Meaning |
|---|---|---|
| Daemon wait / human request | `pending` → `answered` \| `cancelled` \| `archived` | Interaction lifecycle |
| Response payload to daemon | `answered` \| `cancelled` \| `archived` | Operator / channel reply |
| Hub response delivery | `delivering` → `acked` \| `failed` | Outbox transport only |
| Inbox item projection | `pending` \| `resolved` \| `archived` | UI bucket; `resolved` covers answered/cancelled |

Do not add extra terminal states at any projection layer. Map with `projectInboxItemStatus` when deriving inbox rows.

## Correlation

Stable ids must travel together:

- `humanRequestId` — durable daemon wait id
- `interactionRequestId` — optional host/tool correlation
- `toolCallId` — host-generated tool invocation identity; together with the
  owning `sessionId`, it reattaches a replayed tool call to the same durable
  wait across daemon restarts
- `humanResponseId` — Hub / channel response id

Replay identity must not be derived from mutable request content such as
`flow`, prompts, titles, or question text.

An `ExtensionUi.interaction` host declares its `askFlow` capabilities before
canonical Ask dispatch: supported deliveries, host-owned timeout support,
`request_id` response correlation, and (for async delivery)
`pending_with_human_request_id` acknowledgement. An async Ask is accepted only
after the response matches the exact `interactionRequestId` and returns both
`status=pending` and a non-empty durable `humanRequestId`; `spark-ask` exposes
that pair as `spark.ask-ack/v1`. A mismatched response, missing ACK, unsupported
capability, `blocked`/`error` response, or transport exception fails closed.

Canonical blocking Ask injects the host policy timeout and strips any caller
`timeoutMs`; reviewer takeover is reachable only after the transport returns a
correlated cancellation marked `timedOut=true`. Missing transports fail
immediately and never simulate a human wait with a local timer. Legacy local
select/input primitives remain blocking-only compatibility and cannot create an
async request or reviewer-timeout takeover.

## Answer semantics

Whether an answer “counts” (option selected or non-empty custom text) is defined once by `hasSparkAskAnswerContent` / `parseSparkAskChoice` in `spark-protocol` (`ask-semantics.ts`).

- TUI (`spark-ask`) re-exports those helpers for the flow controller and presents asks as an in-turn overlay.
- Hub shows pending **User** asks inline in the owning session (timeline `ask` tool part + composer `SessionAskPanel`); the workspace Inbox page remains the list/detail fallback. There is no global ask dialog. Inbox remains agent→user only.
- Session-addressed asks (`ask({ toSessionId })`) share the same delivery kernel as `session.send` and register `respondent.kind=session`. The asked Session settles them with `ask({ action: "answer" })` using provenance `session`. Session answers must not mint `spark.evidence-answer-event/v1`. They do not appear in Hub Inbox. User-addressed asks stay Hub/TUI/channel.
- Invocation wait (`session({ action: "wait" })`) is a durable invocation predicate. Ask durable wait is a separate **reply-wait**. Do not merge mailbox SQLite with `daemon_human_waits`.
- Approval-center builds decision payloads with the shared response status enum; it does not re-derive answer content rules.

Cross-session agent-to-agent traffic is **messages** (session inspector tab) plus session-addressed `ask`, not Inbox. Inbox is only agent→user human asks.

## Driver-aware approvals

Approval classes are owned by [`tools.md`](./tools.md). Binding a Goal, Loop,
or Repro is not consent. Interactive surfaces ask once via `askFlow`
(`spark.driver-authority`) and persist Session `driverAuthority`. Non-interactive
callers (CLI, API, daemon ticks) persist a silent grant and must not prompt.
The daemon broker has no `confirmation` path, so this consent uses `askFlow`.
Denied or unresolved consent does not fail the driver; `manual_only` then
creates a human approval request. A `required` operation still creates a
durable human request bound to the exact action, and the driver continues
independent work when possible. A WorkflowRun inherits the continuation driver
that started it only while that driver's authority remains active, and never
creates or retains authority by itself.

## Autonomous Goal/Repro evidence requests

The autonomous contract is owned by
[`autonomous-three-lane.md`](./autonomous-three-lane.md). Active Goal/Repro turns
must persist detached asynchronous evidence requests and continue independent
work. Their pending decision status is orthogonal to daemon scheduler activity.
A blocking human wait still occupies a scheduler slot, but a requested daemon
restart must yield the last persistable ask-only checkpoint instead of holding
drain forever. Mixed batches that already executed non-replayable tools fail
closed rather than replaying those tools after replacement.
Omitted/default blocking delivery, explicit blocking delivery, Ask aliases, and
`autoAnswer=true` must fail at the execution boundary before creating an
in-turn UI wait or durable blocking continuation. Each detached EvidenceRequest
freezes exactly one owner question id and answer kind. The daemon validates all
submitted question ids, required answers, options, and cardinalities against the
durable canonical request, then stores only the normalized owner answer in the
AnswerEvent. A side-question answer cannot release the bound Goal/Repro action.
AnswerEvents retain this specification's request/response correlation and
direct-user provenance rules. An answer accepted while the owner loop is
`running` or `scheduled` remains wake-pending until reconciliation commits a
later wake or observes the owner terminal; projection alone never acknowledges
wake completion.

Ordinary non-autonomous sessions retain the existing interaction contract.

## Related

- [`tools.md`](./tools.md) — `ask` is the only structured question surface; cancellation is not approval. Session-addressed asks stay out of Inbox.
- [`turn.md`](./turn.md) — daemon is execution truth; transports are adapters.
- [`sessions-and-channels.md`](./sessions-and-channels.md) — session mail `request` is a cross-session invocation primitive, not a tool-level human wait.

## Two ID systems and where each applies

Spark keeps exactly two identity vocabularies. Do not add a third.

| System | Shape | Owner | Use for |
| --- | --- | --- | --- |
| Domain refs | `kind:id` (e.g. `task:…`, `proj:…`, `evidence:…`) | `@zendev-lab/spark-core` (`RefKind`, `newRef`) | In-process task graphs, memory, tools, artifacts, agent-facing state |
| Wire ids | `prefix_hex` (e.g. `sess_<32 hex>`, `inv_<32 hex>`, `hreq_<32 hex>`) | `@zendev-lab/spark-protocol` (`refs.ts` / `createId`) | Daemon persistence, Hub, local RPC, runtime WebSocket envelopes |

Translate at the boundary when a surface must speak both (for example projecting a domain `task:` ref into a protocol task view that still carries the same `task:` ref string today, versus minting a new `task_<hex>` for a daemon row). Interaction correlation uses wire-style ids (`humanRequestId`, `interactionRequestId`) as documented above; generated Ask correlations use `ask_<32 hex>`, while domain `ask:` refs remain graph-local. Readers accept the retired `ask_async:<64 hex>` autonomous correlation only for durable or in-flight requests created before this normalization; writers never emit it.
