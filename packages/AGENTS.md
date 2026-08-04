# Spark package agent guide

This file extends the repository-wide [`AGENTS.md`](../AGENTS.md) for all
workspaces under `packages/`. A package-local `AGENTS.md` may add narrower
constraints.

## Package boundaries

The machine-readable source of truth is
[`architecture/packages.json`](../architecture/packages.json). Every workspace
must retain an accurate layer, owner, stability, state-writer classification,
and declared dependency set.

Create a package only when it establishes a hard boundary such as:

- a separately executed runtime or placement;
- an independent state owner, permission boundary, or failure domain;
- a protocol or client contract used by multiple surfaces;
- a replaceable external adapter;
- a separately validated experimental lifecycle.

Otherwise add a module to the existing owner. File size, screen layout, or a
single caller is not sufficient reason for a new workspace.

## Dependency direction

Dependencies point inward:

```text
applications
  ↓
composition and clients
  ↓
capabilities and runtimes
  ↓
contracts and foundations
```

- Shared packages must not import concrete `apps/*` internals.
- Contracts and foundations must remain dependency-light and policy-free.
- Adapters translate external or host-specific behavior into an owner API; they
  do not own the domain they adapt.
- `spark-cockpit-*` packages are Cockpit-private and must not become daemon or
  shared-package dependencies.
- Retained Pi SDK adapters must remain behind Spark boundaries and independent
  from Spark product and Cockpit composition.
- Shared packages must not depend on `spark-extension`, the product composition
  root.

Declare every production workspace import in the importing package manifest.
Do not rely on workspace symlinks or root dependencies to hide missing edges.

## Ownership and APIs

- A package owns only the domain named by its inventory classification.
- Do not add a second durable store, scheduler, policy engine, or compatibility
  implementation for another owner.
- Prefer narrow typed exports. Do not expose application glue, private storage,
  or accidental transitive types as public API.
- Place cross-surface wire shapes in `spark-protocol`; place host-neutral
  execution behavior in the existing runtime or capability owner.
- Compatibility code must name its current owner, have explicit exit criteria,
  and receive no new product behavior.
- Public tool families use one canonical action surface when actions share the
  same state, permission, rendering, and result contract.

Workspace additions, removals, renames, owner changes, or dependency changes
must update `architecture/packages.json` and the relevant architecture contract
in the same change.

## Tests and validation

Keep package tests next to the behavior they protect. Test public contracts,
invalid inputs, owner boundaries, and compatibility behavior rather than
mirroring implementation structure.

Follow [`CONTRIBUTING.md`](../CONTRIBUTING.md#validation). Package changes should
run the package-local test or check lane and the repository boundary checks;
architecture or distribution changes require the corresponding static and
product validation gates.
