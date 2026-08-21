# @zendev-lab/dsh-channels

Platform channel adapters for Spark IM ingress and outbound notify
(Feishu, Infoflow, QQ Bot).

Adapters perform I/O only: they do not run prompts or own session tables.
Inbound messages normalize to `IncomingMessage` with protocol-aligned
`externalKey` values; the daemon owns session bind/resolve and assignment.
Automatic conversation identity is
`(adapterAccountIdentity, normalizedExternalKey)`. Account identity remains
stable across secret rotation, duplicate configured identities fail closed,
and separate accounts never collide on the same external key.

Product surface follows pi-channels (`adapters` / `routes` / `notify` / ingress).
The package is a Cordis plugin with a typed `ctx.channels` service. Each
configured provider account runs in its own child fiber so failures and
disposal remain isolated. Production transports are built in; unit tests use
injectable fake transports so no live credentials are required.

Cordis owns plugin composition and transport lifecycle only. Spark SQLite,
Session Registry, Invocation, delivery outbox, retry, and human-interaction
stores remain authoritative. Daemon-global configuration and Session cwd paths
are defined by the linked normative contract; this package does not read or
write those stores directly.

See [`sessions-and-channels.md`](../../.agents/notes/contracts/sessions-and-channels.md).
