# spark-core

Spark **host contract + lightweight primitives** shared by daemon product
composition and host-neutral capability adapters.

This package is the renamed `@zendev-lab/spark-extension-api`. It is **not** a
revival of the retired workspace capability bag formerly named `spark-core`.

## Why this package exists

Before this package, every Spark host capability adapter (`@zendev-lab/spark-ask`,
`@zendev-lab/spark-graft`, and `@zendev-lab/spark-roles`) maintained its own `pi-types.d.ts` shim
that re-declared a slice of `SparkHostAPI` via `declare module
"@earendil-works/pi-coding-agent"`. That meant:

- Five copies of overlapping but slightly drifting types.
- A hard pin on the `@earendil-works/pi-coding-agent` module name even when
  the runtime never imported a value from it.
- No single file to update when the surface changes.

`@zendev-lab/spark-core` collapses those copies into one source of truth. Each
capability adapter now does:

```ts
import type { SparkHostAPI, ToolConfig } from "@zendev-lab/spark-core";
```

and the same code runs on either host.

## What is exported

The package is mostly TypeScript declarations for `SparkHostAPI` and related
shapes, plus a small set of dependency-light runtime helpers (refs, stable IDs,
JSON file IO, copy-language detection, and workspace Spark state path helpers
`sparkStateRootPath` / `sparkWorkspaceStatePath`). Host implementations speak
supersets of these types:

- `SparkInvocationService` is the surviving immutable Cordis-facing contract:
  daemon admission freezes one Session/Invocation/attempt snapshot plus narrow
  process-local ports. The plugin mechanism remains in `spark-turn` until the
  legacy host contracts are evacuated and this package can be renamed in place
  to `spark-invocation`.

- Spark native host family — `@zendev-lab/spark-host` provides `SparkHostRuntime`, implementing the retained
  surface needed by `@zendev-lab/spark-ask`, `@zendev-lab/spark-roles`,
  `@zendev-lab/spark-graft`, and daemon product composition,
  plus host-only helpers for keybindings, message renderers, provider/model
  registry adapters, session glue, and native UI bridges.
- Tests and host-neutral adapters may supply the same structural methods without
  creating another product composition or a runtime dependency on
  `pi-coding-agent`.

## Contract rules

1. **Every method is optional.** Capability adapters must guard each call; hosts
   may implement only the slice they care about.
2. **Adding a method is a contract change.** Update both hosts and the
   `test/spark-host-contract.test.ts` contract tests in the same
   change set.
3. **Keep the runtime surface tiny.** Prefer types; only add dependency-light
   helpers that belong next to the host contract.
4. **Keep slices narrow.** If a feature is only needed by the native Spark host,
   put it behind host-only helpers in `apps/spark-daemon/src/product/host/`
   rather than widening this contract. If a capability adapter needs it on
   both hosts, add the smallest optional method here and test both hosts.

## Hosts

| Host                                      | Status                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `@zendev-lab/spark-host` SparkHostRuntime | Retained host surface implemented for daemon-supervised headless execution |

## Adding a new capability

1. Decide whether the capability belongs in the shared host contract or is host-only
   Spark host behavior. Host-only behavior should stay out of this package.
2. Add shared methods/types to `src/index.ts` with `optional` semantics.
3. Update the contract test (`apps/spark-daemon/src/product/__tests__/spark-host-contract.test.ts`) to
   exercise the runtime and test host via the new shape.
4. Implement on the runtime and test host; only land the change once both pass.
5. If the change touches native Spark boot/loading, also run the relevant
   daemon product tests (capability registration, runtime contract, and bootstrap).
