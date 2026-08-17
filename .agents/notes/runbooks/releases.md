# Releases and managed updates

This runbook owns **release engineering and updater compatibility gates**.
User-facing installation/update commands and path guidance live in the public
[`CLI reference`](../../../apps/spark-docs/src/content/docs/reference/cli.md#managed-installation-and-updates)
and
[`configuration reference`](../../../apps/spark-docs/src/content/docs/reference/configuration-and-paths.md#managed-installation-paths).
Do not maintain a second user command/path catalog here.

Spark production releases use one immutable source:

```text
version-matching Git tag
  → five generated lockstep npm tarballs
  → npm registry
  → published GitHub Release
```

`main`, a source checkout, and a mutable GitHub branch are never production
update sources. Root `package.json#version` is the only version source. A tag
must match it exactly (`vX.Y.Z`).

## Release gate

`.github/workflows/cd-publish.yml` runs the release-specific docs deployment,
Hub container, exact-tarball smoke, and the canonical adjacent product and
database compatibility gate before artifacts are uploaded. The gate queries the
canonical npm registry, selects the newest published stable `@zendev-lab/spark`
version strictly older than the candidate that did not receive an N-1
compatibility exemption, and validates structured product and database reports. A missing, duplicate, skipped, or failed phase and any
unverifiable cleanup stop the release. The normative requirements are defined
by [`release-compatibility.md`](../contracts/release-compatibility.md) and
`architecture/release-compatibility.json`. `pnpm run release:pack` writes the
exact tarballs and manifests; the compatibility reports are written under
`dist/release/` and uploaded with those artifacts.

### One-time 0.4.0 compatibility exemption

`0.4.0` is a coordinated hard cut for view-model protocol v2. The root
`sparkRelease.nMinusOneMigrationExemptions` map is the machine-readable source
for this single exception. The release workflow still verifies exact package
identity, `publint`, installation smoke, same-version daemon/TUI/Hub operation,
artifact hashes, and cleanup, but it does not run the mixed `0.3.x` ↔ `0.4.0`
IPC or migration matrix.

Mixed old/new processes are unsupported. Before applying `0.4.0`, stop all
`0.3.x` Hub, daemon, and TUI processes and capture a verified backup of their
state. The release manifest deliberately declares no executable rollback range;
returning to `0.3.x` requires stopping `0.4.0` and restoring the pre-cutover
backup. The exemption must not be copied to `0.4.1` or any later release. Keep its
manifest entry as the historical exclusion ledger: `0.5.0` must skip the
ineligible `0.4.0` baseline and run the complete product and database matrix
against published `0.3.0`. Once `0.5.0` publishes, it becomes the ordinary
baseline for the next governed release.

The root manifest remains the managed updater contract; the bounded companion
manifests bind each app package to the same version, Git SHA, npm integrity,
asset SHA256, and build fingerprint. Stable versions publish with npm tag
`latest`; prereleases use `next` and a GitHub prerelease. The workflow validates
all five artifacts with `publint` during `pnpm run release:pack` before the
installation smoke. It then publishes in dependency order: daemon and Hub, then
TUI, the real `spark-cli` package, and finally the complete `spark` meta package.
A rerun compares every already-published npm and GitHub asset integrity and
fails closed on any difference.

Production npm publication is OIDC-only. Each of the five npm package
identities must configure trusted publishing for repository
`zendev-lab/spark`, workflow `cd-publish.yml`, and environment `npm-release`.
The publish job obtains short-lived credentials through `id-token: write`; do
not add an npm write token fallback. Configure the GitHub `npm-release`
environment with required reviewers and enable immutable releases in repository
settings. Give the workflow `contents`, `id-token`, and attestation write
permissions only.

### Split-package baseline

`v0.3.0` is the first version in which all five public package identities exist
in lockstep. `@zendev-lab/spark@0.2.1` remains the immutable legacy all-in-one
baseline and must never be overwritten or described as a split-package release.
It is retained here only to explain the compatibility edge used when the
automatic N-1 gate crosses the split-package boundary.

## Managed updater contract

The updater switches immutable installed versions rather than rewriting a source
checkout. The version-independent launcher and service-manager entries resolve
the selected version; updater transaction state is separately owned and exposed
through the public update/status surface.

`notify` is the default policy and `auto` remains opt-in. Automatic application
requires a provably idle daemon and an expand-only candidate and never crosses a
pre-1.0 minor boundary. Global npm, pnpm, Yarn, Bun, and Vite+ installations
remain owned by their package managers; Spark delegates the exact-version change
instead of treating those installations as managed trees.

A candidate is downloaded and verified at one exact version, smoked under an
isolated `SPARK_HOME`, switched atomically, and fenced to the expected build
fingerprint before health is accepted. Three matching health checks are
required. Failure switches back to the rollback version and quarantines the
candidate; retry requires explicit operator intent or a newer version.

Outside an explicitly declared release exemption, database migrations eligible
for automatic update must be expand-only and readable by N-1. Destructive
migrations require manual confirmation. Ordinary same-line rollback switches
executable versions; it never restores an old database snapshot or discards
daemon sessions/messages. The one-time `0.4.0` hard cut instead follows the
stop, backup, and restore procedure above.

## Rollout order

Keep the pre-1.0 rollout deliberately gated:

1. Treat published `v0.4.0` as an immutable hard-cut release, not an eligible
   compatibility baseline.
2. Build `v0.5.0` from the reviewed five-package set and run the exact-tarball
   product, database, and migration matrix against published `v0.3.0`.
3. Exercise managed install plus rollback on macOS; retain a pre-upgrade backup
   even though the governed matrix also proves N-1 reopen/write behavior.
4. Enable the `notify` launchd job by default; keep `auto` opt-in.
5. Open `auto` only after three real governed upgrades and one failed-candidate
   rollback have preserved the daemon database, sessions, transcripts, Hub
   reconnection, and exact successor build identity.

Linux uses the same launcher, layout, lock, transaction, and CLI contracts.
Automated systemd installation is intentionally deferred.
