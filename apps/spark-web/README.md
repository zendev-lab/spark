# Spark Web

Local daemon browser workbench. It binds loopback by default, requires a one-shot
token, and talks to the Spark daemon through `spark-daemon-client`. It lists
every workspace bound to that daemon. Register a local directory from the home
page; Hub origin and announce stay on daemon login, not the workbench form.
Hub is the multi-daemon proxy plus management, not the cross-workspace owner.

```bash
spark web
# http://127.0.0.1:4310/?token=...
```

An explicit non-loopback `--host` also requires one or more `--trusted-host`
values. The server validates Host, Origin/Fetch Metadata, mutation provenance,
and the token. Settings distinguish API-key providers from OAuth login at
`/settings/oauth/:provider`; the workbench never echoes stored secrets. Shared
presentation lives in `@zendev-lab/spark-ui`. cwd is only a launch context; an
unregistered cwd still starts the workbench and can be registered from the home
page.

```bash
spark web --host 0.0.0.0 --trusted-host spark.lan --no-open
```
