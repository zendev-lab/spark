# Topology Planning

Read this reference during Setup and before Scale planning.

Represent topology as a vector:

```yaml
tp: 1
pp: 1
ep: 1
cp: 1
dp: 1
sequence_parallel: false
optimizer_sharding: none
```

Define `P0`, the smallest `Pfit` that makes S2 runnable, and contract
`Ptarget`. Choose Pfit from the measured bottleneck: TP for width/dense weights,
EP for expert weights, PP for depth/activation residency, and CP for sequence
activation. Pfit proves capacity only.

Build a certification DAG in which every candidate cites a passed parent and
changes one topology axis. Record impossible standalone axes explicitly; add
that axis to the nearest certified parent instead of pretending an unsupported
P0 comparison exists.
