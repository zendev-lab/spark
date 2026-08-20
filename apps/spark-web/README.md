# Spark Web

Local daemon browser workbench. It binds loopback only, requires a one-shot
token, and talks to the Spark daemon through `spark-daemon-client`. It lists
every workspace bound to that daemon. Hub is the multi-daemon proxy plus
management, not the cross-workspace owner.

```bash
spark web
# http://127.0.0.1:4310/?token=...
```

Non-loopback hosts including `0.0.0.0` are rejected. Shared presentation lives
in `@zendev-lab/spark-ui`. cwd is only a launch context; an unregistered cwd
still starts the workbench.
