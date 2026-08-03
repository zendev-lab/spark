---
title: Cockpit
description: Start the local web surface, understand its daemon relationship,
  and secure remote browser access.
slug: 0.2/guides/cockpit
---

## When to use Cockpit

Use Cockpit when one terminal session is too narrow. Its workspace workbench
provides:

* **Overview** for connection status and shortcuts,
* a persistent **Conversations** rail for existing and new sessions,
* **Inbox** for questions and approvals,
* **Artifacts** for Issues, PRs, and previews, and
* **Resources** for repositories, documents, links, and tools.

Inside a conversation, the inspector separates Summary, Artifacts, Changes,
and Tasks. Summary shows status and counts first; working directory, model,
session ID, and timestamps remain under Technical details.

The TUI `/inspect` panel is only the current terminal session's local
projection. Cockpit is the browser control surface across sessions and
workspaces. Both submit execution to Spark daemons.

## Start Cockpit

```bash
spark cockpit
```

Open the URL printed by the command. Cockpit is a web control and projection
surface; durable execution remains owned by Spark daemons.

If the page cannot load session data, check both processes separately:

```bash
spark daemon status --json
spark cockpit
```

## Local and remote access

Loopback use follows the local owner flow. For a non-loopback Cockpit, prefer an
encrypted private path such as Tailscale, WireGuard, or SSH forwarding.

Mint a one-time Cockpit browser key on the Cockpit host:

```bash
spark cockpit access create
```

Exchange it at `/login`. Workspace-scoped browser access uses a separate
one-time key:

```bash
spark cockpit workspace access create --workspace <id>
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
