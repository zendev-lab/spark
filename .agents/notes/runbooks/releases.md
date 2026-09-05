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
  → native CLI build matrix
  → generated lockstep product and native npm tarballs
  → npm, GitHub Release, and the versioned Hub container
```

`main`, a source checkout, and a mutable GitHub branch are never production
update sources. Root `package.json#version` is the only version source. A tag
must match it exactly (`vX.Y.Z`).

## Machine-owned release inventory

Do not duplicate distribution or target counts in prose:

- `scripts/npm-distributions.mjs` owns product identities, native targets,
  output names, dependency metadata, and release manifests.
- `package.json#sparkRelease` owns minimum-updater, rollback, migration, and
  explicit N-1 exemption policy.
- `.github/workflows/cd-publish.yml` owns the executable build, smoke,
  publication, attestation, and container order.
- `dist/release/*-release-manifest.json`,
  `dist/release/release-manifest.json`, `native-release-manifest.json`, and
  `SHA256SUMS` are the generated artifact identities checked at publication.

Source workspaces remain private. The release builder creates publishable
manifests from the authoritative inventory; do not add a second publishable
manifest under `apps/*` or `packages/*`.

## Release gate

`.github/workflows/cd-publish.yml` assumes the source commit has already passed
ordinary CI and adds release-specific validation:

1. build the public docs and run the deployment dry run;
2. build and smoke the Hub container;
3. test and build every declared native CLI target, exercise routing, and
   enforce the compressed-size limit;
4. assemble every exact product and native tarball once;
5. verify package identity, manifests, hashes, and generated state;
6. smoke the exact tarball set in clean installations;
7. verify the declared N-1 migration policy; and
8. upload the immutable release artifact set for publication.

The release workflow does not rerun the source/unit/process or Hub browser suites
owned by ordinary CI.

For compatibility, the gate queries the canonical npm registry, selects the
newest published stable `@zendev-lab/spark` version strictly older than the
candidate, and runs the mixed-version matrix unless
`package.json#sparkRelease.nMinusOneMigrationExemptions` explicitly names the
candidate. An explicit `--baseline-version` is for local incident reproduction;
production publication does not pin a historical baseline.

## Local artifact and smoke reproduction

Source-mode `pnpm run release:pack` and `pnpm run smoke` require a native
`spark` binary for every target declared by `scripts/npm-distributions.mjs`.
Place the native-artifact stage output under
`dist/native/<target>/spark`, or point `SPARK_NATIVE_BIN_DIR` at an equivalent
tree. Without those payloads the smoke fails immediately with
`NATIVE_PAYLOADS_MISSING`; that is an unmet release prerequisite, not a
JavaScript build failure.

To reproduce the publication smoke from already-built artifacts, pass the
complete exact tarball set. Use the argument list in
`.github/workflows/cd-publish.yml` as the executable source rather than copying
it into this runbook. A partial tarball set is rejected.

## Publication and provenance

Production npm publication is OIDC-only. Every distribution identity generated
by `scripts/npm-distributions.mjs` must configure trusted publishing for
repository `zendev-lab/spark`, workflow `cd-publish.yml`, and environment
`npm-release`. The publish job obtains short-lived credentials through
`id-token: write`; do not add an npm write-token fallback.

The workflow stages native packages first, then publishes independently
installable apps before the CLI and complete meta package. It compares any
already-published npm or GitHub asset with the generated artifact and fails
closed on a mismatch. The GitHub Release stays draft until npm, provenance,
and the versioned multi-architecture Hub container have succeeded. Stable
versions use `latest`; prereleases use `next` and a GitHub prerelease.

The root manifest remains the managed-updater contract. Companion manifests bind
each app and native payload to the same source version, Git SHA, npm integrity,
asset SHA256, and build fingerprint. GitHub bootstrap archives contain no Node
runtime: the verified native launcher delegates the exact Node product
transaction to npm.

## Managed updater contract

The updater switches immutable installed versions rather than rewriting a source
checkout. Version-independent launcher and service-manager entries resolve the
selected version; updater transaction state is separately owned and exposed
through the public update/status surface.

`notify` is the default policy and `auto` remains opt-in. Automatic application
requires a provably idle daemon, a compatible updater, and an allowed migration;
it never crosses a policy boundary declared manual in
`package.json#sparkRelease`. Global npm, pnpm, Yarn, Bun, and Vite+
installations remain owned by their package managers.

A candidate is downloaded and verified at one exact version, smoked under an
isolated `SPARK_HOME`, switched atomically, and fenced to the expected build
fingerprint before health is accepted. The implementation's health fence
requires matching daemon fingerprints. Failure switches back only when the
declared rollback range permits it and quarantines the candidate; retry requires
explicit operator intent or a newer version.

Database migrations eligible for automatic update must be expand-only and
readable by N-1. A manual migration or explicit hard-cut exemption requires
stopping affected processes and capturing a verified backup before activation.
Rollback never implies that a newer database can be read by an older binary;
restore the pre-cutover backup when the manifest does not declare executable
rollback compatibility.

## Rollout order

For a release that changes deployment generation or migration compatibility:

1. verify the tag, root version, `sparkRelease` policy, and native target
   inventory;
2. stop affected installed processes and capture verified daemon and Hub state
   backups when policy requires it;
3. let the workflow build, smoke, publish, attest, and finalize the immutable
   artifacts;
4. exercise managed install and the declared rollback or restore procedure on
   a representative host; and
5. keep automatic application closed until real upgrades and one
   failed-candidate recovery preserve daemon state, sessions, transcripts, Hub
   reconnection, and exact successor build identity.

Linux and macOS use the same launcher, lock, transaction, and CLI contracts.
Service-manager installation remains platform-specific and must not weaken the
shared updater fences.
