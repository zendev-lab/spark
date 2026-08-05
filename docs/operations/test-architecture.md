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

## Ownership and strategy ledgers

`test/test-ownership.json` is the authoritative disposition for every root `test/**/*.test.ts` file at the recorded `origin/main` baseline commit. An `owner-local` entry has exactly one package or app owner and its `currentPath` must be under that owner's workspace; a `root-integration` entry remains under `test/`, names at least two owners, and must exercise only public package exports. Root integration is admitted only when the behavior crosses ownership boundaries; moving a test must not expand a public API solely to preserve a test import.

`test/workspace-test-strategy.json` classifies every workspace in `architecture/packages.json` as `local-test`, `browser-test`, `process-test`, `boundary-contract`, or `generated-only`. Each entry names an executable primary gate and concrete paths/rules. A generated-only workspace may retain hand-written tests as supplemental coverage, but generated output is verified by its generation-and-diff gate.

`test/mutation-ce-ownership.json` is the single source for mutation CE selection. `included` entries must provide a Stryker config with explicit `src/` mutation paths; `deferred` entries must record an owner, risk level, risk rationale, and an executable alternate gate. Deferred mutation CE is a risk decision, not a claim that mutation testing succeeded. `scripts/run-leaf-mutation.mjs` derives its package set from this ledger.

The corresponding checkers are:

```bash
node scripts/check-test-ownership.mjs
node scripts/check-workspace-test-strategy.mjs
node scripts/check-mutation-ce-ownership.mjs
```

All three must report zero unclassified or pending entries before a test-architecture change is complete.

## Source-mirror debt

`pnpm run check:test-quality` is a ratchet for implementation-mirror tests. Its committed baseline must remain `legacyFiles=0` and `sourceMirrorAssertions=0`. Tests should assert observable behavior, schemas, AST/dependency rules, or complete reviewed goldens—not that a production source fragment exists. A new source-mirror assertion is a regression even when the total suite still passes.


Prefer, in order:

1. externally observable return values, state transitions, persisted data, calls at a real boundary,
   exit status, and side effects;
2. versioned schemas or reusable contract suites for producer/consumer and adapter compatibility;
3. AST, type, or dependency rules for architecture constraints;
4. complete golden files for intentionally stable user-visible rendering or protocol text.

Reading production source and asserting that fragments are present is not a behavior test. It is
usually a brittle implementation mirror. `pnpm run check:test-quality` tracks the existing debt and
rejects any count change. After replacing such assertions with behavior, schema/AST checks, or a
reviewed full golden, update and review the lower baseline:

```bash
pnpm run check:test-quality:update
pnpm run check:test-quality
```

The baseline is a ratchet, not an exemption catalog: new files start at zero, and reductions must be
committed so removed debt cannot silently return.

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
