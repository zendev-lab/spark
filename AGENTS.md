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
- Local web, the Hub Web UI, channels, ACP, RPC, and compatibility transports are
  presentations or adapters. They must translate through owner APIs and must
  not infer execution state from prompts, transcript text, elapsed time, or
  frontend timers.
- Dependencies point inward: applications may depend on composition, clients,
  capabilities, runtimes, contracts, and foundations; lower layers must not
  import application internals or product-private adapters.
- `packages/spark-extension` is the single Spark product composition root.
  Retain the Pi SDK kernel behind Spark boundaries; do not duplicate Spark
  composition, recreate a second Spark extension implementation, or add a
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

1. Identify the authoritative owner before editing.
2. Inspect the relevant specification, package README, nearby tests, and
   machine-readable inventory.
3. Make the smallest change that preserves dependency and state ownership.
4. Move shared validation or semantics into the existing owner or protocol
   before adding another surface adapter.
5. Add focused tests for observable behavior, state transitions, persisted
   effects, boundary calls, failure modes, schemas, compatibility, and every
   newly reachable state. Do not encode source, prompt, or prose wording in
   literal or substring assertions, snapshots, or fixed hashes unless the exact
   representation or digest is itself an intentional contract, such as a
   complete serialized or rendered artifact, content-addressed identity, or
   integrity/wire digest.
6. Update the public guide, normative specification, or operation that owns any
   changed behavior. Link instead of copying.
7. Follow the validation matrix in
   [`CONTRIBUTING.md`](./CONTRIBUTING.md#validation) and report exactly what ran.
8. Review the final diff for unrelated edits, generated output, secrets,
   runtime state, and accidental package-boundary changes.
9. For a PR, follow the title and body checks documented in
   [`CONTRIBUTING.md`](./CONTRIBUTING.md#pull-requests); the body's `##`
   headings must match the template exactly (CI enforces it).

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

Use the ownership table in
[`CONTRIBUTING.md`](./CONTRIBUTING.md#documentation-ownership):

- keep `README.md` stable and user-oriented;
- keep exhaustive commands and workflows in `apps/spark-docs`;
- keep internal contracts in `.agents/notes/contracts`;
- keep maintainer procedures in `.agents/notes/runbooks`;
- keep dated engineering decisions in `.agents/notes/decisions`;
- keep temporary migration status and open design direction in `SPARK.md`;
- keep this file limited to stable, self-contained standing orders;
- place reusable agent methods or orchestration in their Role, Skill, Workflow,
  or Note owner without making this file depend on those assets.

When changing public documentation, update English and Chinese pages together.
Do not modify archived versions unless the task explicitly targets an archive.
