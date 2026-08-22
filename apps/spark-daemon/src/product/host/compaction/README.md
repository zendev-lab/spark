# Native host compaction

Transcript-level compaction for Pi-compatible JSONL sessions.

## Why this stays in daemon product composition

| Candidate package | Why not |
| --- | --- |
| `@zendev-lab/spark-turn` | Owns **tool-result** compaction only (`compactToolResultContent`). Transcript compaction needs session entry trees, branch leaf switching, and `SparkSessionStore` mutation — turn-loop scope would widen incorrectly. |
| `@zendev-lab/spark-session` | Owns daemon **registry / mailbox / `session({action})`** and the DSH JSONL transcript codec/migration. Transcript compaction policy remains in product composition until it becomes a DSH plugin. |
| `@zendev-lab/spark-host` | Host-neutral ExtensionAPI runtime; pulling filesystem JSONL + Pi branch semantics would couple every host to one session layout. |

Split here into `types.ts` + `algorithm.ts` until a shared transcript format package exists.
