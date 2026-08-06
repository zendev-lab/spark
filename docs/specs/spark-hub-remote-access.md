# Spark Hub remote access

Hub is local-first and listens on loopback by default. Remote browser authority is progressive:

1. **Hub access** — one-time `spark_hub_auth_…` key exchanged at `/login` for a Hub owner session (control plane).
2. **Workspace access** — one-time `spark_workspace_auth_…` key exchanged at `/{slug}/login` for that workspace only.

Minting stays in `@zendev-lab/spark-hub-coordination` on the Hub host (single source of truth):

```sh
spark hub access create|list|revoke [--label <text>] [--json]
spark hub workspace access create|list|revoke --workspace <id> [--label <text>] [--json]
```

`spark daemon workspace register` may print one workspace browser key as part of binding. Additional browsers use the Hub CLI above—not a second daemon mint path. Prefer workspace **id** as the CLI marker; name/slug are display helpers.

## Direct private-network access

```sh
pnpm --filter @zendev-lab/spark-hub run build
HOST=0.0.0.0 PORT=5173 spark hub
```

Prefer an encrypted private path such as Tailscale, WireGuard, or SSH forwarding. Protected non-loopback requests redirect to `/login` until the browser exchanges a Hub key. Workspace data routes then require `/{slug}/login`.

## Trusted reverse proxy

```sh
HOST=127.0.0.1 \
SPARK_HUB_PUBLIC_URL=https://spark.example.com \
SPARK_HUB_TRUST_PROXY=loopback \
spark hub
```

`SPARK_HUB_PUBLIC_URL` must be an `http(s)` origin at `/`; path mounting is unsupported. `SPARK_HUB_TRUST_PROXY=loopback` is valid only with a loopback listener. The proxy must:

- preserve the public host;
- replace or sanitize forwarding headers;
- send `X-Forwarded-For` and `X-Forwarded-Proto`;
- forward WebSocket upgrades and unbuffered streaming responses;
- reject unknown public hosts.

`SPARK_HUB_PROXY_HOPS` accepts 1-10 trusted entries from the right of `X-Forwarded-For`. A changed public origin changes daemon server identity; re-register affected workspaces with fresh workspace tokens.

Use `SPARK_HUB_PUBLIC_URL=auto` only behind the same trusted loopback proxy when the proxy supplies the hostname.

## Progressive authorization flow

1. On the Hub host, mint a Hub browser key: `spark hub access create`. Open `/login` and exchange it for Hub session cookies (`spark_hub_session` + rotating refresh).
2. Create or open a workspace in the control plane. In connection settings (or via daemon registration), obtain a workspace registration token and run `spark daemon workspace register ... --token ...` from the daemon-owned directory.
3. Successful registration binds that directory and may print a `spark_workspace_auth_...` browser key plus `/{slug}/login`. The key expires after 10 minutes and can be consumed once. Additional browsers use `spark hub workspace access create --workspace <id>`.
4. `/{slug}/login` exchanges the workspace key for workspace session cookies (`spark_workspace_session` + rotating refresh). Refresh rotates both credentials; replaying the previous refresh credential fails.
5. A Hub session alone does not open another workspace’s sessions, artifacts, or SSE. A workspace session for A cannot open workspace B or global Hub settings without a Hub session.

Loopback clients retain the local owner flow for the control plane. Runtime enrollment and runtime WebSocket endpoints under `/api/v1/runtime/` use separate runtime credentials. Static PWA assets plus `/login`, `/{slug}/login`, and `/logout` remain available before the matching browser login.

Use HTTPS or an encrypted overlay network. Revoking an unused browser key prevents its exchange; logout revokes current browser sessions.
