# Spark Web

Local daemon browser workbench. It binds loopback by default, serves requests
from an actual loopback peer without a token, and talks to the Spark daemon
through `spark-daemon-client`. Its home route is a daemon-wide Session and
Invocation view with pending waits and recent Artifacts. Workspace is
repository/cwd context and an optional grouping axis, not the product root.
Register a local directory from the collapsed context section; Hub origin and
announce stay on daemon login, not the workbench form. Hub is the multi-daemon
proxy plus management, not the cross-workspace owner.

The workbench reads and mutates typed daemon projections for Session history,
tree lifecycle, Ask/Approval, Work, Artifacts, Role/Skill catalogs, model/auth
settings, search, export, Invocation detail, and diagnostics. It never reads
`.spark/` or a Hub database in the browser. Process-local Share pages are
random, read-only, non-persistent HTML; the PWA shell never caches Session,
Artifact, or credential data.

```bash
spark web
# http://127.0.0.1:4310/
```

Binding `0.0.0.0` exposes the workbench on this host's local IPv4 interfaces.
Spark discovers those interface addresses automatically; there is no separate
trusted-host configuration. Requests that actually arrive through loopback
remain tokenless, while remote peers require a daemon access token. The daemon
owns the `daemon-user` token family (hashed storage, optional expiry, immediate
revocation); mint one with `spark daemon access create`. Remote document
navigation opens the Spark Access page, which verifies the token through the
daemon and stores it in an HttpOnly cookie. The `?token=…` navigation carrier
remains available for automation/deep links but is not the primary user flow.

The server validates Host, Origin/Fetch Metadata, and mutation provenance before
authentication. Only loopback and local interface IP literals are accepted as
direct browser authorities; arbitrary DNS names belong behind the Hub rather
than a second trust allowlist. Missing, wrong, expired, and revoked tokens fail
closed, and verification reports unavailable while the daemon cannot be
reached.

```bash
spark web --host 0.0.0.0 --port 4310
```

Use `--hmr` only for local development when watching source changes; it switches
to the Vite development server, while the long-lived default serves the
prebuilt handler without HMR. Settings distinguish API-key providers from OAuth
login at `/settings/oauth/:provider`; the workbench never echoes stored secrets.
Shared presentation lives in `@zendev-lab/spark-ui`. cwd is only a launch
context; an unregistered cwd still starts the workbench and can be registered
from the home page.

See [`PARITY.md`](./PARITY.md) for the capability-to-owner/test/runtime-evidence
index. Rows without real runtime evidence are intentionally not marked complete.
