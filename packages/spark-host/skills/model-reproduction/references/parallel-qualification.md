# Parallel Qualification Order

Read this reference while planning or executing Scale.

Start from certified P0. TP-only and EP-only may run concurrently when their
inputs and GPU groups are isolated. PP requires a multilayer profile and may
also begin once that parent exists. Join evidence in this order:

```text
TP + EP -> TPxEP
TPxEP + PP delta -> TPxEPxPP
-> sequence parallel
-> context parallel
-> data parallel
-> optimizer sharding
-> recompute/fusion/overlap/interleaving/low precision
```

Qualify H1 before Hshort and Htarget. For PP, begin with one microbatch and a
fixed non-interleaved schedule; then add accumulation, virtual pipeline, and
interleaving one variable at a time. For EP, freeze router policy, token order,
capacity/drop behavior, and expert mapping. For TP, freeze shard layout,
collective type/order, and residual/norm placement.

Numerical and performance verdicts remain separate at every node.
