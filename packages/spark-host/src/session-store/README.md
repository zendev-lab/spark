# Spark host session-store

Append-only DSH session JSONL transcripts shared by Spark host
implementations. Spark implements the `PersistenceBackend` path layout;
`dsh-session-persistence` owns the coordinator and disk format. Transcript v4
uses native DSH surface events. Pi JSONL and the former wrapper are v3 migration
inputs only; daemon startup performs the backed-up, journaled hard cut before
admission.

This package does not own daemon registry, mailbox, or `session({action})`
state; those remain in `@zendev-lab/spark-session`.
