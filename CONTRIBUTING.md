# Contributing to Spark

Thank you for improving Spark. This guide is the shared source for human
contributor setup, development workflow, validation, documentation ownership,
and pull-request expectations. Coding agents must also follow
[`AGENTS.md`](./AGENTS.md).

## Requirements

Source development requires:

- Node.js `>=26 <27`;
- pnpm `>=11 <12`, matching the version pinned in `package.json`;
- the Vite+ `vp` CLI used by repository formatting, lint, and type-aware checks;
- Git.

`pnpm install` runs the `prepare` script and installs the `prek` commit hooks.
Run `prek install-hooks` when hooks are missing from an existing checkout.

## Setup

```bash
git clone https://github.com/zendev-lab/spark.git
cd spark
pnpm install
pnpm run check
```

The source tree is a monorepo of private workspaces that builds one complete
public npm package plus independently installable executable app packages. Do
not treat internal capability, runtime, or adapter workspaces as separately
supported packages.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/spark-cli` | Thin public `spark` command dispatcher |
| `apps/spark-tui` | Native terminal host and interaction adapters |
| `apps/spark-daemon` | Durable sessions, invocations, channels, and execution |
| `apps/spark-hub` | Browser presentation and control |
| `apps/spark-docs` | Public bilingual user documentation |
| `packages/spark-*` | Shared contracts, capabilities, runtimes, clients, and adapters |
| `architecture/packages.json` | Machine-readable package layer, owner, stability, and state-writer inventory |
| `docs/specs` | Normative architecture and behavior contracts |
| `docs/operations` | Operator procedures and validation runbooks |
| `test` | Root integration and cross-package behavior tests |
| `scripts` | Repository checks, packaging, migration, and validation tooling |

For the current package dependency model, read
[`docs/specs/package-architecture.md`](./docs/specs/package-architecture.md).
For command and state ownership, read
[`docs/specs/command-planes.md`](./docs/specs/command-planes.md).

## Choose the owner before changing code

Every stateful domain has one authoritative owner. Put behavior in that owner
and keep transports and presentation layers thin.

| Domain | Authoritative owner |
| --- | --- |
| Sessions, invocations, channels, local execution, retry, and recovery | `apps/spark-daemon` |
| Cross-workspace registry, delegation, delivery, and bounded receipts | Hub modules in `spark-hub-coordination` and `spark-hub-db` |
| Cross-surface schemas and semantics | `packages/spark-protocol` |
| Product extension composition and policy | `packages/spark-extension` |
| Terminal presentation | `apps/spark-tui` behind shared TUI boundaries |
| Browser presentation | `apps/spark-hub` |

When behavior is shared by multiple surfaces, define its schema and semantics in
the existing protocol or owner API before adding surface-specific adapters.
Do not create a second store, scheduler, compatibility implementation, or
frontend-derived state machine.

## Change workflow

1. Start from the intended base and create a focused branch.
2. Identify the authoritative owner and read the relevant specification, nearby
   tests, and package README.
3. Make the smallest owner-aligned change. Avoid unrelated cleanup.
4. Add or update focused tests for behavior, compatibility, failure handling,
   and every newly reachable state.
5. Update public documentation or internal contracts when behavior changes.
6. Run targeted validation, then the applicable repository gates below.
7. Review the complete diff for generated files, secrets, runtime state, and
   accidental package-boundary changes.
8. Open a Draft PR with the motivation, user or developer impact, and exact
   validation performed.

## Validation

`pnpm run check` is the main repository gate. It runs static architecture,
distribution, package-boundary, documentation, formatting, lint, type, unit,
integration, and source-process lifecycle checks.

Use the narrowest command while iterating, then run the broader gate required by
the change:

| Change or purpose | Command |
| --- | --- |
| Format, lint-fix, and typecheck TypeScript and Markdown | `pnpm run fix` |
| Full repository baseline | `pnpm run check` |
| Static architecture, distribution, boundaries, formatting, lint, and types | `pnpm run check:static` |
| Typecheck only | `pnpm run typecheck` |
| Root unit and integration tests | `pnpm test` |
| One root test file | `pnpm test test/name.test.ts` |
| Package-local tests or invariants | `pnpm --filter <package> run test` or `run check` |
| Source dispatcher and daemon lifecycle | `pnpm run test:process:source` |
| Hub browser interactions | `pnpm run test:browser:hub` |
| User documentation | `pnpm run check:docs && pnpm run build:docs` |
| Package dependency boundaries | `pnpm run check:boundaries` |
| Packed public product and clean installation | `pnpm run smoke` |
| Release tarball and manifest | `pnpm run release:pack` |
| High and critical dependency advisories | `pnpm run audit` |
| Advisory hygiene reports | `pnpm run report:hygiene` |

Do not place a `--` separator before a single root Vitest path; Vite+ would
forward it incorrectly.

Browser tests, packed-product smoke tests, mutation continuous evaluation, and
external deployment checks are intentionally not part of every local edit.
Run them when the affected surface or release path requires them, and report
anything that could not be executed.

## Tests and compatibility

- Test observable behavior and owner boundaries rather than mirroring source
  structure.
- Protocol changes require compatibility validation for supported clients and
  persisted data.
- State-machine changes require coverage for every reachable status and
  transition, including retry, cancellation, recovery, and failure.
- Projection tests must derive state from the authoritative owner; prompts,
  transcript text, elapsed time, and browser timers are not execution truth.
- Compatibility adapters preserve a bounded older contract. They must not
  receive new product behavior.
- Golden files are appropriate only when the serialized or rendered output is
  itself part of the contract.

More detailed test ownership and golden-file policy live in
[`docs/operations/test-architecture.md`](./docs/operations/test-architecture.md).

## Architecture changes

Adapters point inward:

```text
apps
  ↓
composition and clients
  ↓
capabilities and runtimes
  ↓
contracts and foundations
```

Foundations must not depend on applications or product-private adapters.
Hub-private packages must not become dependencies of the daemon or shared
Spark packages.

Create a workspace only for a hard runtime, state, permission, protocol,
adapter, or experimental-lifecycle boundary. Otherwise add a module to the
existing owner. Adding, removing, renaming, or reclassifying a workspace
requires updating `architecture/packages.json` and passing the architecture and
boundary checks. Raising a repository growth ceiling requires an architecture
rationale in the same change.

## Documentation ownership

Keep each fact in the narrowest authoritative document and link to it elsewhere.

| Document | Owns |
| --- | --- |
| `README.md` | Stable product positioning, first run, architecture summary, and links |
| `CONTRIBUTING.md` | Human setup, workflow, validation, documentation ownership, and PR conventions |
| `AGENTS.md` | Stable repository-wide constraints for coding agents |
| `SPARK.md` | Project intent, goals, non-goals, open questions, and current direction |
| `apps/spark-docs` | Public installation, workflows, feature guides, CLI, tools, and troubleshooting |
| `docs/specs` | Normative internal contracts and architectural invariants |
| `docs/operations` | Operational procedures, release steps, and validation runbooks |
| Package READMEs | Package-local purpose, API, and implementation guidance |

Do not duplicate exhaustive CLI references, validation command lists, package
inventories, migration histories, or operator procedures in `README.md` or
`AGENTS.md`. Behavioral changes should update the public guide, normative
contract, or operation that owns the behavior.

User documentation is bilingual. Update the English and Chinese versions
together and preserve versioned archives unless the change explicitly targets
an archived release.

## Repository hygiene

- Do not commit secrets, `.env` files, local credentials, or authentication
  material.
- `.spark/`, including `.spark/memory/`, is local runtime state and must remain
  uncommitted unless explicitly exported for a reviewed purpose.
- Legacy `.learnings/` directories are runtime state and must not be added.
- Do not commit generated documentation output, packed tarballs, or local
  reports unless a workflow explicitly defines them as source artifacts.
- Preserve same-line version comments for SHA-pinned GitHub Actions.
- Installation and update code must never rewrite a source checkout.

## Pull requests

Keep PRs focused and explain:

- what changed;
- why the change belongs in the selected owner;
- user or developer impact;
- compatibility, migration, or security implications;
- exact validation performed;
- stack dependencies when the PR does not target `main`.

PR titles are checked by CI. Follow the repository's emoji conventional-title
style, for example:

```text
📝 docs: clarify project entry points
✨ feat(loop): persist cycle review checkpoints
🐛 fix(daemon): reject invalid session state
♻️ refactor(protocol): centralize shared semantics
```

Create a Draft PR until the change and its required validation are complete.
