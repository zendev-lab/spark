# @zendev-lab/spark-system

Filesystem path, private-file permission, command, SQLite, and local runtime primitives shared by Spark packages.

Daemon RPC transport and protocol-aware client code lives in
`@zendev-lab/spark-daemon-client`; this package deliberately has no Spark
workspace dependencies.

## Paths

`resolveSparkUserPaths()` derives Spark-owned user configuration, data, cache, state, and runtime paths. `resolveSparkPaths({ app })` derives Hub/daemon paths from those roots. `resolveSparkHome()` returns the explicit `SPARK_HOME` when configured, otherwise the effective XDG data root for compatibility callers that require one persistent root.

Precedence is explicit API `sparkHome`, then `SPARK_HOME`; when neither is set, Spark follows `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, and `XDG_RUNTIME_DIR` independently. Workspace state remains under each workspace `.spark/`. Public role, skill, and workflow definitions remain under `$HOME/.agents/`.

Retired Pi/component-specific path variables are not active overrides.

See [`../../docs/specs/configuration-and-paths.md`](../../docs/specs/configuration-and-paths.md) for layout, precedence, and migration policy.

This package is part of the Spark monorepo and targets Node 26.

## SQLite migration manifests

The package exports dependency-free strict parsers for Spark owner migration manifests and the hidden exact-artifact database probe protocol. Migration schema v2 separates pre-governance SQL inventory from governed migrations: packaged checksums prove current artifact bytes, while `legacy-unverified` provenance prevents retroactive claims about old database history. Validation covers exact fields, checksum evidence kind/path, SHA-256 formatting, automatic-update eligibility, schema-head ranges, and delayed governed expand/contract relationships. Database execution, canonical schema descriptors, sentinels, and applied-state ledgers remain in each SQLite owner.
