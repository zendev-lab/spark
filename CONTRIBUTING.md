# Contributing to Spark

Thank you for improving Spark. This guide is the shared source for human
contributor setup, development workflow, validation, documentation ownership,
and pull-request expectations. Coding agents must also follow
[`AGENTS.md`](./AGENTS.md).

## Requirements

Source development requires:

- Node.js `>=24`;
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
| `apps/spark-cli` | Native root parser, diagnostics, and companion process router |
| `apps/spark-daemon` | Durable sessions, invocations, channels, and execution |
| `apps/spark-web` | Local daemon browser workbench: every workspace bound to this daemon |
| `apps/spark-web-dsh` | DeepSeek Harness-hosted Spark product workbench |
| `apps/spark-hub` | Multi-daemon proxy, auth, registry, and management UI |
| `apps/spark-docs` | Public bilingual user documentation |
| `packages/spark-*` | Shared contracts, capabilities, runtimes, clients, and adapters |
| `architecture/packages.json` | Machine-readable layer, state-writer, exception, Pi ownership, composition-root, and package-budget inventory |
| `.agents/notes/contracts` | Normative architecture and behavior contracts for implementers |
| `.agents/notes/runbooks` | Maintainer-only procedures and validation runbooks |
| `.agents/notes/decisions` | Dated engineering decisions and durable rationale |
| `.agents/{roles,skills,workflows}` | Versioned agent identities, task procedures, and orchestration |
| `test` | Root integration and cross-package behavior tests |
| `scripts` | Repository checks, packaging, migration, and validation tooling |

For the current package dependency model, read
[`.agents/notes/contracts/package-architecture.md`](./.agents/notes/contracts/package-architecture.md).
For command and state ownership, read
[`.agents/notes/contracts/command-planes.md`](./.agents/notes/contracts/command-planes.md).

## Choose the owner before changing code

Every stateful domain has one authoritative owner. Put behavior in that owner
and keep transports and presentation layers thin.

| Domain | Authoritative owner |
| --- | --- |
| Sessions, invocations, channels, local execution, retry, and recovery | `apps/spark-daemon` |
| Cross-workspace registry, delegation, delivery, and bounded receipts | Hub modules in `spark-hub-coordination` and `spark-hub-db` |
| Cross-surface schemas and semantics | `packages/spark-protocol` |
| Product extension composition and host runtime | `packages/spark-extension` |
| Local daemon workbench | `apps/spark-web` via daemon-client |
| Multi-daemon proxy and management | `apps/spark-hub` |

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
| Complete Repro Golden Journey | `pnpm run test:journey:repro` (requires cue-shell IPC v2 with `session-handshake-required`) |
| Hub and shared Svelte UI browser interactions | `pnpm run test:browser` |
| User documentation | `pnpm run check:docs && pnpm run build:docs` |
| Agent knowledge budgets, routing descriptions, paths, and links | `pnpm run check:agent-knowledge` |
| Architecture inventory, package ratchets, and health projection | `pnpm run check:architecture` |
| Architecture exception non-growth against a Git revision | `pnpm run check:architecture-transition -- --base-ref <git-ref>` |
| Package dependency boundaries | `pnpm run check:boundaries` |
| Write the gitignored architecture health JSON | `pnpm run report:architecture` |
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
[`.agents/notes/contracts/test-architecture.md`](./.agents/notes/contracts/test-architecture.md).

## Architecture changes

Dependencies point inward:

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

The inventory generates the layer rules used by Dependency Cruiser. Do not copy
package-name layer policy into `.dependency-cruiser.cjs`. A temporary reverse
edge must be an exact, non-growing inventory exception with a reason, owner, and
existing exit task; never widen a complete layer pair for migration debt.
Hub-private packages must not become dependencies of the daemon or shared Spark
packages.

Create a workspace only for a hard runtime, state, permission, protocol,
adapter, or experimental-lifecycle boundary. Otherwise add a module to the
existing owner. Adding, removing, renaming, or reclassifying a workspace
requires updating `architecture/packages.json` and passing the architecture and
boundary checks. The budget is closed at 42; the machine-readable inventory
owns the current count and rationale. Raising or replacing that budget requires
an architecture rationale and inventory change.

## Documentation ownership

Keep each fact in the narrowest authoritative document and link to it elsewhere.
The boundary is based on the question being answered, not merely the directory
name:

```text
apps/spark-docs              → How do I use Spark?
.agents/notes/contracts      → What must Spark guarantee?
.agents/notes/runbooks       → How do maintainers validate, migrate, deploy, or release it?
.agents/notes/decisions      → Why did this dated engineering decision change?
```

| Document | Owns |
| --- | --- |
| `README.md` | Stable product positioning, first run, architecture summary, and links |
| `CONTRIBUTING.md` | Human setup, workflow, validation, documentation ownership, and PR conventions |
| `AGENTS.md` | Stable repository-wide constraints for coding agents |
| `SPARK.md` | Project intent, goals, non-goals, open questions, and current direction |
| `apps/spark-docs` | Public installation, workflows, command/tool references, user-visible configuration/paths, client setup, and troubleshooting |
| `.agents/notes/contracts` | Normative ownership, state-machine, protocol, persistence, and compatibility invariants |
| `.agents/notes/runbooks` | Maintainer procedures, release/deployment gates, migration execution, incident handling, and validation runbooks |
| `.agents/notes/decisions` | Dated engineering decisions and their durable rationale |
| `.agents/AGENTS.md` | Agent knowledge classification and progressive-disclosure rules |
| Package READMEs | Package-local purpose, API, and implementation guidance |

Do not maintain the same catalog in two documentation surfaces. Public command
syntax/examples, agent-tool catalogs, user-visible path guidance, and ACP/MCP
client setup belong in `apps/spark-docs`. Specs may mention those names only as
part of an invariant; runbooks may invoke them only as steps in a maintainer
procedure. Link to the public owner instead of copying a second usage section.

Conversely, public docs should describe observable behavior rather than copying
internal package ownership, state-machine transitions, CI matrices, test IDs,
or release-engineering details. When exact information is available from
runtime help/status/path inspection or a machine-readable inventory, teach or
link to that authoritative surface instead of duplicating a long Markdown list.

Do not duplicate exhaustive CLI references, validation command lists, package
inventories, migration histories, or operator procedures in `README.md` or
`AGENTS.md`. Behavioral changes should update the public guide, normative
contract, or operation that owns the behavior.

Pull-request sequencing, issue status, delivery notes, completed-work recaps,
and active backlogs belong in the PR, issue tracker, or Spark runtime state—not
in Agent Notes or package READMEs. Dated decisions retain only durable rationale;
unresolved project-level direction remains in `SPARK.md`.

Local timings, mutation scores, current readiness output, and other run results
belong in CI artifacts or gitignored local reports. Runbooks document how to
run and interpret the check. Likewise, exact command and tool inventories are
owned by runtime help and active schemas; public docs teach discovery and stable
semantics instead of maintaining a second exhaustive catalog.

Vendor notices and licenses, checked-in protocol fixtures, test snapshots, and
source-generation notes may remain next to the code they constrain. They are
source contracts, not user or project-status documentation.

User documentation is bilingual. Update the English and Chinese versions
together and preserve versioned archives unless the change explicitly targets
an archived release.

## Repository hygiene

- Do not commit secrets, `.env` files, local credentials, or authentication
  material.
- `.spark/`, including `.spark/memory/`, is local runtime state and must remain
  uncommitted unless explicitly exported for a reviewed purpose.
- Project `.agents/{roles,skills,workflows}` definitions are source and should
  be committed. `.agents/worktrees/` is machine-local Git worktree runtime and
  must remain uncommitted.
- Legacy `.learnings/` directories are runtime state and must not be added.
- Do not commit generated documentation output, packed tarballs, or local
  reports unless a workflow explicitly defines them as source artifacts.
- Preserve same-line version comments for SHA-pinned GitHub Actions.
- Installation and update code must never rewrite a source checkout.

## Pull requests

Keep pull requests focused and explain:

- what changed;
- why the change belongs in the selected owner;
- user or developer impact;
- compatibility, migration, or security implications;
- stack dependencies when the PR does not target `main`.

Repository CI owns automated validation reporting; the PR body does not need to
duplicate command lists or test counts. Use `Notes` for manual checks, known
limitations, or exceptions that CI cannot express.

PR titles are checked by CI. Follow the repository's emoji conventional-title
style, for example:

```text
📝 docs: clarify project entry points
✨ feat(loop): persist cycle review checkpoints
🐛 fix(daemon): reject invalid session state
♻️ refactor(protocol): centralize shared semantics
```

PR bodies are also checked by CI against `.github/pull_request_template.md`:
the body's `##` headings must be a subset of the template's headings, appear in
template order, and include every required heading (`动机`, `解决方案`). Do not
invent extra `##` sections — fold content such as validation results into the
required sections instead. Optional template headings (`说明`, `后续工作`) are
declared with `<!-- pr-body:optional -->` in the template and may be omitted.

Create a Draft PR until the change and its required validation are complete.
