---
description: "Prefer official DSH plugins, reserve dsh-tool-* for thin Spark-owned tool adapters, and delete rather than rename obsolete host packages"
owner: zrr1999
created: 2026-08-20
---

# DSH package reuse and naming

## Decision

Spark package names describe ownership and the package's primary reusable
contract. They do not merely report that Cordis or DSH appears in the
implementation.

Use this precedence before creating or renaming a workspace:

1. If an official `@deepseek-ai/dsh-*` package satisfies the required runtime,
   lifecycle, policy, and state-owner contract, compose it directly and delete
   the Spark duplicate.
2. If Spark owns additional domain semantics, retain the `spark-<domain>` owner
   and adapt that owner to the official DSH seam. Do not fork the official tool
   under `@zendev-lab`.
3. Use `@zendev-lab/dsh-tool-<family>` for a reusable model-facing DSH
   `ToolRuntime` consumer which owns no durable state, command, UI, provider
   registry, scheduler, or parallel policy implementation.
4. A Spark product application hosted on DSH remains `spark-<surface>-dsh`.
   `spark-web-dsh` is therefore retained and is not a tool/plugin package.

For another generic DSH consumer/provider family, put the seam before the
implementation (`dsh-<seam>-<implementation>`). Add such a workspace only when
the implementation is a hard runtime boundary and the closed package budget
permits it. Do not use the generic `dsh-plugin-*` form: "plugin" is a
composition mechanism, not a semantic owner.

Adopting an official package must not move Spark-owned state or scheduling by
accident. A superficially matching API is insufficient. The replacement PR
must prove the current public behavior, lifecycle, cancellation, approval, and
recovery path through the existing owner.

## Package disposition

| Current workspace | Disposition | Reason |
| --- | --- | --- |
| `spark-cue` / `dsh-tool-cue` | rename the execution kernel to `dsh-cue`; retain the tool consumer | Cue execution is Spark-independent. `dsh-tool-cue` consumes that one Cordis service; the inventory records the existing dependency as bounded migration debt until the rename. |
| `spark-web-dsh` | retain | Spark product application and compatibility workbench, not a model-facing tool plugin. |
| `spark-acp` | retain | The upstream ACP adapter drives `ctx.agents` directly and does not expose the durable admission seam required by the Spark daemon scheduler. The protocol remains a Spark product adapter until that seam exists. |
| `spark-turn` | replace with `dsh-tool-agent-skill` when native Agent/Session driving lands | Pi/DSH conversion and per-drive runtime are migration scaffolding. The replacement is an independent consumer for the `agent_skill` tool, paired in one package-budget-neutral PR. |
| `spark-host` | replace with `spark-skill` after callers move | Legacy registries, widgets, shortcuts, and session shims are deleted. The replacement is Spark's single local skill provider into `ctx.skills`, paired in one package-budget-neutral PR. |
| `spark-core` | rename in place to `spark-invocation` after host-contract consumers move | The surviving owner is the immutable Invocation Cordis service, not a generic host-contract bag. |
| `spark-tool-web` | retain | Its cache, `code_search`, `get_search_content`, and response identity are Spark product contracts beyond the upstream Web tool family. |
| `spark-files` | retain as a Spark domain owner | Atomic/versioned workspace IO and Artifact-root semantics exceed a tool adapter. Prefer official `dsh-tool-fs` and `dsh-tool-fs-search` over a Spark filesystem service adapter; do not rename the owner. |
| `spark-fusion` | renamed to `dsh-tool-fusion` in this stack | It is a stateless, model-facing tool family with no official DSH equivalent or durable state owner. Its root ABI is a Cordis plugin; the `/legacy` export is stack-internal and exits with the legacy loader. |
| `spark-graft` | retain pending an owner split | It owns an external client and sandbox adapter in addition to tools. Renaming the combined package would misstate its boundary. |
| `spark-ask`, `spark-artifacts`, `spark-memory`, `spark-session`, `spark-tasks`, `spark-workflows`, `spark-roles`, `spark-loop`, `spark-repro`, `spark-llm` | retain | These packages own Spark product/domain/provider semantics. They may export Cordis plugins without becoming `dsh-tool-*`. |

## Stack order

1. Lock the naming and official-reuse contract before any package rename.
2. Upgrade the DSH family to one exact release and converge on one daemon
   Cordis root.
3. Replace `spark-host` and `spark-turn` only in the same PRs that add their
   package-budget-neutral successors. Retain `spark-acp`; rename `spark-core`
   in place only after its generic host contract disappears.
4. Migrate owner packages to Cordis one at a time. Rename only packages that
   satisfy the `dsh-tool-*` contract in the same PR, starting with Fusion.
5. Keep `spark-tool-web` while it owns its additional Spark product contract;
   do not publish a local duplicate of the upstream generic Web tool family.

No compatibility aliases or forwarding workspaces survive the top of the
stack. Public command names and `spark-protocol` actions remain stable while
their implementation packages change.

## Evidence behind the first cut

- Every current workspace has a production consumer or an executable/public
  entrypoint; there is no safe whole-package deletion on the pre-convergence
  `main` graph.
- `spark-acp` drives daemon RPC and canonical Spark Session/Invocation state,
  while the upstream ACP adapter drives `ctx.agents`. Without an external
  durable admission seam, direct replacement would bypass the scheduler.
- `spark-host` widgets and keybindings still have production callers in
  `spark-extension`; TUI retirement alone is not proof that those modules can
  be deleted before host convergence.
- The official DSH package family already publishes ACP, filesystem, Web,
  approval, workflow, and related tool/seam packages. A local rename must not
  create a second implementation under a similar name.
