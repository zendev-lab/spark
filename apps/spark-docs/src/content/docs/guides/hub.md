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
- **Artifacts** for Issues, Git changes, and Documents, and
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

If this installation previously ran Spark Cockpit, stop it before starting Hub.
The first Hub database open migrates the retired XDG or `SPARK_HOME` app tree,
including `cockpit.toml` and `cockpit.sqlite`. Migration refuses live legacy
locks and source/target conflicts instead of overwriting state. See
[Configuration and paths](/reference/configuration-and-paths/) for the complete
mapping and environment-variable compatibility window.

If the page cannot load session data, check both processes separately:

```bash
spark daemon status --json
spark hub
```

## Settings and access scope

A Hub owner sees control-plane, active-workspace, and connected-daemon settings
together in the console. A workspace-scoped browser session sees only that
workspace's settings; control-plane and daemon-wide settings are omitted.

Daemon settings are routed through the active workspace lease. The Models page
uses the latest Hub projection for a fast first paint, offers an explicit daemon
refresh, and labels a provider as connected only when credentials are present.
Use **Quick test** to send one bounded, tool-free request to the selected model
and verify that it can actually answer. Invocation diagnostics use the same
runtime connection and do not require a daemon socket on the Hub host.

**Hub updates** reports only the Hub installation. Each connected daemon is
updated independently on the machine where it runs.

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

## Trusted reverse proxy

Keep Hub itself on loopback and terminate public HTTPS at the trusted proxy:

```bash
HOST=127.0.0.1 \
SPARK_HUB_PUBLIC_URL=https://spark.example.com \
SPARK_HUB_TRUST_PROXY=loopback \
spark hub
```

`SPARK_HUB_PUBLIC_URL` must be an `http(s)` origin at `/`; path mounting is not
supported. The proxy must preserve the intended public host, sanitize forwarding
headers, send `X-Forwarded-For` and `X-Forwarded-Proto`, forward WebSocket
upgrades and unbuffered streaming responses, and reject unknown public hosts.

Use `SPARK_HUB_PROXY_HOPS=1..10` when more than one trusted proxy is in the
forwarding chain. `SPARK_HUB_PUBLIC_URL=auto` is only appropriate behind the
same trusted loopback proxy. Changing the public origin changes daemon server
identity, so re-register affected workspaces deliberately.

## Register a remote workspace

Authorize the daemon machine, then register each workspace with its own fresh
registration token:

```bash
spark daemon login --server-url https://hub.example
spark daemon workspace register . \
  --server-url https://hub.example \
  --token <workspace-token> \
  --name <workspace-name>
```

Machine connectivity credentials and one-time workspace registration tokens
have different scopes; do not reuse one as the other.
