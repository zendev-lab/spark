---
name: spark-find-simplifications
description: Use when a working Spark implementation should be simplified without changing its observed behavior, ownership, compatibility, or public contract.
---

# Spark simplification search

Simplify only after the behavior and validation baseline are known.

## Procedure

1. Identify the owner, public behavior, compatibility constraints, and tests that establish the current contract.
2. Find duplicate branches, overlapping adapters, unnecessary abstractions, dead compatibility paths with explicit exit criteria, and state derived in more than one place.
3. Prefer deleting indirection or moving semantics into the existing owner over introducing another framework, package, schema, or facade.
4. Compare each candidate against production callers and focused validation. Require live call-path evidence before declaring code unreachable.
5. Recommend the smallest independent simplification and the evidence needed to prove equivalence.

Stop when a simplification would alter serialization, authority, lifecycle, or user-visible behavior without explicit acceptance criteria. Return `candidates`, `evidence`, `recommendedSlice`, `validation`, and `rejectedIdeas`.
