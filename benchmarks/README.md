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

The advisory workflow in `.github/workflows/ci-benchmarks.yml` runs every CPU
benchmark on `main`. Pull requests, merge groups, and `main` pushes use Vitest's
changed-file dependency graph to select affected I/O benchmarks, while a daily
schedule and manual dispatch refresh the complete suite. CodSpeed Partial Runs
fill skipped results from the latest baseline. Documentation-only pull requests
skip the workflow.

CPU benchmarks run in CodSpeed simulation mode with a five-minute limit. Files
named `*.walltime.bench.ts` are selected first on a regular Ubuntu runner. The
twenty-minute CodSpeed Macro Runner job starts only when that selector finds an
affected I/O benchmark, or when the daily or manual full baseline runs. Use the
walltime suffix for workloads whose measured behavior includes file I/O,
networking, subprocesses, or other system calls that simulation does not
measure. Both lanes use the repository's Node 24 runtime, grant only
`contents: read`, and pin every action to a commit SHA.

To add another module, place its cases and `.bench.ts` file under
`benchmarks/<module>/`, use the `.walltime.bench.ts` suffix when appropriate,
import public production exports, name every benchmark with its workload size,
and add or extend a correctness test. The shared glob will enroll it
automatically. Module-specific release protocols and scorecards remain in that
module's own benchmark README rather than this microbenchmark harness.
