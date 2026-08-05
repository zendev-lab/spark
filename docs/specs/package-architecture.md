# Package architecture

Spark package boundaries follow execution ownership, state ownership, and
adapter/runtime placement. They do not follow file count alone.

The machine-readable source of truth is
[`../../architecture/packages.json`](../../architecture/packages.json). Every
workspace declares a `layer`, `owner`, `stability`, and authoritative
`stateWriter`. `pnpm run check:architecture` rejects an unclassified workspace,
an undeclared production dependency, a stale export, a second public package,
or growth beyond the current 39/40-workspace budget.

## Governance tooling

Generic monorepo mechanics are delegated to maintained open-source tools:

| Concern | Authority |
| --- | --- |
| inventory JSON shape, required fields, and enums | JSON Schema 2020-12 in `architecture/packages.schema.json`, validated by pinned Ajv CLI |
| dependency-version/specifier consistency across manifests | pinned Syncpack using `.syncpackrc.json` |
| cycles and dependency direction | Dependency Cruiser |
| Spark package identity, owner/state ownership, workspace dependency declarations, budget, frozen compatibility, and product-specific boundaries | `architecture/packages.json` plus the reduced `scripts/check-architecture-ratchets.mjs` |

`pnpm run check:architecture` validates the schema, runs Syncpack, and then
executes the Spark-specific ratchets. `pnpm run check:boundaries` runs
Dependency Cruiser. The custom checker no longer duplicates required/enum
validation or dependency-version consistency. Its workspace-import declaration
check remains because Dependency Cruiser's generic `npm-no-pkg` classification
uses the monorepo root manifest under the current pnpm resolution mode and does
not fail for a dependency missing only from an individual workspace manifest.
Presentation imports are enforced by Dependency Cruiser; the reduced custom
checker covers only the corresponding manifest ownership because import graph
tools do not inspect unused dependency declarations.

Test and mutation discovery follow the same rule. Vitest configs define the
root, process, browser, and capability suites; pnpm recursive `--if-present`
commands discover package-local checks; packages participating in mutation CE
own a standard `test:mutation` script and Stryker config. Historical ownership,
strategy, and mutation-selection ledgers are not parallel workspace inventories.

### Repository script policy

Top-level scripts are permitted only when declarative configuration or an
existing maintained tool cannot express the product contract. The retained
categories are:

- public-product assembly, runtime-closure validation, clean-install smoke,
  release identity, rollback, and mixed-version migration checks;
- Spark-specific AST and compatibility ratchets for Evidence, diagnostics,
  source-mirror tests, and compatibility loaders;
- English/Chinese documentation surface and CLI/help synchronization;
- Lens/capability continuous-evaluation evidence projection;
- live Cue, Zellij, provider, daemon, and renderer acceptance harnesses.

Do not keep one-shot task seeders, completed migration wrappers, detached manual
matrices, or duplicate subprocess wrappers under `scripts/`. Use canonical
Spark task commands for task creation, package-owner migrations for startup
migration, Vitest config for deterministic test selection, and pnpm recursive
scripts for package discovery. Knip remains the advisory dead-file check; a
script that intentionally survives only as an operator command must have a
package script, workflow, test, or operations-document caller.

Manypkg was not selected because its mandatory private-root dependency policy
conflicts with Spark's deliberate root product-composition dependencies. `Sherif`
was not selected because its broader zero-config policy overlaps repository
formatting and dependency-placement decisions instead of replacing a precise
owner. Nx was not adopted: Dependency Cruiser already owns the import graph,
and adding an application framework only to encode tags would increase rather
than reduce the governance surface.

## Dependency direction

```text
apps (CLI / TUI / daemon / Hub)
  ↓
composition + clients (spark-extension / spark-daemon-client)
  ↓
capabilities + runtimes (tasks / sessions / workflows / host / turn / ...)
  ↓
contracts + foundations (spark-protocol / spark-core / spark-system / ...)
```

Adapters point inward. Foundations never point at apps or product-private
adapters. Hub-private packages may be used by Hub, but not by the daemon or
shared Spark packages. The daemon is the authoritative writer for invocation,
session registry, session mail, channel delivery, and execution state; Hub owns
its coordination database and rebuildable projections.

## Naming rules

### Applications and executables

A separately executable surface uses the same hyphenated product name at every
public boundary:

```text
spark-daemon
spark-hub
spark-tui
spark-acp
spark-update
```

The top-level `spark` executable is only a dispatcher. `spark daemon ...`,
`spark hub ...`, and the other canonical surface aliases resolve and execute the
matching `spark-*` companion; they do not import or duplicate the target
application. A retired product name must not remain as another public executable
or dispatcher namespace merely to avoid updating callers.

The Hub source directory and its private database packages retain their
`cockpit` physical names during the first rename step so existing XDG paths,
SQLite files, migrations, deployment scripts, and rollback behavior are not
silently reinterpreted. Their package inventory owner is `hub`; the temporary
`stateWriter: cockpit` marker records this compatible storage identity. A later
idempotent storage/path migration may rename both the paths and writer marker.

### Agent tool packages

Do not add `tools` to every package that happens to expose an agent-callable
operation. Most tools are adapters over an owning domain:

- `spark-files`, `spark-memory`, `spark-tasks`, and `spark-artifacts` remain
  domain packages because they own vocabulary, policy, and state semantics;
- a package whose primary reusable contract is one stateless tool family uses
  the singular form `spark-tool-<family>`;
- `spark-tools-*` is avoided because the plural prefix does not identify an
  owner or boundary. The bare `spark-tools` name is reserved for a future
  composition-only aggregator and must not own behavior.

A rename to `spark-tool-*` therefore requires evidence that the package is a
tool adapter rather than a domain owner. The current `spark-web` search/fetch
capability is the first candidate for a separate `spark-tool-web` migration;
that migration is intentionally outside the Hub/executable rename because it
changes extension specifiers and user configuration compatibility.

## Layer meanings

| Layer | Responsibility | Must not own |
| --- | --- | --- |
| `application` | executable bootstrap, lifecycle, UI, product wiring | reusable domain contracts |
| `composition` | cross-capability extension registration and host policy | generic mechanisms or app internals |
| `client` | protocol-aware transport to an owning service | durable state |
| `runtime` | host-neutral execution of turns, roles, or tasks | product UI and coordination storage |
| `capability` | one domain vocabulary plus its reusable policy/store mechanism | another domain's state |
| `adapter` | integration with a terminal, channel, shell, or external service | cross-domain orchestration |
| `contract` | JSON-friendly wire schemas and compatibility validation | workspace implementation dependencies |
| `foundation` | small dependency-light primitives and host contracts | product policy |
| `private-adapter` | Hub-only storage or projection | daemon/shared ownership |
| `compatibility` | legacy read or wire compatibility inside a current owner | a second implementation package |
| `experiment` | isolated, non-default spike with an explicit graduation decision | production startup |

## Deliberate boundaries

- `spark-protocol` is a pure wire-contract package. It has no production
  dependency on another Spark workspace.
- `spark-system` contains only local-system mechanisms: paths, permissions,
  commands, SQLite opening, strings, and the socket MessagePort adapter. It has
  no Spark workspace dependency.
- `spark-daemon-client` owns the protocol-aware daemon client facade. Typed oRPC
  is its primary transport; the legacy local-RPC client is an internal 0.1.x
  connection fallback for published N-1 compatibility. This keeps daemon calls
  out of the system-primitives package.
- The transport-neutral local control service stays private to
  `apps/spark-daemon`; oRPC and legacy socket adapters share that service and
  cannot own policy, durable state, or alternative handler implementations.
- `spark-extension` owns product extension composition and policy for native
  and structurally compatible hosts. Legacy `pi-extension` specifiers are
  rewritten while reading configuration; there is no facade workspace.
- `spark-cockpit-*` paths are temporary Hub-private compatibility names. Shared
  code must move to a capability or foundation package before daemon/native
  reuse, and no new public API may use Cockpit as the control-plane name.
- Hub's en/zh-CN product catalog lives at the owner-restricted
  `@zendev-lab/spark-i18n/cockpit` compatibility subpath. It has no independent
  runtime, state, permission, or failure boundary. Dependency Cruiser permits
  that subpath only from the Hub application; a future compatibility migration
  may rename the subpath without creating another workspace.
- `spark-acp` is the supported stateless ACP adapter. It depends on
  `spark-daemon-client` and `spark-protocol`, while daemon session/invocation
  stores remain the only writers.
- `spark-lens` owns provider, capability-route, observation, verdict, and
  workspace-revision primitives. It performs no durable writes; the daemon owns
  provider sessions, cancellation, caches, and persisted Lens state.
- `spark-mcp-spike` source remains in place as a sealed experiment, but it is
  excluded from the workspace and package inventory.
- `spark-context` was removed after all callers converged on
  `spark-host/context`; compatibility-only re-export packages are not permanent
  architecture.

The legacy `daemon.sock` path is removed only in a 0.2 release after a migrated
0.1.x has shipped and the old-client/new-daemon, new-client/old-daemon,
exact-tarball product, and updater/rollback gates pass. The compatibility
adapter receives no new product behavior while it waits for that exit gate;
`daemon-orpc.sock` remains the canonical socket after removal.

## When to create or merge a package

Create a workspace only when at least one hard boundary exists:

1. a separately executed or placed runtime;
2. an independent state owner, permission boundary, or failure domain;
3. a protocol/client boundary with multiple surfaces;
4. a replaceable external adapter;
5. a separately validated experimental lifecycle.

Otherwise add a module to the existing owner. Compatibility reads must name
their native owner and remain behind a frozen decoder. Delete a package when it
only re-exports one owner and has no independent runtime boundary.

## Reference patterns

The design borrows three useful patterns without adopting their toolchains:

- [VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)
  separates extension execution from UI placement and distinguishes local,
  web, and remote hosts. Spark similarly keeps TUI/Hub adapters outside the
  daemon-owned execution truth.
- [Backstage package roles](https://backstage.io/docs/tutorials/package-role-migration/)
  make package purpose machine-readable so repository tooling can select the
  right treatment. Spark records role-like layer, owner, stability, and writer
  metadata in one inventory.
- [Nx module boundaries](https://nx.dev/docs/features/enforce-module-boundaries)
  enforce dependency constraints from project tags, including multiple
  dimensions. Spark uses the same principle through the inventory,
  dependency-cruiser, and repository-specific ratchets.

Workspace symlinks can otherwise hide missing manifest edges; npm's
[workspace documentation](https://docs.npmjs.com/cli/using-npm/workspaces/)
explains that workspaces are linked into `node_modules`. Spark therefore checks
that every production import of another workspace is also a declared runtime
dependency.
