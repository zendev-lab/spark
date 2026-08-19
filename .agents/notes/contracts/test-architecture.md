# Test architecture

Spark tests should identify the contract they protect and run at the closest owning boundary.
The root suite is for cross-package behavior; package-local behavior belongs beside the package so
its normal check and mutation evaluation can exercise it.

## Lanes

| Lane | Location | Contract |
| --- | --- | --- |
| Package unit / contract | `packages/*/src/**/*.test.ts` | Pure behavior, schemas, state transitions, adapter contracts |
| App unit / integration | `apps/*/src/**/*.test.ts` | App-owned composition, persistence, process, route, and rendering behavior |
| Root integration | `pnpm test` (`test/**/*.test.ts`, excluding `test/process/` and `test/journey/`) | Behavior that genuinely crosses package or app ownership boundaries |
| Source process | `pnpm run test:process:source` (`test/process/**/*.test.ts`) | Exact source-distributed executable lifecycle under isolated local state |
| Repro Golden Journey | `pnpm run test:journey:repro` (`test/journey/**/*.test.ts`) | Complete trusted product path through real source processes and cue-shell |
| Browser component | `pnpm run test:browser:hub` | Browser-only interaction and DOM behavior |
| Product process | `pnpm run smoke` | Packed, clean-installed public product lifecycle and Hub HTTP/client-asset smoke |
| Capability CE | `pnpm run test:capability:ce` | Repeated zero-token Goal, Loop, and Repro sentinels, inventory stability, flakes, and duration variance |
| Repro live capability | `pnpm run test:capability:repro-live` | Credentialed real-model multi-repository discovery, Role/tool choice, Evidence, compaction, and five-checkpoint continuation |
| Mutation CE | `pnpm run test:mutation` | Whether focused package tests detect plausible implementation faults |

Do not move package unit tests into `test/` merely to share setup. Put reusable fixtures or a
contract-suite function at the owning package boundary, then run the same contract against each
implementation. For example, daemon Loop stores bind
`apps/spark-daemon/src/store/loops.contract.ts` to a fresh implementation harness; process-level
startup and drain checks remain in the daemon integration lane rather than being mocked into that
store contract.

Keep Node SSR tests for deterministic rendered states and browser tests for behavior that requires
focus, events, layout, or browser APIs. Browser tests remain outside the default and unit suites so
Chromium setup does not slow down package tests; CI labels them as a dedicated smoke step.

Native TUI validation has two app-local lanes. The component harness drives the real app/editor over
a renderer-neutral fake `TUI` boundary for deterministic state, shortcut, and fixed-viewport
contracts. The Direct PTY harness launches `runNativeSparkTui()` in a real pseudo-terminal for
stdin/stdout bytes, raw mode, resize, redraw, and exit behavior. Do not simulate PTY semantics in
the component harness or require a terminal multiplexer for either lane.

Real process and journey tests stay out of the root Vitest suite. Source and packed-product checks share the same
daemon lifecycle harness, but invoke different executable targets. This prevents the source launcher
and generated npm product from drifting while keeping failures attributable to distinct named steps.
`pnpm run check` remains the serial local gate. Static CI runs maintained workflow validators,
architecture, dependency, documentation, formatting, lint, and type checks. Runtime CI runs the
complete source and process suites on the Ubuntu/macOS matrix, the Repro Golden Journey on Ubuntu
with a pinned compatible cue-shell source build, plus the browser suite for pull requests and
`merge_group`. Those source, process, journey, and browser jobs are independent because each owns
its checkout, installation, and runtime setup. Merge-gate workflows do not run on branch pushes.
The repository-wide benchmark workflow runs every CPU benchmark on `main`. Pull requests, merge
groups, and `main` pushes select affected I/O benchmarks through Vitest's dependency graph, while a
daily schedule and manual dispatch refresh the complete suite. Benchmark-harness changes force a
full run and documentation-only pull requests skip the workflow. A regular Ubuntu selector is the
necessary `needs` predecessor of the I/O walltime job so an unaffected change never allocates a
CodSpeed Macro Runner. The CPU simulation job remains independent. The dependency audit uses
path-filtered `main` pushes and a schedule for complete scans. Related merge-gate jobs share one
workflow so `needs` can express intra-lane order where required: `ci-static-checks.yml` runs
`Pre-commit Checks` before `Project Checks` and `Documentation Checks`; `ci-tests.yml` runs
Source, Process, Repro Golden Journey, and Browser jobs concurrently. There is no aggregate
required job and no static-to-runtime dependency chain. Benchmark, Mutation CE, Capability CE,
and Dependency Audit jobs remain advisory. Repro live capability is excluded from ordinary
pull-request checks but its latest Nightly result is a release gate.

`prek` is the local fast-fix boundary: use native pre-commit integrations for file-format and
workflow checks, plus the repository's `spark-check-fix` hook. Actionlint parses workflow syntax
and expressions; Zizmor owns GitHub Actions security policy, including immutable action references.

Continuous-evaluation lanes remain separate from merge gates. Capability CE repeats the exact
owner tests selected by the deterministic sentinel runner and preserves missing runs, inventory
drift, flakes, and duration violations as distinct failures. Mutation CE evaluates whether tests
kill plausible source changes. Both publish reports without weakening the binary contracts used by
pull-request verification.

The daemon capacity source-process case keeps its direct-oRPC, concurrency, provider-cardinality,
event-ordering, and persistence contracts binary. Its event-loop and RPC diagnostics remain in the
source-process report, while CodSpeed compares the production-shaped end-to-end walltime instead
of applying absolute latency thresholds on shared hosted runners.

## Test ownership and discovery

Test ownership is structural instead of ledger-driven:

- package and app tests live under their owning workspace and run through that workspace's `test` script;
- `vitest.root.config.ts` owns cross-workspace tests under `test/` and excludes separate real-process and journey lanes;
- `vitest.process.config.ts` owns `test/process/`;
- `vitest.journey.config.ts` owns `test/journey/` and may declare native runtime prerequisites in its dedicated CI job;
- Dependency Cruiser rejects root/app deep links into workspace `src/` internals and cross-package relative source imports;
- `pnpm -r --workspace-concurrency=1 --if-present run test` discovers every app- and package-local test script directly from manifests, while `check-architecture-ratchets.mjs` fails closed when any workspace contains tests but does not expose a `test` script.

Mutation CE selection is also package-owned: either a `test:mutation` script or `stryker.config.json` requires the complete command, config, and dependency set. Shared Stryker dependencies alone do not enroll a package. This keeps pnpm recursive `--if-present` discovery fail-closed without a second workspace inventory.

## Tests versus static policy

Code tests assert observable functionality: return values, state transitions, persisted effects,
boundary calls, process results, rendered output, DOM interaction, and compatibility behavior.
They do not inspect the repository's current source, workflow YAML, package scripts, manifests,
CSS, or documentation to prove that an implementation fragment exists.

Repository policy belongs to dedicated static tools invoked by `pnpm run check:static`:

- Actionlint and Zizmor own GitHub Actions parsing and security analysis;
- JSON Schema, Syncpack, and Knip own generic inventory and manifest consistency;
- Dependency Cruiser owns import direction, cycles, deep-link bans, transport boundaries, and the
  daemon execution worker import graph;
- `check-architecture-ratchets.mjs` compares the authoritative package inventory with workspace
  manifests and keeps test and mutation discovery fail-closed;
- Astro/Starlight own documentation parsing and compilation; focused tests exercise locale
  selection and path mapping as behavior.

Do not add a repository-wide source, YAML, schema-string, prompt, or prose keyword scanner. If a
maintained parser or analyzer owns the format, configure it. If the concern is product behavior,
test the consuming boundary. A project-specific static check is acceptable only when it compares
structured sources of truth that generic tooling cannot relate.

Prefer, in order:

1. externally observable return values, state transitions, persisted data, calls at a real boundary,
   exit status, and side effects;
2. versioned schemas or reusable contract suites for producer/consumer and adapter compatibility;
3. complete golden files when the full serialized or rendered representation is itself public
   behavior.

Reading production source and asserting that fragments are present is not a behavior test. It is
usually a brittle implementation mirror. Express an import rule in Dependency Cruiser, validate a
machine-readable contract, or delete the assertion. The same rule applies to prompt and instruction
wording: verify structured behavior at the consuming boundary instead of matching text fragments.
For schemas and transforms, test acceptance, rejection, normalization, or downstream behavior
instead of proving that a word or field name appears in a serialized schema.
Hashing the same text does not turn an implementation mirror into a contract test. Assert a fixed
digest only when the digest itself is the protocol, such as content-addressed identity or an
integrity/wire digest, or when the test exercises runtime byte integrity rather than copied wording.

## Golden files

Use a golden only when the representation itself is the contract, such as a complete tool rendering
or agent instruction. Keep one coherent golden per meaningful state instead of many substring
assertions. Dynamic behavior still needs separate tests of the state or input that selects the
golden.

## Review questions

- What real regression becomes invisible if this assertion is deleted?
- Does a synonymous wording or refactor break the test while behavior stays correct?
- Is there at least one negative path for a fail-closed or recovery boundary?
- Does a mock observe an edge, or replace the logic that the test claims to verify?
- Does the test belong to the package that owns the contract?
- Can the failure be replayed in a clean checkout without hidden local state?
