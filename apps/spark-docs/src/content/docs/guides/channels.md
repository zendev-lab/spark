---
title: Daemon-global Channels
description: Connect Feishu, Infoflow, and QQ Bot accounts to private daemon-owned Channel Sessions.
---

Spark Channels connect message-platform conversations to the same daemon that
owns Sessions and Invocations. A Channel does not require a registered
Workspace. Each conversation resolves to a top-level daemon Channel Session,
separate from every Workspace Session tree.

## Configure the daemon

Keep account and route configuration in a local file, then replace the daemon's
global configuration deliberately:

```bash
spark daemon channel configure --file <channels.json> --json
spark daemon channel status --json
spark daemon channel reload --json
```

These commands are daemon-scoped and do not accept `--workspace`. Configuration
lives at `<paths.configDir>/channels.json`; use `spark paths --json` to resolve
the effective platform directories. Spark writes the file with mode `0600`.
Never commit it or paste credential values into diagnostics.

Each Feishu, Infoflow, or QQ Bot account runs independently. Spark rejects
duplicate account identities. Reload starts and validates a replacement
generation before switching; if that generation cannot start, the active
generation keeps serving traffic and status reports the failure.

Use the installed command help for the current adapter fields and notify
actions:

```bash
spark daemon channel --help
spark daemon channel notify --action test --json
```

## Conversation identity and storage

Spark identifies an automatic conversation by the stable account identity and
the normalized platform conversation key. Rotating a secret does not change
that identity. Two accounts receiving the same external key still create
different Sessions and cwd directories; automatic ingress never merges them.
Only an explicit binding operation can make multiple conversations share one
Session.

Each Channel Session has a private directory:

```text
<paths.dataDir>/channels/sessions/<sessionId>/workspace
```

The path uses only a validated Spark Session ID, never a provider user, group,
or conversation identifier. Spark creates it with mode `0700` and checks its
real path and directory boundary before every execution. Closing or archiving
the Session does not delete the directory. Transient transport state lives
under `<paths.runtimeDir>/channels/`.

## Delivery and recovery

Spark persists an inbound receipt before admitting its Invocation, so replayed
provider events do not submit duplicate work. Outbound delivery retries only
when the provider proves that nothing was sent or supplies a deduplicated
identity. A dispatched result whose outcome cannot be proven becomes
`uncertain` and is never sent automatically again.

During an upgrade, unambiguous legacy Channel Sessions and configurations are
migrated with backups, a journal, and readback validation. Ambiguous account,
route, secret, Session ownership, or cwd facts fail closed: Channel listeners
remain stopped or degraded while the rest of the daemon stays available.

## Security boundary

A Channel-bound agent receives exactly four canonical tools: `session`, `ask`,
`context`, and `todo`. It cannot use shell, files, Git, GitChange, Workspace or
repository Memory, Task, Role fan-out, assignment, or Workflow execution. Its
`session` access is limited to list and send within the same daemon scope; it
cannot contact Workspace Sessions directly.

Hub exposes Channels on the daemon-level `/settings/channels` page. Select the
installation/runtime explicitly when more than one daemon is connected. Daemon
Channel Sessions appear separately from Workspace conversations, and their
remote summaries omit full cwd, external conversation keys, account identities,
transcripts, and secrets.

For the broader Session model, see [runs and sessions](/guides/runs-and-sessions/)
and [collaboration](/guides/collaboration/). For effective platform roots, see
[configuration and paths](/reference/configuration-and-paths/).
