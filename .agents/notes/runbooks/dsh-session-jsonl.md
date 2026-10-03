# DSH session JSONL hard-cut

Operators snapshot `sessions/` before a daemon that first writes DSH session
JSONL. The Pi JSONL v3 rewrite is one-shot and idempotent on the same path;
there is no sidecar.

Authoritative policy, codec ownership, and rollback:

[`.agents/notes/decisions/2026-08-20-dsh-session-persistence.md`](../decisions/2026-08-20-dsh-session-persistence.md)

Do not treat restoring SQLite as a transcript rollback. Invocation data stays
in SQLite; transcripts live under the session JSONL tree.
