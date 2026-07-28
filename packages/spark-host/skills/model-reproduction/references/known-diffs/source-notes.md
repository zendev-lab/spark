# Known Diff Source Notes

This is a curated, read-only snapshot of source wording and code fragments. Keep it append-only when refreshing the normalized catalog. Paths are provenance, not runtime dependencies. Source images were not present in the inspected material; any unavailable image must be recorded as `source image unavailable`, never reconstructed.

## ATTN-BADDBMM-BWD-001

Source: MiniMax `evidence/V02_attention_qk_bwd/README.md` and `docs/PATCHES.md`.

Verbatim source:

> Torch native local `DotProductAttention.forward` is already the target eager math:
>
> ```text
> baddbmm -> softmax/dropout -> bmm
> ```
>
> It keeps `paddle.baddbmm` forward and uses explicit matmul backward. The dQ path matches Torch autograd's NN-GEMM form:
>
> ```python
> key = paddle.transpose(key_t, perm=[0, 2, 1]).contiguous()
> d_query = paddle.matmul(d_scores, key) * scale
> d_key_t = paddle.matmul(query, d_scores, transpose_x=True) * scale
> ```

Verbatim bench lesson:

> 已知例：`baddbmm.backward` 在 contiguous K 下可对齐，但真实 attention 的 non-contiguous `key_t` 路径仍分叉，必须显式 matmul backward（`_EagerQKScoresFn`）。复现要保持同一 dtype/shape/layout/stride/scale/mask/seed/env。

## EMB-REPEATED-TOKEN-ACCUM-001

Source: MiniMax `evidence/V03_embedding_deterministic/README.md`.

> Paddle `VocabParallelEmbedding` must use the existing deterministic indexing path:
>
> ```text
> self.weight[masked_input]
> ```
>
> instead of the default `F.embedding` path. Forward outputs are bit-identical, but repeated token backward depends on accumulation order.

Recorded source table:

```text
F.embedding(ids, w).backward() vs Torch sequential scatter reconstruction: max_diff 2.44e-4
w[ids].backward() vs Torch sequential scatter reconstruction: max_diff 0.0
```

## MOE-UNPERMUTE-ACCUM-001

Source: MiniMax `evidence/V04_moe_dispatch_scatter/README.md`.

> Torch scatter/index operations require deterministic mode.
>
> MoE permute/unpermute alignment relies on fp32 accumulation where repeated indices can sum into the same token.

The source also says the old Python `ZipNode.forward` compatibility patch is not current evidence; the current invariant is native C++/Torch-aligned fp32 accumulation plus deterministic scatter behavior.

## LINEAR-SMALL-M-LAYOUT-001

Source: MiniMax `evidence/V05_linear_matmul_expert_bwd/README.md` and `docs/PATCHES.md`.

Verbatim source:

> Do not globally rewrite `F.linear` to `matmul`. The safe fix is scoped to the expert fc1/fc2 backward sites where small per-expert token counts changed kernel selection or layout behavior.
>
> Cross-framework matmul can be bit-exact for identical input bytes and tested layouts.
>
> Paddle `F.linear` and `paddle.matmul` are not globally interchangeable.
>
> The correct repair surface is the expert backward call site, not framework-wide monkey patching.

## ACT-SWIGLU-SCALE-AUTOGRAD-001

Source: MiniMax `evidence/V06_swiglu_scale/README.md`.

Verbatim source:

> Both frameworks use the same plain-autograd expression:
>
> ```python
> F.silu(g.float()) * u.float() * scale.float()
> ```
>
> The old hand-written sigmoid backward path is removed from the active numeric route.

## ROUTER-GATHER-BWD-001

Source: MiniMax `evidence/V07_router_gate/README.md`.

Verbatim source:

> `scores_for_choice = scores + e_score_correction_bias` remains the Top-K selection tensor;
>
> dispatch/gate `topk_weight` is still gathered from the original unbiased `scores` using the selected `topk_idx`;
>
> the implementation changes from `scores.take_along_axis(topk_idx, axis=1)` to `row_idx + paddle.gather_nd(scores, gather_idx)`.
>
> Forward values are unchanged. The alignment reason is backward-only: `take_along_axis.backward` uses a scatter accumulation path/order that differs from Torch `gather.backward`.

## OPT-ADAMW-IMPL-001

Source: MiniMax `evidence/V08_optimizer_qkv_copyback/README.md`.

> The old step-2 `cp5_mixed_qkv` split was explained by step-1 qkv optimizer `master_post -> bf16_copyback` rounding. The active fix is qkv bf16-copyback-specific optimizer behavior alignment: use `torch.optim.AdamW(fused=True)` instead of Apex `FusedAdam`.

Recorded scoped table:

```text
Apex FusedAdam: nonzero at qkv boundary
PyTorch AdamW(fused=True): 0.0 for scoped qkv copyback
```

The source explicitly does not claim global fp32 `master_post` or optimizer-stage exactness.

## MOE-WGRAD-FP32-001

Source: MiniMax `evidence/V09_expert_wgrad_fp32/README.md`.

> Expert fc1/fc2 weight gradients must preserve fp32 precision before optimizer copyback.

Preserved source code fragment:

```python
paddle._C_ops.fused_linear_param_grad_add(
    x_slice.astype("float32"),
    dy_slice.astype("float32"),
    grad_attr,
    None,
    True,
    False,
)
```

The source says this is an owning-source numerical fix, not a workspace dump probe, and rejects a broad Torch copyback midpoint nudge.

## CONFIG-COMPAT-FLAG-001

Source: model-repro-bench `template/playbook/lessons.md`.

Verbatim source checklist:

> - **裸字符串判真**：`os.getenv(..., "false")` 非空字符串恒为真，未设置开关时也进兼容分支——必须解析为布尔语义，统一一个 helper。
> - **开关漏传**：每一条派生路径都要显式传导。
> - **config 字段未声明**：直接访问 `config.use_accuracy_compatible` 但 dataclass 未声明该字段，默认配置抛 `AttributeError`。
> - **写回共享 config**：在 forward 里修改共享 config（如 softmax 设置）会把一次兼容调用泄漏到其他层。
> - **测试要验证真正生效的张量**：每个开关分支都要有能区分开/关行为的用例。

## LOSS-AGGREGATION-SEMANTICS-001

Source: model-repro-bench `template/playbook/lessons.md`.

Verbatim source:

> 两框架 logged loss 可能有 ~0.2 的系统性差距，来自 token 加权平均 vs 样本简单平均（EP 下各 rank 有效 token 数不均）。
>
> 对齐验证看 per-rank `loss_scalar` / CP dump 的逐位一致，不比 logged loss 数字。

This is a methodology note, not permission to dismiss any current logged mismatch.
