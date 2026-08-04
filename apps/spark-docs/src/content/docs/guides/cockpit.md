---
title: Hub Web
description: Start the Hub Web surface, understand its daemon relationship, and secure remote browser access.
---

## When to use Hub Web

Use Hub Web when one terminal session is too narrow. Its workspace workbench
provides:

- **Overview** for connection status and shortcuts,
- a persistent **Conversations** rail for existing and new sessions,
- **Inbox** for questions and approvals,
- **Artifacts** for Issues, PRs, and previews, and
- **Resources** for repositories, documents, links, and tools.

Inside a conversation, the inspector separates Summary, Artifacts, Changes,
and Tasks. Summary shows status and counts first; working directory, model,
session ID, and timestamps remain under Technical details.

The TUI `/inspect` panel is only the current terminal session's local
projection. Hub Web is the browser control surface across sessions and
workspaces. Both submit execution to Spark daemons.

## Start Hub Web

```bash
spark hub
```

Open the URL printed by the command. Hub Web is a control and projection
surface; durable execution remains owned by Spark daemons.

If the page cannot load session data, check both processes separately:

```bash
spark daemon status --json
spark hub
```

## Local and remote access

Loopback use follows the local owner flow. For a non-loopback Hub, prefer an
encrypted private path such as Tailscale, WireGuard, or SSH forwarding.

Mint a one-time Hub browser key on the Hub host:

```bash
spark hub access create
```

Exchange it at `/login`. Workspace-scoped browser access uses a separate
one-time key:

```bash
spark hub workspace access create --workspace <id>
```

Exchange that key at `/{slug}/login`. Treat both keys as secrets. Non-loopback
access requires HTTPS unless you deliberately opt into insecure HTTP on a
trusted private network.

## Register a remote workspace

Authorize the daemon machine, then register each workspace with its own fresh
registration token:

```bash
spark daemon login --server-url https://cockpit.example
spark daemon workspace register . \
  --server-url https://cockpit.example \
  --token <workspace-token> \
  --name <workspace-name>
```

Machine connectivity credentials and one-time workspace registration tokens
have different scopes; do not reuse one as the other.
