# Spark daemon agent guide

This file extends the repository-wide [`AGENTS.md`](../../AGENTS.md) for changes
under `apps/spark-daemon`.

## Ownership

The daemon is the authoritative writer for local execution state, including:

- workspace-bound sessions and session mail;
- invocations, events, cancellation, results, and retention;
- channel listeners, delivery, and local side effects;
- autonomous scheduling, retry, recovery, and restart reconciliation;
- daemon-local configuration, provider runtime state, and SQLite migrations.

Frontend processes, transports, and Hub projections may control or display this
state, but they must not become alternate writers.

## Placement

Keep daemon-owned orchestration, stores, migrations, process lifecycle, and
recovery in this application. Keep adapters thin:

- typed oRPC and compatibility transports translate into the same private
  control service;
- transport handlers do not own policy, persistence, or a second implementation
  of an operation;
- reusable domain rules belong in the existing capability package;
- cross-surface schemas and semantics belong in `spark-protocol`;
- cross-workspace coordination belongs to Hub owners, not the daemon.

Do not move generic local-system primitives or reusable client behavior into the
daemon merely because it is their first caller.

## Durable-state rules

- Treat process restart and client disconnect as normal execution paths.
- Make commands idempotent where delivery or recovery can replay them.
- Fence stale work with the domain's persisted generation, revision, lease, or
  compare-and-swap identity; do not rely on process-local timing.
- Persist a transition before publishing a projection that claims it occurred.
- Preserve cancellation, retry, failure, and partial-completion information;
  never collapse distinct reachable states for UI convenience.
- Keep user-visible Artifacts and internal Evidence in separate stores and ref
  namespaces.
- Never expose credentials, internal evidence bodies, or unrestricted local
  paths through daemon projections.

SQLite schema changes require an explicit migration, deterministic startup
behavior, and tests for existing supported data. Compatibility decoders and
legacy transports preserve their bounded older contract and receive no new
product behavior.

## Testing

Test the owner boundary, not only the happy-path handler. Changes should cover
as applicable:

- transaction failure and retry;
- duplicate delivery or command replay;
- restart reconciliation;
- cancellation races and stale generations;
- migration from supported prior state;
- projection and event ordering;
- source-process lifecycle when process boundaries change.

Use the validation matrix in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#validation), including daemon package
checks and source-process tests for lifecycle changes.
