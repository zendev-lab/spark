# Spark Lens benchmarks

This directory has two intentionally separate benchmark layers:

- `tasks.json`, `fixtures/`, and `pending-measurements.fixture.json` define
  the end-to-end Lens release protocol and its fail-closed empty fixture.
  Completed measurements and generated scorecards are run artifacts: keep them
  under gitignored `reports/lens/` or pass an explicit scorecard to the release
  gate with `SPARK_LENS_SCORECARD`.
- `production-path.bench.ts` is a small deterministic microbenchmark suite for
  hot, synchronous production APIs exported by `@zendev-lab/spark-lens`.
  CodSpeed runs this layer on pull requests and `main`.

## CodSpeed suite

The suite currently measures three real package paths:

1. canonical `stableJson` serialization of 1,024 nested records;
2. aggregation of 1,000 diagnostics into 500 observations;
3. validation, normalization, and hashing of a 500-edit patch proposal.

Inputs are constructed in `production-path-cases.ts` and reused by
`test/lens-benchmarks.test.ts`. The tests assert output shape and determinism so
CodSpeed cannot report a faster benchmark that stopped doing the intended work.
The cases do not start providers, access the network, read credentials, or use
mutable repository state.

Run the local Vitest benchmark UI:

```sh
pnpm run bench:lens
```

Run the same non-interactive command used by CodSpeed:

```sh
pnpm run bench:lens:codspeed
```

The benchmark job is part of `.github/workflows/ci-benchmarks.yml`. The workflow grants only
`contents: read`, pins every action to a commit SHA, and uses CodSpeed simulation
mode. Public-repository uploads therefore do not require a token or OIDC write
permission. The job temporarily uses Node 24 because the `@codspeed/core` 5.7.1
Linux addon is not yet compatible with the repository's Node 26 baseline; all
product validation remains on `.node-version`.

When adding a case, import a production export from `@zendev-lab/spark-lens`,
keep inputs deterministic and offline, add or extend a correctness test, and
name the benchmark with its workload size. Do not place provider startup or
full agent experiments in this microbenchmark layer; those remain part of the
release protocol and scorecard.

Generate a local release scorecard without modifying source:

```sh
node --experimental-strip-types scripts/run-lens-scorecard.mts
SPARK_LENS_SCORECARD=reports/lens/scorecard.json \
  node --experimental-strip-types scripts/check-lens-release.mts
```

The generated scorecard records its fixture digest and measurement timestamp.
Publish or retain it through the CI/evidence system for the run; do not commit
it as a hand-maintained claim about current readiness.
