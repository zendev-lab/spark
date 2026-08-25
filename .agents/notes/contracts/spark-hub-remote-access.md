# Spark Hub remote-access contract

This specification owns remote-access **authority, trust, and security
invariants**. User-facing Hub startup, browser-key, workspace-registration, and
reverse-proxy setup belong in the public
[`Hub Web guide`](../../../apps/spark-docs/src/content/docs/guides/hub.md).

## Authority layers

Hub browser authority is progressive and must remain separated:

1. **Hub access** authorizes the control plane. One `hub-user` session family
   covers owners and members; a member's workspace visibility is derived from
   explicit `user ↔ daemon` grants, and each workspace or session resolves to
   the daemon that owns it through the active lease.
2. **Hub↔daemon credentials** (`hub-daemon` family) authorize daemon
   connectivity. Enrollment tokens and device codes are one-shot bootstrap
   exchanges; the access/refresh pair they issue is the daemon's renewable
   credential, canonically recorded in `daemon_credentials`. They are never
   browser credentials.
3. **Daemon-user credentials** (`daemon-user` family) authorize direct Native
   Web / Web DSH access and are owned and verified by the daemon. The Hub must
   not issue, return, or forward them, and a `hub-user` session cannot log in
   to those surfaces.

Minting stays in `@zendev-lab/spark-hub-coordination` on the Hub host. No other
layer creates a minting authority.

A Hub member session must not open workspaces, sessions, artifacts, or SSE
owned by a daemon the member holds no grant for; revoking or moving a
workspace's lease re-derives authorization from the new owning daemon
immediately. Runtime credentials must never be accepted by any browser session
boundary, and browser credentials must never authenticate a daemon uplink.

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

Hub browser keys are one-time credentials with bounded expiry. Every key is
minted with an explicit daemon grant list; exchanging it creates (or reuses) a
member hub-user and grants exactly those daemons before the session is issued.
Replay after successful exchange or explicit revocation fails. There are no
workspace-scoped browser keys or sessions: retired workspace-only sessions and
tokens were revoked by migration and stay invalid.

Grant authority follows the daemon, not a display name. Workspace names and
slugs are display/routing helpers and must not become authority identifiers.

Session refresh rotates credentials. Replaying the previous refresh credential
must fail. Static PWA assets and the minimum login/logout routes may remain
available before authorization, but protected data and event routes require a
session whose grants cover the owning daemon.

## Workspace registration boundary

Machine connectivity credentials and one-time workspace registration tokens are
different authorities and cannot substitute for one another. Each registration
consumes its own token and binds one daemon-owned directory to the existing Hub
workspace identity. Registering a daemon grants it to every active Hub owner
explicitly; further member reach is minted only through daemon-bound Hub access
keys.

Target execution remains daemon-owned. Browser authorization never grants
direct repository, daemon-store, or execution-state access outside the owner
APIs.

## Failure policy

Remote-access configuration fails closed when trust inputs conflict or cannot be
validated. In particular, ambiguous proxy trust, conflicting public origins,
replayed credentials, and cross-scope browser access must be rejected rather
than downgraded to local-owner behavior.
