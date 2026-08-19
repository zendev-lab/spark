# Spark Web

Local single-workspace browser workbench. It binds loopback only, requires a
one-shot token, and talks to the Spark daemon through `spark-daemon-client`.

```bash
spark web
# http://127.0.0.1:4310/?token=...
```

Non-loopback hosts including `0.0.0.0` are rejected. Hub remains the
cross-workspace browser UI. Shared presentation lives in `@zendev-lab/spark-ui`.
