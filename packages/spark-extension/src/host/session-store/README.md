# Session-store import path

The host-neutral DSH session JSONL transcript store lives at
`@zendev-lab/spark-host/session-store`. This directory is not an implementation.
It remains distinct from `@zendev-lab/spark-session`, which owns daemon
registry, mailbox, and `session({action})` state rather than local host
transcript I/O.
