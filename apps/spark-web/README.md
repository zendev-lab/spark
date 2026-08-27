# Spark Web

Local daemon browser workbench. It binds loopback by default, requires a daemon
access token for normal workbench requests, and talks to the Spark daemon
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

Session history starts with a bounded latest page. Earlier cursor pages seek
only their indexed JSONL records instead of materializing the full transcript.

```bash
spark web
# http://127.0.0.1:4310/
```

Binding `0.0.0.0` exposes the workbench on this host's local IPv4 interfaces.
Spark discovers those interface addresses automatically; there is no separate
trusted-host configuration. Every normal request requires a daemon access token,
including requests arriving through loopback. The daemon owns the `daemon-user`
token family (hashed storage, optional expiry, immediate revocation). Every
launch prints a usable daemon-issued process token after the listener is ready
and revokes it during normal shutdown; use `spark daemon access create` for a
separately managed token. Document navigation without a valid token opens the
Spark Access page, which verifies the token through the daemon and stores it in
an HttpOnly cookie. The `?token=…` navigation carrier remains available for
automation/deep links but is not the primary user flow. Random read-only Local
Share URLs remain capability links and do not grant workbench access.

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

Native Web composes its cross-route page, form, action, status, dialog, theme,
and responsive language from the shared Spark visual system. Route-local CSS
arranges domain content without creating a competing control or semantic-color
system. The hidden browser file input remains the sole specialized native form
control in route code; its visible trigger is tokenized with the composer.

See [`PARITY.md`](./PARITY.md) for the capability-to-owner/test/runtime-evidence
index. Rows without real runtime evidence are intentionally not marked complete.
