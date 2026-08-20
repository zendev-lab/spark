# Spark extension agent guide

This file extends [`packages/AGENTS.md`](../AGENTS.md) for
`packages/spark-extension`.

## Responsibility

`spark-extension` is the single Spark product composition root. It assembles
existing commands, tools, capabilities, and host policy for Spark-native and
structurally compatible hosts.

Composition belongs here. Generic mechanisms, domain stores, wire contracts,
application UI, and daemon lifecycle do not.

## Boundaries

- Register existing capability and runtime owners; do not reimplement them.
- Keep extension behavior host-neutral and depend on `SparkHostAPI` rather than
  concrete web, Hub, CLI, daemon, or `pi-coding-agent` internals.
- Retain the Pi SDK kernel only behind the established `spark-llm` and related
  Spark boundaries. Own the process-local
  Cordis Context used to mount `dsh-llm`; do not leak `Context` through
  `SparkHostAPI`.
- Do not recreate a second Spark composition root, parallel policy
  implementation, or Spark-owned `package.json#pi` discovery path.
- Builtin loading for Spark-native hosts remains explicit. Compatibility
  discovery may load individual host-neutral capabilities but must not grow a
  separate product surface.
- Durable state and side effects remain with their authoritative capability or
  daemon owner. Extension hooks coordinate through owner APIs.

## Public command and tool design

- Prefer one canonical `tool({ action })` family when operations share a domain,
  state, permission, renderer, and result contract.
- Do not expose internal aliases, implementation names, or host-specific
  variants as additional public tools.
- Keep command placement consistent with the authoritative state owner and
  existing public command surface.
- Shared command, ask, session-view, status, or result semantics must enter
  `spark-protocol` before surface adapters consume them.
- New public behavior requires user-documentation updates in both supported
  languages; do not document it only in extension tests or internal contracts.

Hooks must be bounded, idempotent where replay is possible, and explicit about
whether they steer a current turn, schedule daemon-owned work, or merely render
state. Do not use an extension hook as a hidden scheduler or alternate session
queue.

## Testing

Prefer Spark-native host and contract tests for product behavior. Structural
compatibility tests may prove that another loader speaks the same host contract,
but they must not define a second API.

Cover registration, permission and failure behavior, duplicate loading, command
and tool naming, and owner delegation as applicable. Follow
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#validation) and run the extension
package checks plus boundary checks for dependency changes.
