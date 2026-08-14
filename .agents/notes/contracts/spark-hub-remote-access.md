# Spark Hub remote-access contract

This specification owns remote-access **authority, trust, and security
invariants**. User-facing Hub startup, browser-key, workspace-registration, and
reverse-proxy setup belong in the public
[`Hub Web guide`](../../../apps/spark-docs/src/content/docs/guides/hub.md).

## Authority layers

Hub browser authority is progressive and must remain separated:

1. **Hub access** authorizes the control plane.
2. **Workspace access** authorizes exactly one workspace projection.
3. **Runtime enrollment/WebSocket credentials** authorize daemon connectivity
   and are not browser credentials.

Minting stays in `@zendev-lab/spark-hub-coordination` on the Hub host. Daemon
registration may return a one-time workspace browser credential as a bounded
registration result, but it does not create another minting authority.

A Hub session alone must not open another workspace's sessions, artifacts, or
SSE. A workspace session must not open global Hub settings or another workspace.
Runtime credentials must never be accepted by either browser session boundary.

## Network boundary

Hub is local-first and listens on loopback by default. Remote access must use
HTTPS or an explicitly opted-in insecure path on a trusted private network.
An encrypted private overlay or tunnel is preferred over exposing the Hub
listener directly.

A configured public URL must be an `http(s)` origin rooted at `/`; path mounting
is unsupported. A changed public origin changes daemon server identity and
requires affected workspace registrations to be refreshed deliberately.

## Trusted proxy contract

Proxy trust is explicit rather than inferred from forwarding headers.
`SPARK_HUB_TRUST_PROXY=loopback` is valid only when the Hub listener itself is
loopback-bound. A trusted proxy must:

- preserve the intended public host;
- replace or sanitize forwarding headers;
- provide the trusted `X-Forwarded-For` and `X-Forwarded-Proto` chain;
- forward WebSocket upgrades and unbuffered streaming responses;
- reject unknown public hosts.

`SPARK_HUB_PROXY_HOPS` bounds the trusted entries selected from the right side
of `X-Forwarded-For` to 1–10 hops. Automatic public-URL discovery is valid only
behind the same explicitly trusted loopback proxy.

Untrusted requests must not be allowed to select scheme, host, client address,
or authorization scope through forwarded headers.

## Browser credential contract

Hub and workspace browser keys are one-time credentials with bounded expiry.
They are exchanged for scope-specific browser sessions; replay after successful
exchange or explicit revocation fails.

Workspace credentials are scoped to a stable workspace identity. Name and slug
are display/routing helpers and must not become authority identifiers.

Session refresh rotates credentials. Replaying the previous refresh credential
must fail. Static PWA assets and the minimum login/logout routes may remain
available before authorization, but protected data and event routes require the
matching scope.

## Workspace registration boundary

Machine connectivity credentials and one-time workspace registration tokens are
different authorities and cannot substitute for one another. Each registration
consumes its own token and binds one daemon-owned directory to the existing Hub
workspace identity.

Successful registration may project a workspace browser credential, but target
execution remains daemon-owned. Browser authorization never grants direct
repository, daemon-store, or execution-state access outside the owner APIs.

## Failure policy

Remote-access configuration fails closed when trust inputs conflict or cannot be
validated. In particular, ambiguous proxy trust, conflicting public origins,
replayed credentials, and cross-scope browser access must be rejected rather
than downgraded to local-owner behavior.
