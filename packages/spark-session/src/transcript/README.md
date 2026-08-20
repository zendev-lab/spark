# Spark session transcript store

Append-only DSH session JSONL transcripts owned by Spark Session and shared by
host implementations. Spark implements the `PersistenceBackend` path layout;
`dsh-session-persistence` owns the coordinator and disk format. Transcript v4
uses native DSH surface events. Pi JSONL and the former wrapper are v3 migration
inputs only; daemon startup performs the backed-up, journaled hard cut before
admission.

The package root also owns daemon registry, mailbox, and `session({action})`
state; this subpath owns the transcript codec, migration, and filesystem layout.
