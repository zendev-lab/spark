# Spark host session-store

Append-only DSH session JSONL transcripts shared by Spark host
implementations. Spark implements the `PersistenceBackend` path layout;
`dsh-session-persistence` owns the coordinator and disk format. Pi JSONL v3
files are migrated in place, idempotently, on first load.

This package does not own daemon registry, mailbox, or `session({action})`
state; those remain in `@zendev-lab/spark-session`.
