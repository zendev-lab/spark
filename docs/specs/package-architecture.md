# Package architecture

Spark package boundaries follow execution ownership, state ownership, and
adapter/runtime placement. They do not follow file count alone.

The machine-readable source of truth is
[`../../architecture/packages.json`](../../architecture/packages.json). Every
workspace declares a `layer`, `owner`, `stability`, `stateAuthority`, and
`stateRole`. The same inventory owns the layer matrix, exact temporary
exceptions, Pi manifest ownership, package budget, and expected composition
roots. `pnpm run check:architecture` rejects an unclassified workspace, an
undeclared production dependency, a stale export, or a governance violation.

## Governance tooling

Generic monorepo mechanics are delegated to maintained open-source tools:

| Concern | Authority | Primary source |
| --- | --- | --- |
| inventory JSON shape, required fields, and enums | JSON Schema 2020-12 in `architecture/packages.schema.json`, validated by the pinned `check-jsonschema` prek hooks | [check-jsonschema](https://github.com/python-jsonschema/check-jsonschema) |
| dependency-version/specifier consistency across manifests | pinned Syncpack using `.syncpackrc.json` | [Syncpack](https://github.com/JoshuaKGoldberg/syncpack) |
| imports from dependencies missing in the owning workspace manifest | Knip strict unlisted-dependency analysis | [Knip](https://knip.dev/features/monorepos-and-workspaces) |
| cycles and dependency direction | Dependency Cruiser | [Dependency Cruiser](https://github.com/sverweij/dependency-cruiser) |
| Spark package identity, explicit workspace dependency restrictions, generated layer direction, state authority/role, exact exceptions, Pi ownership, package budget, export targets, frozen compatibility, and workspace test and package mutation discovery | `architecture/packages.json`, `architecture/dependency-governance.cjs`, and the Spark-owned architecture checks | Spark-owned contract |
| point-in-time direct dependencies, fan-in/out, cross-owner and cross-state-authority edges, exception budget, SCCs, public exports, violations, and composition roots | `architecture/health.schema.json` plus `pnpm run report:architecture` | gitignored local or CI report |

`pnpm run check:architecture` validates the schemas, runs Syncpack and Knip,
executes the Spark-specific ratchets, and validates a freshly derived health
projection. `pnpm run check:boundaries` runs Dependency Cruiser with its layer
rules generated from the inventory. `pnpm run report:architecture` writes the
same validated projection to `reports/architecture/health.json`; the report is
run evidence, not another source of truth. The custom checker does not duplicate
dependency-version consistency or generic manifest/import analysis.

Test and mutation discovery follow the same rule. Vitest configs define the
root, process, browser, and capability suites; the root unit lane runs every app
and package `test` script through pnpm recursive `--if-present` discovery. The
architecture checker requires a `test` script when any workspace contains tests.
For package-owned mutation CE, either a `test:mutation` script or Stryker config
requires the complete standard command, dependency, and config set. Historical
ledgers are not parallel workspace inventories.

### Repository script policy

Top-level scripts are permitted only when declarative configuration or an
existing maintained tool cannot express the product contract. The retained
categories are:

- public-product assembly, clean-install smoke, release identity, rollback, and
  mixed-version migration checks;
- structured package-inventory comparison and documentation builds;
- Lens/capability continuous-evaluation evidence projection;
- live Cue, provider, daemon, Direct PTY, and renderer acceptance harnesses.

Do not add scripts that parse GitHub Actions or pnpm YAML with regular
expressions, scan source or documentation for words, serialize schemas to look
for field names, or maintain occurrence hashes and compatibility allowlists.
Use the maintained parser or analyzer for that format, or test observable
behavior at the owning boundary.

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
application
  ↓
composition
  ↓
adapter / client / runtime
  ↓
capability
  ↓
contract / foundation / compatibility
```

Dependencies point inward. Same-tier peer groups are explicit: adapters,
clients, and runtimes may collaborate through their declared boundaries, while
contracts, foundations, and compatibility decoders may share dependency-light
primitives. Application-to-application dependencies are denied. A
`private-adapter` is reachable only from inventory-declared private peers or
exact product consumers, and an `experiment` is isolated from production.

A temporary reverse edge is not a layer-wide allowance. It must name one exact
`from` package, `to` package and target layer, plus a reason, owner, existing
exit task, and `nonGrowth: true`. Snapshot schema and semantic validation require `current`, `ceiling`, and the
exact `temporaryDependencyExceptions` ledger length to be equal and no greater
than 6. Cross-revision monotonicity is enforced separately by
`pnpm run check:architecture-transition -- --base-ref <git-ref>`: every current
exact `from->to` exception key must exist in the base inventory, and neither
budget number may increase. A `6/6` to `5/5` reduction is valid only when the
ledger shrinks with it; later restoration, replacement, or revival of an edge
fails the transition gate even when the new snapshot is internally valid. CI
compares pull requests and merge-queue commits with `origin/main`, and compares
main pushes with `HEAD^`. The current exception ledger is read directly from the inventory rather
than copied into this specification.

## Naming rules

### Applications and executables

A separately executable surface uses the same hyphenated product name at every
public boundary:

```text
spark-daemon
spark-hub
spark-tui
spark-acp
spark-mcp
spark-update
```

The top-level `spark` executable is only a dispatcher. `spark daemon ...`,
`spark hub ...`, and the other canonical surface aliases resolve and execute the
matching `spark-*` companion; they do not import or duplicate the target
application. A companion can come from its independently installed app package or from the
complete installation meta package's exact dependencies. `spark hub ...`
therefore resolves the `spark-hub` executable supplied by
`@zendev-lab/spark-hub` without importing the Hub implementation into the
dispatcher. A retired product name must not remain as another public executable
or dispatcher namespace merely to avoid updating callers.

The Hub source directory, private packages, i18n subpath, environment variables,
and state writer all use the canonical `hub` name. The Hub database owner
performs one explicit, idempotent migration from retired Cockpit XDG and
`SPARK_HOME` trees, `cockpit.toml`, and `cockpit.sqlite`. Migration preflights
all destinations, refuses live legacy locks and source/target conflicts, and
rolls back completed renames if a later move fails. Historical SQLite migration
filenames, snapshot-v1 manifests, cookies, and instance IDs remain compatibility
inputs until their documented exit gate; new writes use Hub names only.

### Distributions

A distribution is a generated deployment closure, not a workspace layer. Source
apps remain private even when their compiled entrypoints are assembled into a
public package.

```text
@zendev-lab/spark
  complete-installation meta package; thin spark forwarding launcher only

@zendev-lab/spark-cli
  real spark dispatcher + spark-acp + spark-mcp + spark-update + app companion shims

@zendev-lab/spark-daemon
  spark-daemon + daemon migrations + headless executor

@zendev-lab/spark-tui
  spark-tui

@zendev-lab/spark-hub
  spark-hub + embedded Web build + Hub migrations
```

The root package is the complete-installation meta package and managed-update
identity; it contains no dispatcher implementation. `spark-cli` owns the real
`spark` dispatcher, ACP, MCP and updater entrypoints. Daemon, TUI, and Hub are also
independently installable deployment closures. All public packages share a
version and protocol contract during v0.x. Each app artifact must omit the other
apps' implementation assets, while the CLI and root meta package pin exact
lockstep dependencies instead of repackaging those assets.

Do not create publishable source manifests inside `apps/*` or `packages/*`.
Source workspaces retain `private: true`; the release builder generates all five
manifests under `dist/npm-products/`, computes runtime dependency closures
independently, and publishes exact tarballs from one release tag. The root
manifest owns the `@zendev-lab/spark` name and lockstep version, while source
ownership, process ownership, and distribution placement remain separate axes.

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

## State authority and participation

`stateAuthority` names where canonical writes are accepted: `workspace`,
`user`, `host`, `daemon`, `hub`, or `external`; `none` means the package is
stateless. `stateRole` describes how the package participates:

- `authority` is the executable process that serializes an authority's writes;
- `owner` defines one domain's state vocabulary and write policy;
- `client` delegates writes to another authority;
- `projection` is rebuildable from canonical state;
- `stateless` owns no persistent state.

`stateAuthority: none` is valid exactly with `stateRole: stateless`. The retired
`stateWriter` field is rejected so a package cannot claim a competing second
model. Authority and role are separate: for example, a daemon client names the
daemon authority but participates only as a client.

## Pi ownership and package budget

The inventory assigns `package.json#pi` to the dedicated `pi-spark` product
manifest owner. It also assigns each Pi SDK dependency (`pi-ai`, `pi-tui`, and
`pi-coding-agent`) to one workspace manifest owner. The root compatibility
manifest remains one frozen, exact product-manifest exception until the Pi
manifest cutover task. Existing migration debt may appear only as an exact
non-growing exception with an exit task; a new direct Pi manifest dependency
anywhere else fails architecture validation.

The current package budget is 41. The only pre-approved forty-second workspace
is `@zendev-lab/pi-spark` at `packages/pi-spark`, bound to its inventory exit
task. Another package at 42 or any package at 43 fails closed. Raising or
replacing this budget requires an explicit architecture decision in the
inventory rather than a new constant in a checker.

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
- `spark-hub-*` packages are Hub-private. Shared code must move to a
  capability or foundation package before daemon/native reuse.
- Hub's en/zh-CN product catalog lives at the owner-restricted
  `@zendev-lab/spark-i18n/hub` subpath. It has no independent runtime, state,
  permission, or failure boundary. Dependency Cruiser permits that subpath only
  from the Hub application.
- `spark-acp` is the supported stateless ACP adapter. It depends on
  `spark-daemon-client` and `spark-protocol`, while daemon session/invocation
  stores remain the only writers.
- `spark-lens` owns provider, capability-route, observation, verdict, and
  workspace-revision primitives. It performs no durable writes; the daemon owns
  provider sessions, cancellation, caches, and persisted Lens state.
- `spark-mcp` is the supported stateless, read-only MCP adapter. It projects the
  canonical `spark-memory` workspace store through MCP resources and tools; it
  owns no writes, daemon execution, or second memory store.
- `spark-context` was removed after all callers converged on
  `spark-host/context`; compatibility-only re-export packages are not permanent
  architecture.

The legacy `daemon.sock` path is removed only in a 0.2 release after a migrated
0.1.x has shipped and the old-client/new-daemon, new-client/old-daemon,
exact-tarball node product, and updater/rollback gates pass. The compatibility
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
  right treatment. Spark records layer, owner, stability, state authority,
  state role, and exception metadata in one inventory.
- [Nx module boundaries](https://nx.dev/docs/features/enforce-module-boundaries)
  enforce dependency constraints from project tags, including multiple
  dimensions. Spark uses the same principle through the inventory,
  dependency-cruiser, and repository-specific ratchets.

Workspace symlinks can otherwise hide missing manifest edges; npm's
[workspace documentation](https://docs.npmjs.com/cli/using-npm/workspaces/)
explains that workspaces are linked into `node_modules`. Spark therefore checks
that every production import of another workspace is also a declared runtime
dependency.
