# Test architecture

Spark tests should identify the contract they protect and run at the closest owning boundary.
The root suite is for cross-package behavior; package-local behavior belongs beside the package so
its normal check and mutation evaluation can exercise it.

## Lanes

| Lane | Location | Contract |
| --- | --- | --- |
| Package unit / contract | `packages/*/src/**/*.test.ts` | Pure behavior, schemas, state transitions, adapter contracts |
| App unit / integration | `apps/*/src/**/*.test.ts` | App-owned composition, persistence, process, route, and rendering behavior |
| Root integration | `pnpm test` (`test/**/*.test.ts`, excluding `test/process/`) | Behavior that genuinely crosses package or app ownership boundaries |
| Source process | `pnpm run test:process:source` (`test/process/**/*.test.ts`) | Exact source-distributed executable lifecycle under isolated local state |
| Browser component | `pnpm run test:browser:hub` | Browser-only interaction and DOM behavior |
| Product process | `pnpm run smoke` | Packed, clean-installed public product lifecycle and Hub HTTP/client-asset smoke |
| Capability CE | `pnpm run test:capability:ce` | Repeated zero-token Goal, Loop, and Repro sentinels, inventory stability, flakes, and duration variance |
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

Real process tests stay out of the root Vitest suite. Source and packed-product checks share the same
daemon lifecycle harness, but invoke different executable targets. This prevents the source launcher
and generated npm product from drifting while keeping failures attributable to distinct named steps.
`pnpm run check` remains the serial local gate; CI runs grouped checks, tests, and smoke jobs in
parallel, then requires a single aggregate `required` job.

Continuous-evaluation lanes remain separate from merge gates. Capability CE repeats the exact
owner tests selected by the deterministic sentinel runner and preserves missing runs, inventory
drift, flakes, and duration violations as distinct failures. Mutation CE evaluates whether tests
kill plausible source changes. Both publish reports without weakening the binary contracts used by
pull-request verification.

## Test ownership and discovery

Test ownership is structural instead of ledger-driven:

- package and app tests live under their owning workspace and run through that workspace's `test`/`check` scripts;
- `vitest.root.config.ts` owns cross-workspace tests under `test/` and excludes the separate real-process lane;
- `vitest.process.config.ts` owns `test/process/`;
- Dependency Cruiser rejects root/app deep links into workspace `src/` internals and cross-package relative source imports;
- `pnpm -r --filter './packages/*' --if-present run check` discovers package-local checks directly from manifests.

Mutation CE selection is also package-owned: every participating package declares a standard `test:mutation` script beside its `stryker.config.json`, and the root command uses pnpm recursive `--if-present` discovery. This avoids maintaining historical migration baselines or a second workspace inventory. Review package scripts, Vitest includes, and Dependency Cruiser rules together when changing a test boundary.

## Tests versus static policy

Code tests assert observable functionality: return values, state transitions, persisted effects,
boundary calls, process results, rendered output, DOM interaction, and compatibility behavior.
They do not inspect the repository's current source, workflow YAML, package scripts, manifests,
CSS, or documentation to prove that an implementation fragment exists.

Repository policy belongs to dedicated static tools invoked by `pnpm run check:static`:

- `check-architecture-ratchets.mjs` owns only Spark-specific workspace identity, dependency, and
  compatibility boundaries that generic tools cannot express;
- `check-github-actions.mjs` owns immutable Action references and benchmark credential policy;
- `check-pnpm-workspace-policy.mjs` owns hook-time pnpm mutation safety;
- `check-hub-source-boundaries.mjs` owns Hub source/state-owner boundaries;
- Dependency Cruiser and the existing terminology, documentation, distribution, and evidence
  checkers own their declared repository surfaces.

Static checker self-tests do not belong in the root code-test suite. Validate repository policy by
running its dedicated tool against the repository and keep code tests focused on product behavior.

`pnpm run check:test-quality` enforces this split. Its committed baseline remains
`legacyFiles=0` and `sourceMirrorAssertions=0`; the detector follows direct and locally wrapped
file reads and recognizes both production source and repository configuration. A new
source-fragment assertion is a regression even when the total suite still passes.

Prefer, in order:

1. externally observable return values, state transitions, persisted data, calls at a real boundary,
   exit status, and side effects;
2. versioned schemas or reusable contract suites for producer/consumer and adapter compatibility;
3. complete golden files when the full serialized or rendered representation is itself public
   behavior.

Reading production source and asserting that fragments are present is not a behavior test. It is
usually a brittle implementation mirror. Move a real repository constraint into its authoritative
static checker; otherwise delete the assertion. If an older branch still carries non-zero baseline
debt, update and review the lower baseline after removing it:

```bash
pnpm run check:test-quality:update
pnpm run check:test-quality
```

The baseline is a ratchet, not an exemption catalog: new files start at zero, and the main branch
must stay at zero.

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
