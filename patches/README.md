# Vitest 5 dependency patches

These backports keep the existing CodSpeed and Stryker CI lanes working with
Vitest 5. Remove each patch when its dependency publishes the corresponding fix.

- `@codspeed/vitest-plugin@5.7.1`: the Vitest 5 provider and measurement helpers
  come from [CodSpeedHQ/codspeed-node#86](https://github.com/CodSpeedHQ/codspeed-node/pull/86),
  commit `eb2042ea711614ff503854928c8476869a10aff5`. `src/v5/provider.ts` and
  `src/instrument.ts` are bundled as ESM with esbuild (`--bundle --platform=node
  --format=esm --packages=external`). The plugin selects that provider for
  instrumented Vitest 5 runs and retains its existing Vitest 3/4 runners.
  The upstream Apache-2.0 license remains in the installed package.
- `@stryker-mutator/vitest-runner@10.0.0`: backports the test-name separator fix
  from [stryker-mutator/stryker-js#6220](https://github.com/stryker-mutator/stryker-js/pull/6220),
  commit `4e7930409c221c99ea25f9ab2c961e4fd8485c9b`, to the published JavaScript.
  Both coverage IDs and mutant filters use Vitest 5's ` > ` separator, retaining
  the space separator for earlier versions.

The benchmark groups retain the former suite names, so the provider's
`file::test::benchmark` identities match the old `file::suite::benchmark` identities.
Benchmark fixtures and cleanup stay outside the measured callback. Mutation
thresholds remain unchanged.
