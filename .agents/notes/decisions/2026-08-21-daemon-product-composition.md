# 2026-08-21: Daemon owns static Spark product composition

## Decision

`@zendev-lab/spark-daemon` is the single Spark product composition root. The
former `@zendev-lab/spark-extension` workspace is removed, and its product
policy, headless executor, host bootstrap, and tests live under
`apps/spark-daemon/src/product/`. Do not add `spark-base`, another composition
workspace, arbitrary Spark capability discovery, or a Spark-owned
`package.json#pi` manifest.

The daemon registers the supported Spark capability adapters statically. Model
provider plugins remain configurable because they are a bounded provider ABI,
not a way to replace product policy. Historical `extensions` and
`extensionProfileVersion` config keys are ignored when old JSON is read; they
do not select behavior and are not written back.

DSH/Cordis plugins are mounted by the process that hosts their service graph:

| Plugin or surface | daemon | `spark-web-dsh` | native `spark-web` |
| --- | --- | --- | --- |
| `dsh-tool-cue` | mounted on the daemon root | mounted in the DSH `web` profile | consumes daemon projection |
| `dsh-tool-fusion` | mounted with Spark tool policy | mounted in the DSH `web` profile | consumes daemon projection |
| Spark LLM DSH adapter | mounted on the daemon root | mounted in the DSH `web` profile | consumes daemon projection |
| `dsh-channels` | mounted on the daemon root | not applicable | consumes daemon projection |
| `spark-web-dsh` client plugin | not applicable | mounted in the DSH `web` profile | not applicable |

The DSH `web` profile therefore belongs to the DSH-hosted web application. It
does not belong in daemon configuration, and native `spark-web` does not create
one because it is a daemon client. The daemon owns its own shared Cordis root
and durable Spark control-plane integration.

This decision supersedes the placement in
[`2026-08-19-headless-executor-composition.md`](./2026-08-19-headless-executor-composition.md)
and updates the composition owner named in
[`2026-08-20-dsh-cordis-composition.md`](./2026-08-20-dsh-cordis-composition.md).
The older rationale remains historical evidence.

## Rationale

The removed workspace was not a reusable kernel: production use converged on
the daemon, while loading the headless executor pulled in the same product
policy and capability graph. Keeping it separate created a second apparent
product boundary and an obsolete extension-discovery path. Moving that code to
the actual lifecycle owner preserves the inward dependency rule without adding
an empty `spark-base` facade.

Static capability composition also makes supported product behavior
auditable. DSH plugins retain one implementation and are mounted in each
applicable Cordis host; client surfaces consume owner APIs instead of mounting
a second execution graph.

## Consequences

- `architecture/packages.json` records 41 workspaces and daemon as the only
  composition root.
- `@zendev-lab/spark-daemon/headless-role-executor` is the default headless
  module; `spark-host` remains host-neutral.
- Capability adapter exports named `/extension` may remain only as bounded
  compatibility ABIs. They are statically selected by daemon composition and
  are not a Spark product discovery mechanism.
- `@zendev-lab/spark-graft/extension` remains a Pi-compatibility/test path and
  receives no new Spark product behavior.
- Any new DSH plugin must declare which Cordis host requires it. A client-only
  surface does not duplicate the plugin merely for symmetry.
