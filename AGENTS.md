# AGENTS.md

Repository-wide instructions for coding agents working on Spark.

Human contributor setup, development commands, validation, documentation
ownership, and pull-request conventions are maintained in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). Do not duplicate them here. Read
[`README.md`](./README.md) for the public product overview and
[`SPARK.md`](./SPARK.md) for project intent, goals, non-goals, and current
direction. This file is self-contained standing orders. Project Roles, Skills,
Workflows, and Notes may add task methods, but they must not supply prerequisites
for interpreting this file.

## Scope and precedence

- This file applies to the entire repository.
- A more specific `AGENTS.md`, when present in a subtree, augments or overrides
  this file for that subtree.
- Follow the user's explicit task and preserve unrelated work.
- Do not edit implementation or code in the main/default-branch worktree; use a
  dedicated worktree for changes.
- Before changing behavior, read the nearest tests and the specification owned
  by that domain.
- Machine-readable inventories and enforced contracts are authoritative over
  copied prose.
- Keep facts in one authoritative home and link to them instead of copying.

## Sources of truth

- Package layer, owner, stability, state-writer metadata, dependency exceptions,
  Pi ownership, and package budget:
  [`architecture/packages.json`](./architecture/packages.json).
- Public behavior and current commands: [`apps/spark-docs`](./apps/spark-docs).
- Project intent and open design direction: [`SPARK.md`](./SPARK.md).

## Repository-wide invariants

- Every stateful domain has exactly one authoritative owner. Do not create a
  second store, scheduler, state machine, or policy implementation.
- The daemon owns persistent sessions, invocations, channels, local execution,
  autonomous timing, retries, and recovery.
- Hub owns cross-workspace registry, delegation, delivery, idempotency, audit,
  and bounded receipts. It does not own target execution, repositories, local
  artifacts, or internal evidence.
- Local web presents every workspace bound to this daemon. Hub proxies many
  daemons and adds auth, registry, audit, and remote access. Channels, ACP, RPC,
  and other transports are adapters. They must translate through owner APIs and
  must not infer execution state from prompts, transcript text, elapsed time, or
  frontend timers.
- Dependencies point inward: applications may depend on composition, clients,
  capabilities, runtimes, contracts, and foundations; lower layers must not
  import application internals or product-private adapters.
- The daemon's internal product modules are the single Spark product
  composition root. Retain the Pi SDK kernel behind Spark boundaries; do not
  create a second composition package, a Spark extension discovery path, or a
  Spark-owned `package.json#pi` discovery path.
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
- Do not commit secrets, `.env` files, `.spark/`, `.spark/memory/`,
  `.agents/worktrees/`, or legacy `.learnings/` runtime state.
- Workspace runtime state belongs under `.spark/`. User-level paths resolve
  through explicit `SPARK_HOME` or the standard XDG roots; public agent assets
  remain under `$HOME/.agents/`, and project assets under `.agents/`.
  Version `.agents/{roles,skills,workflows}`; leave `.agents/worktrees/` local.

## Change protocol

Use the workflow and validation matrix in
[`CONTRIBUTING.md`](./CONTRIBUTING.md#change-workflow). Resolve routine details
from the owning code and contracts, and continue work within the user's scope.
Ask only when a missing decision materially changes behavior, authority, or
irreversible cost; continue independent work while that decision is pending.

Test observable behavior and boundaries. Do not assert source, prompt, or prose
wording through substrings, snapshots, or hashes unless the exact representation
is an intentional serialization, rendering, identity, or integrity contract.
Run applicable required checks; repeat or broaden them only for new changes,
failures, or unresolved risks. Report what ran and what remains unverified.

For a PR, use an English title in the repository's required format and follow
[`CONTRIBUTING.md`](./CONTRIBUTING.md#pull-requests) for the body template.

## Architecture discipline

Create a package only for a hard runtime, state, permission, protocol, adapter,
or experimental-lifecycle boundary. Otherwise add a module to the existing
owner. Any workspace addition, removal, rename, or ownership change must update
`architecture/packages.json`.

Compatibility adapters require explicit exit criteria and receive no new
product behavior. Do not introduce an overlapping framework or service unless
an isolated, default-disabled experiment proves the current owner cannot meet a
measured requirement.

## Documentation discipline

Follow the documentation ownership table in
[`CONTRIBUTING.md`](./CONTRIBUTING.md#documentation-ownership).
Keep this file limited to stable, self-contained standing orders; reusable
methods belong in their Role, Skill, Workflow, or Note owner without making
standing orders depend on those assets.

When changing public documentation, update English and Chinese pages together.
Do not modify archived versions unless the task explicitly targets an archive.
