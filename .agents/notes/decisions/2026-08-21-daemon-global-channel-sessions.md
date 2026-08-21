# 2026-08-21: Daemon-global Channel Sessions

## Decision

Message-platform Channels are daemon-global. A conversation resolves to a
top-level Session with:

```ts
{
  scope: { kind: "daemon", daemonId: installationId },
  lineage: { kind: "root" },
  purpose: "channel",
  roleBinding: { kind: "none" }
}
```

The automatic identity is
`(adapterAccountIdentity, normalizedExternalKey)`. Secret rotation preserves
account identity; duplicate configured identities fail closed. Automatic
ingress does not merge conversations, even when two accounts receive the same
external key. Sharing a Session requires an explicit binding operation.

`spark-channels` is renamed in place to `@zendev-lab/dsh-channels`, preserving
the closed package count. It is a Cordis plugin with typed `ctx.channels` and
one isolated child fiber per configured account. This extends
[`2026-08-20-dsh-cordis-composition.md`](./2026-08-20-dsh-cordis-composition.md):
Cordis owns plugin and transport lifecycle, not durable Channel state. Spark
Session Registry, Invocation, ingress receipts, delivery outbox, retry,
human-interaction records, and SQLite remain authoritative.

Channel configuration is `<paths.configDir>/channels.json` with mode `0600`.
Each Session cwd is
`<paths.dataDir>/channels/sessions/<sessionId>/workspace` with mode `0700`, and
transient state lives under `<paths.runtimeDir>/channels/`. Filesystem paths use
only validated Session IDs. Creation and execution admission reject non-absolute
paths, `/`, links or reparse points, realpath escape, and mismatched directory
boundaries. Close and archive do not delete cwd.

Public Session creation cannot request daemon scope or choose a Channel cwd.
Channel Sessions can list or send only in their own daemon scope. They cannot
directly access Workspace Sessions, GitChange, Workspace or repository Memory,
shell, files, Git, Task, Role fan-out, assignment, or Workflow execution.

## Migration

Registry v8 upgrades only v7. An ordinary legacy Channel child is converted in
place while retaining Session ID, transcript, model, binding, and audit history
only when it has no Role binding, descendants, managed Task/Fleet/Driver/Side
Thread ownership, or GitChange cwd. Otherwise the record receives a redacted
migration-conflict diagnostic and Channels remain degraded.

Legacy global and Workspace Channel configurations merge only when account,
route, and secret facts are unambiguous. Conflicts keep listeners stopped.
Delivery payload v2 and QQ cursors use account identity; human wait and mail
origins carry no Workspace route. A dispatched outbound with no proven outcome
becomes terminal `uncertain` and is never automatically resent. Registry,
configuration, and durable-delivery migrations use backup, journal, staged
readback, idempotent replay, and corruption recovery.

## Rationale

Channel conversations are installation-level external identities. Binding them
to an arbitrary Workspace creates false ownership, prevents a daemon with no
registered Workspace from serving ingress, and makes multi-account routing
depend on local project state. A daemon root Session gives the existing Session
and Invocation owners the correct scope without adding a second registry or
scheduler.

Stable account identity is the smallest key that separates multiple accounts
while allowing credential rotation. Private daemon data directories avoid
granting remote conversations implicit repository access. Starting a complete
replacement generation before switching preserves service during safe reload,
while fail-closed migration avoids guessing credential or delivery truth.

## Consequences

- Daemon composition mounts stores and Session persistence before
  `dsh-channels`, then ingress, delivery/recovery, and human-interaction
  plugins. Shutdown stops ingress, drains accepted handlers, stops reconcilers,
  closes transports, and disposes the root Cordis fiber last.
- Ingress persists its idempotent receipt before Invocation admission.
- CLI Channel controls have no `--workspace`. Hub `/settings/channels` requires
  explicit installation/runtime selection when multiple daemons are present.
- Hub and local projections keep daemon Channel roots separate from Workspace
  Session trees. Remote summaries omit credentials, full cwd, external keys,
  account identities, and transcripts.
- There is no new Workspace-scoped compatibility behavior. Legacy data has only
  the one-time read migration described above.
