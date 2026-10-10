# Role/Session v6 migration

The daemon performs the Role/Session v6 hard cut before opening its service socket. It migrates the Session registry first, then daemon SQLite structured JSON, and finally structured Workspace/user files. Each store switches atomically and journals independently; this is an admission barrier, not a cross-store transaction. If any step fails, daemon admission stops, and restart recognizes already completed stores idempotently. Clients must not bypass that refusal with a second writer.

## Preflight and backups

- Session registry migration is owned by `SparkSessionRegistry`. A v1-v5 registry is validated, backed up with a journal, written to a staged file, validated again, and atomically replaced.
- SQLite migration uses `VACUUM INTO` before opening its update transaction. Its journal records the database path, backup path, hashes, row count, and exact restore command.
- Structured file migration writes one run below `<SPARK_HOME>/migrations/role-session-v6/`. The run contains `journal.json`, immutable originals, staged replacements, and an executable `restore.sh`.
- Only schema-known RoleRef fields are changed. Free text, prompts, scripts, and transcripts are not rewritten. Evidence retains its `evidence:` ref; changed JSON bodies receive a new content hash and blob path.
- Project and user Role model settings are converted from `version: 1 + roleModels` to strict `version: 2 + modelTypes`. `scout/researcher` collapse to `exploration`, `worker/executor` to `implementation`, Administrator to `coordination`, and Reviewer to `verification`; conflicting models for one target type stop admission.

Successful journals end in `complete`. File migration also updates `<SPARK_HOME>/migrations/role-session-v6/latest.json`.

## Failure recovery

1. Keep the daemon stopped and read the complete startup error. It names the backup or recovery command when manual action is required.
2. Inspect the relevant `journal.json`. A filesystem journal in `rolled_back` means originals were restored automatically; fix the invalid source data and restart. `recovery_required` means automatic rollback failed.
3. For a filesystem `recovery_required` journal, run the exact `restoreCommand` from the journal (the generated `restore.sh`) and verify every restored target before restarting.
4. For SQLite, use the journal's exact `restoreCommand` only while the daemon and every other database writer are stopped. Preserve the failed database separately if it is needed for diagnosis.
5. Restart the daemon. The migration is idempotent: completed v6 state has no legacy aliases or dual-read path, and an already migrated dataset produces no further changes.

Do not copy individual registry records or SQLite rows across the boundary. Restore the complete owned store, correct the source problem, and let daemon admission rerun the migration and validation.
