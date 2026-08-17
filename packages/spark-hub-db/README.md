# @zendev-lab/spark-hub-db

Hub-private SQLite migrations, database open helpers, Kysely dialect integration, and database types.

This package owns the SQL migrations and client helpers for the Spark Hub coordination plane. Daemon integration tests may open the same schema for coordination-plane fixtures.

## Migration compatibility

`src/migrations/manifest.json` is the packaged, strict migration contract. The pre-governance `0001`–`0022` SQL inventory is recorded separately from future governed migrations: its SHA-256 digests prove the bytes in the package, not the bytes historically applied to an older database. Accordingly those entries use `provenance: legacy-unverified`, `introducedRelease: null`, and are not eligible for automatic adjacent update. Fresh full-schema bootstrap may execute the complete inventory explicitly; a database without the governance marker enters legacy adoption; only a marked managed database may enter adjacent update, where every pending entry must be a governed automatic expand. Existing rows adopted from the old `schema_migrations` ledger remain `legacy-unverified` rather than receiving retroactive checksum evidence. Unknown/future, dirty/failed, and modified clean records fail closed. The executor owns its SQLite transaction and uses `BEGIN IMMEDIATE` for process-safe serialization.
