# Session-store import path

The DSH session JSONL transcript store lives at
`@zendev-lab/spark-session/transcript`. This directory is not an implementation.
Registry, mailbox, action-tool, and transcript I/O now share the authoritative
`spark-session` owner while remaining separate package subpaths.
