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

`.github/workflows/cd-publish.yml` assumes the source commit has already passed
the ordinary CI checks and validates only release-specific surfaces: the docs
deployment dry run, Hub container build/smoke, exact generated tarballs, and the
declared N-1 migration policy. It does not rerun the repository
source/unit/process or Hub browser suites owned by CI.

For release compatibility, the gate queries the canonical npm registry, selects
the newest published stable `@zendev-lab/spark` version strictly older than the
candidate, and adapts to either the current `spark-hub`
or legacy `spark-cockpit` command contract. An explicit `--baseline-version`
remains available for local incident reproduction, but production publication
does not pin a historical baseline. For the first split release, `v0.3.0`, the
automatic selection resolved to the legacy all-in-one
`@zendev-lab/spark@0.2.1`; the four new package identities had no independently
published N-1 artifact. `pnpm run release:pack` builds once and writes:

- `dist/release/*.tgz`
- `dist/release/*-release-manifest.json`
- `dist/release/release-manifest.json`
- `dist/release/SHA256SUMS`

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
backup. The exemption must not be copied to `0.4.1` or any later release; remove
its manifest entry on `main` when advancing beyond the published `0.4.0` line.

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

1. Stop every `0.3.x` process and capture verified daemon and Hub state backups.
2. Publish the reviewed `v0.4.0` five-package set and matching GitHub Release.
3. Exercise managed install plus restore-based rollback on macOS.
4. Enable the `notify` launchd job by default; keep `auto` opt-in.
5. Open `auto` only after three real same-minor upgrades and one failed-candidate
   rollback have preserved the daemon database, sessions, transcripts, Hub
   reconnection, and exact successor build identity.

Linux uses the same launcher, layout, lock, transaction, and CLI contracts.
Automated systemd installation is intentionally deferred.
