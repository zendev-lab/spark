# Vendored Reproduction Skill Provenance

Curated: 2026-07-28 UTC

This Spark skill is an independent snapshot. Runtime behavior does not read or depend on the source workspaces below.

## Methodology Source

- repository: `https://github.com/zrr1999/model-repro-bench.git`
- local source revision: `3680b9fa45c2a4ea5efce1506ddec406013f1b61`
- note: source worktree contained uncommitted user edits; each inspected file is therefore bound by content SHA-256 in addition to the repository revision.

| Source file | SHA-256 | Vendored use |
|---|---|---|
| `template/PLAYBOOK.md` | `0c1508c7d541f66a411581d447ae0d71ebb607ec615ba837cc71307e88c4c512` | core methodology and stage order |
| `template/playbook/localization.md` | `17e8cdacffdc6647769e1410f28f282cef03507ce48ddc44e773b91392f7ff1b` | `localization.md` |
| `template/playbook/speedup.md` | `d158d8167e2ed638e02eafd52902c25e755ec749a1ea748e43f176185870796c` | `speedup.md` |
| `template/playbook/observability.md` | `68a9523131ae36458492baf8381d3ad3f4401e67cd5a8847776b8af815bc0c4c` | `observability.md` |
| `template/playbook/lessons.md` | `d098265b4686f7b069391cc4cc241119d40de7ea9b93750e3723cddc86534e5a` | `lessons.md`, Known Diff notes |
| `template/AGENTS.md` | `1b7c713520df4cb4541943417a7265857d5dbc1d7ea315335ef80b702b045210` | precedence and delivery constraints |

## Known Diff Source

- repository: local Git workspace `/root/paddlejob/gpfsspace/workspace/minimax-workspace`
- local source revision: `4eab1ab8ed17b187497fe13b9c3de51b7938972b`
- remote: unavailable in the inspected checkout
- note: the catalog preserves scoped source claims as retrieval priors; it does not import MiniMax acceptance state into another repro.

| Source file | SHA-256 |
|---|---|
| `docs/PATCHES.md` | `572e42bbed7c39e4f41045a79e37c275a6b9c38f881f0e7983e1d101ed53ce60` |
| `docs/HISTORY.md` | `ef8ea72db727be852d8a591867189aaa861bbc987e093af8f5dea60af634c334` |
| `evidence/V02_attention_qk_bwd/README.md` | `336c95dbc6cf517b68e82ff48f065dc36c214cccda95cc8d950ceea812d194f9` |
| `evidence/V03_embedding_deterministic/README.md` | `7a9bab98ad6ac5b2e8fdf9e6af327ea1bae4a43bb97e9a00f80fb9f7ba89b743` |
| `evidence/V04_moe_dispatch_scatter/README.md` | `0e347b110e80ea4ab0f698337c35d0ccf820cca08892e9bf08586a0e875483d3` |
| `evidence/V05_linear_matmul_expert_bwd/README.md` | `f81eb4195d79ac9a9fc7a314f07f64ee84cb2ada655a844ab2cfc22f8cad2b94` |
| `evidence/V06_swiglu_scale/README.md` | `84c45079c7708b07f0e46b0d34d92f25bf9b5cf316c44ed0c22f52f3a927288d` |
| `evidence/V07_router_gate/README.md` | `ea9c61acbdf8fd54f598bcbf18073c5a97d96ecf39385a60d4b7faa8326e23d5` |
| `evidence/V08_optimizer_qkv_copyback/README.md` | `25e1bb84d083d1d448e479a00b3bd1d8a3987a7bb71fc35e660546d42926bbf2` |
| `evidence/V09_expert_wgrad_fp32/README.md` | `5e1d2d773361ca610321ebf106f5ea691b2e8345de727e9b526819359d16c6ee` |
| `evidence/V10_runtime_patch_ablation/README.md` | `cae0dd107db104f880b154653603965820fe17a9183604075cd650b602123724` |

## Curation Rules

- The core skill is concise and always sufficient to route the agent to a reference.
- Detailed methodology and Diff knowledge remain on disk for progressive disclosure.
- Source wording/code excerpts live in `known-diffs/source-notes.md`; normalized fields live in `known-diffs/catalog.md`.
- Stable semantic IDs survive status, model, and evidence updates.
- Refreshes append or supersede; they do not silently rewrite historical source status.
