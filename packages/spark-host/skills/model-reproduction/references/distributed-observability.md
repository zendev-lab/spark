# Distributed Observability

Read this reference for any topology with TP, EP, PP, SP, CP, DP, or optimizer
sharding enabled.

Record the topology vector, rank mapping, process groups, collective order,
microbatch schedule, partition metadata, reduction dtype, and rank-local
input/loss. Compare named boundaries immediately before and after communication:

- TP: local GEMM output, reduce-scatter/all-reduce input and output, residual.
- EP: router logits, token/expert order, dispatch counts, all-to-all boundaries,
  expert output, combine.
- PP: send tensor, receive tensor, microbatch id, stage loss, backward send/recv.
- SP/CP: sequence partition, attention statistics, gather/reduce boundaries.
- DP/sharding: local gradients, reduction, optimizer shards, post-update params.

Use hashes for routine collection and expand tensors only at the first failing
boundary. Prove the observation path does not change kernels, layout, collective
order, synchronization, or memory behavior before accepting its output.
