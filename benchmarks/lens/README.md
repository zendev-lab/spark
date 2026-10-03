# Spark Lens benchmarks

This directory has two intentionally separate benchmark layers:

- `tasks.json`, `fixtures/`, and `pending-measurements.fixture.json` define
  the end-to-end Lens release protocol and its fail-closed empty fixture.
  Completed measurements and generated scorecards are run artifacts: keep them
  under gitignored `reports/lens/` or pass an explicit scorecard to the release
  gate with `SPARK_LENS_SCORECARD`.
- `production-path.bench.ts` is a small deterministic microbenchmark suite for
  hot, synchronous production APIs exported by `@zendev-lab/spark-lens`.
  The repository-wide [benchmark harness](../README.md) discovers and runs it.

## Production-path suite

Lens measures three real package paths:

1. canonical `stableJson` serialization of 1,024 nested records;
2. aggregation of 1,000 diagnostics into 500 observations;
3. validation, normalization, and hashing of a 500-edit patch proposal.

Inputs are constructed in `production-path-cases.ts` and reused by
`test/lens-benchmarks.test.ts`. The cases do not start providers, access the
network, read credentials, or use mutable repository state.

When adding a Lens case, import a production export from `@zendev-lab/spark-lens`,
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
