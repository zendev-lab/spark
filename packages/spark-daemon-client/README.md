# @zendev-lab/spark-daemon-client

Protocol-aware transport for calling the local Spark daemon.

This package owns socket client lifecycle, daemon transport errors, and oRPC
method dispatch. Domain request/result contracts remain in
`@zendev-lab/spark-protocol`; generic filesystem and socket adapter primitives
remain in `@zendev-lab/spark-system`.

`ensureSparkDaemonRunning` records the service log offset before launch. When
readiness times out, `SparkDaemonStartupError` reports the last diagnostic
written by that launch and keeps the final socket error as secondary context;
it never presents stale log content as the current startup cause.
