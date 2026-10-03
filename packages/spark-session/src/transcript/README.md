# Spark session transcript store

Append-only DSH session JSONL transcripts owned by Spark Session and shared by
host implementations. Spark owns the file layout and the daemon adapter implements
DSH read/write handles, live event routing, and durability barriers. Transcript v5
uses DSH log format 4. Pi v3 and native Spark v4 files are migration inputs; daemon
startup performs the backed-up, journaled conversion before admission.
See the [migration boundary](../../README.md) for the historical fork limitation.

The package root also owns daemon registry, mailbox, and `session({action})`
state; this subpath owns the transcript codec, migration, and filesystem layout.
