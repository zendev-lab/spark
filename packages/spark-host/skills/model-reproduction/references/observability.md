# Observability and Claim Projection

Read this when designing dumps/logs, comparing runs, or writing evidence conclusions.

## Default Symmetric Record

For each formal or diagnostic run, capture as applicable:

- raw per-step loss bits;
- per-layer forward hashes;
- named parameter/input gradients before reduction and clip;
- post-reduce/post-clip gradients;
- optimizer state, update, and model-copyback hashes;
- checkpoint inventory/readback;
- environment and source fingerprints.

Use stable one-record-per-line or structured records with identical field names/order across frameworks. Include step, layer, boundary, name, rank, shape, dtype, layout/stride, hash, run ID, and path.

## Coverage

- Forward coverage: exact named boundaries / compared named boundaries.
- Backward coverage: exact gradient tensors / compared gradient tensors.
- Element coverage: exact raw elements / compared raw elements within those tensors.
- Multi-step coverage: exact complete steps / required steps.
- Difference magnitude: at least max absolute difference; add ULP and signed-zero counts for raw floating-point investigation.

Derive denominators from actual inventories. If the inventory is incomplete, report `unquantified`; never estimate full-model coverage.

## Projection Rules

- N-step loss exact proves only N-step loss exact.
- Dumped tensors exact prove only those named tensors under that profile.
- An offline operator replay proves only that operator, shape, layout, dtype, and environment.
- Full training exact requires the complete contract's trace/artifact evidence.

Every conclusion must state scope, projection, equality rule, current-profile evidence, and Known Diff IDs consulted.
