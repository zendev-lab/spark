# Releases and managed updates

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

`.github/workflows/cd-publish.yml` runs the complete repository gate, Hub
browser tests, exact-tarball product smoke, the N-1 daemon IPC matrix, and the
N-1 Hub database migration/readability matrix. The gate queries the canonical
npm registry, selects the newest published stable `@zendev-lab/spark` version
strictly older than the candidate, and adapts to either the current `spark-hub`
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

The root manifest remains the managed updater contract; the bounded companion
manifests bind each app package to the same version, Git SHA, npm integrity,
asset SHA256, and build fingerprint. Stable versions publish with npm tag
`latest`; prereleases use `next` and a GitHub prerelease. The workflow validates
all five artifacts before publishing in dependency order: daemon and Hub, then
TUI, the real `spark-cli` package, and finally the complete `spark` meta package.
A rerun compares every already-published npm and GitHub asset integrity and fails
closed on any difference.

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

## Managed layout

`spark install --managed` creates:

```text
$XDG_DATA_HOME/spark/versions/<version>/
$XDG_DATA_HOME/spark/versions/current
$XDG_CONFIG_HOME/spark/update.toml
$XDG_STATE_HOME/spark/update/
$XDG_CACHE_HOME/spark/update/
$PREFIX/bin/spark
```

The executable under `$PREFIX/bin` is version-independent. launchd and daemon
restart helpers always reference it. The updater owns update state; daemon and
Hub only read its projection.

Default policy:

```toml
policy = "notify"
channel = "latest"
checkIntervalHours = 24
```

`SPARK_UPDATE_POLICY` and `SPARK_UPDATE_CHANNEL` override the file. `manual`
disables background network checks. `auto` is opt-in, requires a provably idle
daemon and an expand-only candidate, and never crosses a pre-1.0 minor
boundary.

Useful commands:

```text
spark update status --json
spark update check
spark update apply 0.1.1 --yes --wait
spark update rollback --yes --wait
spark update retry 0.1.1 --yes
spark update configure --policy notify --channel latest --interval-hours 24
spark version --json
```

An update downloads and verifies one exact npm version, runs candidate smoke
under an isolated `SPARK_HOME`, switches `current` atomically, and fences daemon
restart to the target build fingerprint. Three matching health checks are
required. Failure switches back to the rollback version and quarantines the
candidate; retry requires an explicit command or a newer version.

For global npm, pnpm, Yarn, Bun, and Vite+ installs, the package manager remains
the installation owner. Spark delegates an exact-version install, verifies the
new build through the stable command, safely hands off the daemon, and restarts
Hub only when its background web service was already running. The single
launchd tick wakes periodically, while `checkIntervalHours` gates registry
traffic to the configured daily cadence.

Database migrations eligible for automatic update must be expand-only and
readable by N-1. Destructive migrations require manual confirmation. Rollback
switches executable versions; it never restores an old database snapshot or
discards daemon sessions/messages.

## Rollout order

Keep the pre-1.0 rollout deliberately gated:

1. Land build fingerprints, target-fenced daemon restart, and `daemon sync --wait`.
2. Publish the reviewed `v0.3.0` five-package set and matching GitHub Release.
3. Exercise managed install plus manual apply/rollback on macOS.
4. Enable the `notify` launchd job by default; keep `auto` opt-in.
5. Open `auto` only after three real upgrades and one failed-candidate rollback
   preserve the daemon database, sessions, transcripts, Hub reconnection,
   and exact successor build identity.

Linux uses the same launcher, layout, lock, transaction, and CLI contracts.
Automated systemd installation is intentionally deferred.
