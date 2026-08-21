# @zendev-lab/dsh-channels

Platform channel adapters for Spark IM ingress and outbound notify
(Feishu, Infoflow, QQ Bot).

Adapters perform I/O only: they do not run prompts or own session tables.
Inbound messages normalize to `IncomingMessage` with protocol-aligned
`externalKey` values; the daemon owns session bind/resolve and assignment.

Product surface follows pi-channels (`adapters` / `routes` / `notify` / ingress).
The package is a Cordis plugin with a typed `ctx.channels` service. Each
configured provider account runs in its own child fiber so failures and
disposal remain isolated. Production transports are built in; unit tests use
injectable fake transports so no live credentials are required.

See [`sessions-and-channels.md`](../../.agents/notes/contracts/sessions-and-channels.md).
