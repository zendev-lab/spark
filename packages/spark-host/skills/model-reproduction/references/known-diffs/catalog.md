# Known Megatron / Fleet Diff Catalog

This catalog is retrieval guidance, not a gate. Every entry is a prior from a recorded profile. Revalidate it on the current model, code revisions, device, dtype, shape, layout/stride, topology, and real graph before treating it as evidence.

## Status Model

- `reported`: source describes a candidate or historical observation.
- `investigating`: current work is testing the mechanism.
- `validated`: scoped source evidence confirms the mechanism.
- `resolved`: owning implementation and formal scoped regression are complete.
- `rejected`: evidence falsified the mechanism for the stated scope.
- `superseded`: a newer entry/evidence replaces the old formulation.

`source_status` preserves source wording and may not map one-to-one to normalized status.

## Taxonomy

Every entry has one primary execution-layer/boundary category:

- `config-default`
- `data-loss-contract`
- `module-wrapper-state`
- `operator-kernel`
- `autograd-accumulation`
- `distributed-collective`
- `optimizer-clip`
- `checkpoint-dtype`
- `missing-capability`

Model, framework, status, symptom, shape, layout, dtype, version, and evidence are additional tags rather than identity. A category with no current entry remains part of the catalog schema.

## Index

| ID | Category | Boundary | Status | Search terms |
|---|---|---|---|---|
| `ATTN-BADDBMM-BWD-001` | operator-kernel | attention QK backward | validated | baddbmm, non-contiguous key_t, dQ, dK, NN GEMM |
| `EMB-REPEATED-TOKEN-ACCUM-001` | autograd-accumulation | embedding backward | validated | repeated token, embedding, scatter_add, deterministic indexing |
| `MOE-UNPERMUTE-ACCUM-001` | autograd-accumulation | MoE permute/unpermute backward | validated | scatter, repeated indices, fp32 accumulation, deterministic |
| `LINEAR-SMALL-M-LAYOUT-001` | operator-kernel | expert/linear backward | validated | small M, F.linear, matmul, transpose, layout, stride |
| `ACT-SWIGLU-SCALE-AUTOGRAD-001` | operator-kernel | expert activation backward | validated | SwiGLU, silu, scale, plain autograd, fp32 |
| `ROUTER-GATHER-BWD-001` | autograd-accumulation | router weight lookup backward | validated | take_along_axis, gather_nd, topk, scatter order |
| `OPT-ADAMW-IMPL-001` | optimizer-clip | AdamW update/copyback | validated | Apex FusedAdam, torch AdamW fused, bf16 copyback, midpoint |
| `MOE-WGRAD-FP32-001` | optimizer-clip | expert weight gradient | validated | fused_linear_param_grad_add, bf16 input, fp32 wgrad |
| `CONFIG-COMPAT-FLAG-001` | config-default | accuracy-compatible flag propagation | reported | false string, derived path, config field, shared mutation |
| `LOSS-AGGREGATION-SEMANTICS-001` | data-loss-contract | distributed loss reporting | reported | token weighted, sample mean, per-rank loss_scalar, EP |

## Entries

### ATTN-BADDBMM-BWD-001

- category: `operator-kernel`
- boundary: attention QK score backward dQ/dK
- normalized_status: `validated`
- source_status: `verified` / active source fix in the MiniMax snapshot
- prior: A contiguous standalone `baddbmm.backward` replay can be exact while the real attention graph's transposed non-contiguous `key_t` selects a differing backward formulation. The scoped source used explicit matmul and an audited NN-GEMM dQ layout.
- scope: MiniMax-V2.5 bf16 profile and cited PaddleFleet/Megatron revisions.
- revalidate: real q/k tensors, transpose/view provenance, strides, dQ/dK hashes, same-side determinism, and at least two representative real layouts.
- do_not_infer: that all Paddle `baddbmm.backward` paths are wrong or that this formulation fits another model.
- source_note: `source-notes.md#attn-baddbmm-bwd-001`

### EMB-REPEATED-TOKEN-ACCUM-001

- category: `autograd-accumulation`
- boundary: vocabulary embedding backward
- normalized_status: `validated`
- source_status: `verified`
- prior: Forward can be exact while repeated-token gradient accumulation differs between embedding/scatter implementations. Deterministic indexing matched the cited Torch deterministic path.
- scope: cited MiniMax repeated-token bf16 inputs.
- revalidate: actual token multiplicities, row gradients, accumulation dtype/order, and optimizer impact.
- do_not_infer: that indexing is universally required or that a unique-token sample tests the mechanism.
- source_note: `source-notes.md#emb-repeated-token-accum-001`

### MOE-UNPERMUTE-ACCUM-001

- category: `autograd-accumulation`
- boundary: MoE permute/unpermute and token combine
- normalized_status: `validated`
- source_status: `verified`
- prior: Repeated token indices can make scatter/unpermute accumulation order and dtype numerically visible. The cited profile required deterministic behavior and fp32 accumulation.
- scope: cited MiniMax MoE movement/scatter profile.
- revalidate: routing map/order, duplicate destinations, dispatch/combine backend, rank topology, accumulation dtype, and same-side determinism.
- do_not_infer: that DeepEP or any named backend is the current cause before boundary evidence.
- source_note: `source-notes.md#moe-unpermute-accum-001`

### LINEAR-SMALL-M-LAYOUT-001

- category: `operator-kernel`
- boundary: expert FC input gradients and other small-M linear paths
- normalized_status: `validated`
- source_status: `verified` / source-owned scoped fix
- prior: `F.linear` and explicit matmul can select different GEMM signatures for small per-expert token counts. The source stresses a scoped layout/call-signature repair, not a global rewrite.
- scope: cited MiniMax SequentialMLP, non-grouped, non-fp8/fp4 paths.
- revalidate: M/N/K, transposes, weight layout, strides, contiguity, dtype, and multiple real shapes.
- do_not_infer: that one API is always more accurate or that shape-switching is a valid repair.
- source_note: `source-notes.md#linear-small-m-layout-001`

### ACT-SWIGLU-SCALE-AUTOGRAD-001

- category: `operator-kernel`
- boundary: expert SwiGLU and router-scale backward
- normalized_status: `validated`
- source_status: `verified`
- prior: Matching the plain-autograd fp32 `silu(g) * u * scale` operation tree removed a scoped backward formulation mismatch.
- scope: cited MiniMax expert MLP profile.
- revalidate: operand dtype/casts, operation order, scale shape/broadcast reduction, upstream gradient, and real graph hooks.
- do_not_infer: that all fused SwiGLU kernels differ or that an offline forward match proves backward.
- source_note: `source-notes.md#act-swiglu-scale-autograd-001`

### ROUTER-GATHER-BWD-001

- category: `autograd-accumulation`
- boundary: router selected-weight lookup backward
- normalized_status: `validated`
- source_status: active source-level sub-fix in the snapshot
- prior: Equivalent forward Top-K values can have different backward scatter paths when selected scores are read with `take_along_axis` versus row-index `gather_nd`.
- scope: cited MiniMax `StandardMoERouter._topk_noaux_tc` path.
- revalidate: exact Top-K choice/order, selected weights, dense source gradient, duplicate indices, and current router implementation.
- do_not_infer: that this lookup is the root cause when router inputs or upstream gradients already differ.
- source_note: `source-notes.md#router-gather-bwd-001`

### OPT-ADAMW-IMPL-001

- category: `optimizer-clip`
- boundary: fp32 master update to bf16 model copyback
- normalized_status: `validated`
- source_status: `verified`
- prior: On a scoped qkv copyback boundary, PyTorch `AdamW(fused=True)` matched the cited Paddle behavior while Apex `FusedAdam` did not.
- scope: cited MiniMax qkv optimizer/copyback profile; not global optimizer-stage exactness.
- revalidate: optimizer hyperparameters, parameter grouping/decay, gradient input, master pre/post, moments, update, bf16 copyback, and several steps.
- do_not_infer: that the candidate is correct for GLM or another optimizer profile without a bounded projection.
- source_note: `source-notes.md#opt-adamw-impl-001`

### MOE-WGRAD-FP32-001

- category: `optimizer-clip`
- boundary: expert FC weight gradient before optimizer
- normalized_status: `validated`
- source_status: `verified`
- prior: Feeding bf16 inputs to fused parameter-gradient accumulation left a sub-ULP fp32 wgrad difference that crossed an AdamW/bf16 copyback boundary; casting inputs to fp32 matched the scoped standalone formulation.
- scope: cited MiniMax non-grouped, non-fp8 expert wgrad path.
- revalidate: live x/dy order and layout, grad accumulation semantics, wgrad dtype, optimizer update, copyback, and multi-step first divergence.
- do_not_infer: that broad copyback nudges are valid; the source explicitly rejects them.
- source_note: `source-notes.md#moe-wgrad-fp32-001`

### CONFIG-COMPAT-FLAG-001

- category: `config-default`
- boundary: config-to-operator compatibility switch propagation
- normalized_status: `reported`
- source_status: review lessons / recurring bug class
- prior: Raw environment strings, undeclared fields, omitted derived branches, shared-config mutation, and tests of unused fields can make a compatibility switch appear correct while the live tensor path is wrong.
- scope: general retrieval prior distilled from cited PaddleFleet review lessons.
- revalidate: parsed boolean, every provider/config/module handoff, actual branch execution, default-off behavior, and distinguishing tests.
- do_not_infer: that a current flag is broken without tracing its live path.
- source_note: `source-notes.md#config-compat-flag-001`

### LOSS-AGGREGATION-SEMANTICS-001

- category: `data-loss-contract`
- boundary: rank-local loss versus logged aggregate
- normalized_status: `reported`
- source_status: documented lesson
- prior: Logged loss can use a different aggregation denominator/order than the contract's per-rank or token-weighted loss scalar, especially with uneven expert-parallel token counts.
- scope: retrieval prior; exact semantics are task-specific.
- revalidate: labels/mask/shift, unreduced loss inputs, valid-token counts, reduction order, per-rank scalar, and logged aggregation.
- do_not_infer: that a logged mismatch is harmless; compare the frozen contract quantity first.
- source_note: `source-notes.md#loss-aggregation-semantics-001`
