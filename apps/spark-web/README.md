# Spark Web

Local daemon browser workbench. It binds loopback by default, serves loopback
visitors without a token, and talks to the Spark daemon through
`spark-daemon-client`. Its home
route is a daemon-wide Session and Invocation view with pending waits and recent
Artifacts. Workspace is repository/cwd context and an optional grouping axis,
not the product root. Register a local directory from the collapsed context
section; Hub origin and announce stay on daemon login, not the workbench form.
Hub is the multi-daemon proxy plus management, not the cross-workspace owner.

The workbench reads and mutates typed daemon projections for Session history,
tree lifecycle, Ask/Approval, Work, Artifacts, Role/Skill catalogs, model/auth
settings, search, export, Invocation detail, and diagnostics. It never reads `.spark/` or a Hub
database in the browser. Process-local Share pages are random, read-only,
non-persistent HTML; the PWA shell never caches Session, Artifact, or credential
data.

```bash
spark web
# http://127.0.0.1:4310/
```

An explicit non-loopback `--host` also requires one or more `--trusted-host`
values and a daemon access token. The daemon owns the `daemon-user` token
family (hashed storage, optional expiry, immediate revocation); mint one with
`spark daemon access create` and open the printed URL with `?token=…`
appended. The server validates Host, Origin/Fetch Metadata, mutation
provenance, and asks the daemon to verify every presented token — missing,
wrong, expired, and revoked tokens are rejected identically, and the listener
fails closed while the daemon is unreachable. Use `--hmr` only for local
development when watching source
changes; it switches to the Vite development server, while the long-lived
default serves the prebuilt handler without HMR. Settings distinguish API-key providers from OAuth login at
`/settings/oauth/:provider`; the workbench never echoes stored secrets. Shared
presentation lives in `@zendev-lab/spark-ui`. cwd is only a launch context; an
unregistered cwd still starts the workbench and can be registered from the home
page.

```bash
spark web --host 0.0.0.0 --trusted-host spark.lan
```

See [`PARITY.md`](./PARITY.md) for the capability-to-owner/test/runtime-evidence
index. Rows without real runtime evidence are intentionally not marked complete.
