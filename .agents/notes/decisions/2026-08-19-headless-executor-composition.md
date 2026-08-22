# 2026-08-19: Headless executor lives in spark-extension

**Superseded for current placement** by
[`2026-08-21-daemon-product-composition.md`](./2026-08-21-daemon-product-composition.md).
The boundary rationale below is retained as historical evidence.

## Decision

The composition-coupled headless role executor and host bootstrap live in
`@zendev-lab/spark-extension` (`./headless-role-executor`, `./host`), not in
`spark-host`. The default module id is
`@zendev-lab/spark-extension/headless-role-executor`.

`spark-host` remains the host-neutral ExtensionAPI runtime. It must not import
the composition root. The executor statically imports `spark-extension`'s LLM
island and builtin extension factories, so it belongs with composition.

## Rationale

Moving host bootstrap into `spark-host` would invert the layer rule: runtime
would depend on composition. The TUI directory previously hosted this code only
because the native terminal app was the first composition host. Daemon turns
load the same module through `spark-host/headless-loader`; that loader stays
neutral and resolves a module specifier.

## Consequences

- Daemon npm bundles compile `packages/spark-extension/src/headless-role-executor.ts`.
- TUI keeps thin re-exports until the terminal app retires.
- Do not add a `spark-host` dependency on `spark-extension` to make the plan
  prose match the original destination name.
