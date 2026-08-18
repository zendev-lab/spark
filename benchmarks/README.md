# Spark benchmarks

`benchmarks/` owns Spark's repository-wide deterministic microbenchmark suite.
Each measured module has a directory under this root; the shared
`vitest.config.ts` discovers every `benchmarks/**/*.bench.ts` file without a
second module inventory.

The current suite covers real production paths in three owners:

- Lens: canonical serialization, diagnostic aggregation, and patch proposal
  normalization and hashing;
- Protocol: session-view parsing, conversation projection, A2UI normalization,
  and completed agent-trace validation;
- Session: snapshot-index refresh and indexed transcript-tail loading.

Benchmark inputs live in adjacent `*-cases.ts` files and are reused by
`test/*-benchmarks.test.ts`. Those correctness tests prove the workload and
output contract so a faster result cannot come from silently doing less work.
Cases stay deterministic and offline: do not start providers, access the
network, read credentials, or depend on mutable repository state.

Run the local Vitest benchmark UI:

```sh
pnpm run bench
```

Run the same non-interactive suite used by CodSpeed:

```sh
pnpm run bench:codspeed
```

The advisory job in `.github/workflows/ci-benchmarks.yml` runs the complete
suite on pull requests, merge groups, and `main`. Default-branch runs provide
the comparison baseline for later pull requests. The workflow grants only
`contents: read`, pins every action to a commit SHA, and uses CodSpeed simulation
mode. It temporarily uses Node 24 because the `@codspeed/core` 5.7.1 Linux addon
is not yet compatible with the repository's Node 26 baseline; product
validation remains on `.node-version`.

To add another module, place its cases and `.bench.ts` file under
`benchmarks/<module>/`, import public production exports, name every benchmark
with its workload size, and add or extend a correctness test. The shared glob
will enroll it automatically. Module-specific release protocols and scorecards
remain in that module's own benchmark README rather than this microbenchmark
harness.
