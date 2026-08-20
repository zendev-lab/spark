# Pi product compatibility

## Scope

Spark retains the Pi SDK **kernel** behind the `spark-llm` boundary:
`@earendil-works/pi-ai` is owned by `@zendev-lab/spark-llm`. This document
governs the retired Pi **product loader** surface. It does not govern the
retained SDK kernel. `spark-text` is Spark-owned terminal-column layout and is
not a Pi SDK boundary.

The dedicated Pi product adapter (`packages/pi-spark`) has been removed. There
is no Spark-owned `package.json#pi` discovery path. Spark-native local web,
Hub, channels, ACP, and daemon interfaces are the supported product surfaces.

## Retired product loader

The former compatibility entry must not return. Do not add a `package.json#pi`
manifest, recreate a Pi product facade, or register Spark driver lifecycle,
Goal, Loop, or Repro into an external Pi loader.

`spark-files` remains a Spark-native host surface. External Pi owns its own
file tools; Spark must not register file operations as a Pi product
replacement.

## Remaining SDK kernel

`architecture/packages.json` `governance.piOwnership` is the enforced gate:

- `productManifestOwner` is `null`;
- the only allowed Pi SDK dependency is `@earendil-works/pi-ai`, owned by
  `@zendev-lab/spark-llm`;
- `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` must not
  appear as workspace dependencies.

A new direct Pi manifest dependency anywhere else fails architecture
validation unless it is an exact, non-growing inventory exception with an
exit task.

## Verification

The enforced gates are:

- architecture ratchets reject `package.json#pi` on every workspace;
- `piOwnership.sdkDependencies` matches live workspace manifests;
- `no-direct-pi-tui` forbids importing `@earendil-works/pi-tui`.
