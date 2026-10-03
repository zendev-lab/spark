# Native host compaction

Transcript-level compaction for Pi-compatible JSONL sessions.

## Why this stays in daemon product composition

| Candidate package | Why not |
| --- | --- |
| daemon agent runtime | Owns **tool-result** compaction only (`compactToolResultContent`). Transcript compaction needs Session entry trees, branch leaf switching, and `SparkSessionStore` mutation, so it remains composition policy. |
| `@zendev-lab/spark-session` | Owns daemon **registry / mailbox / `session({action})`** and the DSH JSONL transcript codec/migration. Transcript compaction policy remains in product composition until it becomes a DSH plugin. |
| generic capability package | Pulling filesystem JSONL and branch semantics into a shared package would couple every consumer to one Session layout. |

Split here into `types.ts` + `algorithm.ts` until a shared transcript format package exists.
