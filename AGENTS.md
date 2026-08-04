# AGENTS.md

Repository-wide instructions for coding agents working on Spark.

Human contributor setup, development commands, validation, documentation
ownership, and pull-request conventions are maintained in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). Do not duplicate them here. Read
[`README.md`](./README.md) for the public product overview and
[`SPARK.md`](./SPARK.md) for project intent, goals, non-goals, and current
direction.

## Scope and precedence

- This file applies to the entire repository.
- A more specific `AGENTS.md`, when present in a subtree, augments or overrides
  this file for that subtree.
- Follow the user's explicit task and preserve unrelated work.
- Before changing behavior, read the nearest tests and the specification owned
  by that domain.
- Machine-readable inventories and enforced contracts are authoritative over
  copied prose.

## Sources of truth

- Package layer, owner, stability, dependency, and state-writer metadata:
  [`architecture/packages.json`](./architecture/packages.json).
- Package creation and dependency direction:
  [`docs/specs/package-architecture.md`](./docs/specs/package-architecture.md).
- Command placement and state ownership:
  [`docs/specs/command-planes.md`](./docs/specs/command-planes.md).
- Public behavior and current commands: [`apps/spark-docs`](./apps/spark-docs).
- Internal contracts and operator procedures:
  [`docs/README.md`](./docs/README.md).
- Project intent and open design direction: [`SPARK.md`](./SPARK.md).

## Repository-wide invariants

- Every stateful domain has exactly one authoritative owner. Do not create a
  second store, scheduler, state machine, or policy implementation.
- The daemon owns persistent sessions, invocations, channels, local execution,
  autonomous timing, retries, and recovery.
- Hub owns cross-workspace registry, delegation, delivery, idempotency, audit,
  and bounded receipts. It does not own target execution, repositories, local
  artifacts, or internal evidence.
- TUI, the Hub Web UI, channels, ACP, RPC, and compatibility transports are
  presentations or adapters. They must translate through owner APIs and must
  not infer execution state from prompts, transcript text, elapsed time, or
  frontend timers.
- Dependencies point inward: applications may depend on composition, clients,
  capabilities, runtimes, contracts, and foundations; lower layers must not
  import application internals or product-private adapters.
- `packages/spark-extension` is the single Spark product composition root.
  Retain the Pi SDK kernel behind Spark boundaries; do not recreate a separate
  Pi product facade or duplicate extension implementation.
- Cross-surface schemas and semantics belong in `spark-protocol`. Transports
  validate and translate them; they do not define competing behavior.
- Public tools use canonical `tool({ action })` surfaces when actions share one
  domain, state, permission, rendering, and result contract. Do not add public
  aliases for internal names.
- User-facing Artifacts remain `issue | git_change | document`. Artifact and
  internal Evidence stores and ref namespaces remain separate.
- A `git_change` Artifact contains one owning worktree and one native GitHub PR
  stack; individual stack entries are not separate Artifact refs.
- Serialized state and compatibility markers change only through an explicit,
  idempotent migration with compatibility tests.
- Do not commit secrets, `.env` files, `.spark/`, `.spark/memory/`, or legacy
  `.learnings/` runtime state.
- Workspace runtime state belongs under `.spark/`. User-level paths resolve
  through explicit `SPARK_HOME` or the standard XDG roots; public agent assets
  remain under `$HOME/.agents/`, and project assets under `.agents/`.

## Change protocol

1. Identify the authoritative owner before editing.
2. Inspect the relevant specification, package README, nearby tests, and
   machine-readable inventory.
3. Make the smallest change that preserves dependency and state ownership.
4. Move shared validation or semantics into the existing owner or protocol
   before adding another surface adapter.
5. Add focused tests for behavior, failure, compatibility, and every newly
   reachable state.
6. Update the public guide, normative specification, or operation that owns any
   changed behavior. Link instead of copying.
7. Follow the validation matrix in
   [`CONTRIBUTING.md`](./CONTRIBUTING.md#validation) and report exactly what ran.
8. Review the final diff for unrelated edits, generated output, secrets,
   runtime state, and accidental package-boundary changes.

## Architecture discipline

Create a package only for a hard runtime, state, permission, protocol, adapter,
or experimental-lifecycle boundary. Otherwise add a module to the existing
owner. Any workspace addition, removal, rename, or ownership change must update
`architecture/packages.json`.

Hub-private packages retain their physical `spark-cockpit-*` names during the
compatibility period. They may be used by Hub but not by the daemon or shared
Spark packages. Shared packages must not import concrete internals from
`apps/spark-cli`, `apps/spark-tui`, `apps/spark-daemon`, or
`apps/spark-cockpit`.

Compatibility adapters require explicit exit criteria and receive no new
product behavior. Do not introduce an overlapping framework or service unless
an isolated, default-disabled experiment proves the current owner cannot meet a
measured requirement.

## Documentation discipline

Use the ownership table in
[`CONTRIBUTING.md`](./CONTRIBUTING.md#documentation-ownership). In particular:

- keep `README.md` stable and user-oriented;
- keep exhaustive commands and workflows in `apps/spark-docs`;
- keep normative behavior in `docs/specs`;
- keep operator procedures in `docs/operations`;
- keep temporary migration status and open design direction in `SPARK.md`;
- keep this file limited to stable coding-agent constraints.

When changing public documentation, update English and Chinese pages together.
Do not modify archived versions unless the task explicitly targets an archive.
