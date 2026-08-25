# Leaf / L1 continuous evaluation (mutation)

Weekly/manual [Stryker](https://stryker-mutator.io/) runs evaluate whether Vitest unit tests would catch small source mutations. This lane is **continuous evaluation (CE)**, not a merge gate: it reports quality, stays scoped to modules with colocated tests, and never blocks PR verify.

## Scope

### L0 (pure leaves)

| Package | Mutate surface |
| --- | --- |
| `@zendev-lab/spark-retry` | `src/**/*.ts` except tests |
| `@zendev-lab/spark-protocol` | colocated / architecture-covered modules |
| `@zendev-lab/spark-hub-storage-sqlite` | `client.ts`, `dialect.ts`, `migrate.ts` |
| `@zendev-lab/spark-platform-node` | `paths.ts`, `daemon-local-rpc.ts` |

### L1 (Vitest packages with colocated tests)

| Package | Mutate surface |
| --- | --- |
| `@zendev-lab/dsh-channel-transports` | modules with `*.test.ts` peers |
| `@zendev-lab/spark-hub-coordination` | modules with `*.test.ts` peers (+ `hub-queries.ts`) |
| `@zendev-lab/spark-session` | `action-tool`, `mail-store`, `registry`, `snapshot` |
| `@zendev-lab/spark-artifacts` | product store/forge/types/worktree |
| `@zendev-lab/spark-repro` | `src/index.ts` |
| `@zendev-lab/spark-i18n` | `index.ts`, `extension.ts` |
| `@zendev-lab/spark-daemon` | selected product task/TODO/selector policy modules |
| `@zendev-lab/spark-tasks` | task/TODO store modules shared by extension tests |

Out of scope: root `test/*.test.ts` (Vitest integration suite; not in mutation CE), Hub and the remainder of the daemon tree, and packages whose behavior is only covered by root integration tests (`spark-host`, `spark-turn`, `spark-llm-providers`, …).

## Commands

```bash
pnpm run test:mutation
pnpm --filter @zendev-lab/dsh-channel-transports run test:mutation
```

CI: `.github/workflows/ce-mutation.yml` (Monday 03:17 UTC + `workflow_dispatch`, `continue-on-error`, uploads HTML/JSON reports).

## Interpret the report

Each participating package owns its `test:mutation` script and
`stryker.config.json`; `pnpm -r --if-present` discovers the active set without a
second ownership ledger. Use the uploaded JSON/HTML report for the exact run
duration and scores. Prefer the **covered** mutation score when prioritizing
test work, and compare like-for-like runner, configuration, machine, and commit
metadata rather than copying a point-in-time table into this runbook.

## Hygiene

- Reports stay local/CI artifacts (`**/reports/mutation/`, `.stryker-tmp/` are gitignored).
- Publish `files` for TypeScript packages exclude `*.test.ts`.
- Prefer behavioral assertions over source-string mirrors.
- Expand mutate lists only after colocated tests catch survivors.
