# @zendev-lab/spark-hub-coordination

Spark Hub coordination logic owns runtime registration/token handling, runtime WebSocket
command delivery, projection ingestion, command outbox writes, event queries, and read-side
Hub query models.

Execution truth stays in the Spark daemon. This package adapts server transports and projection
state; it must not bypass daemon dispatch for runtime work.
