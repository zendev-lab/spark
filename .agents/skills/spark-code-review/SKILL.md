---
name: spark-code-review
description: Use when a Spark implementation needs an evidence-based review for correctness, ownership, compatibility, failure handling, and maintainability.
---

# Spark code review

Review the actual diff and reachable behavior, using `spark-change-scope` first when the owner and acceptance boundary are not already explicit.

## Procedure

1. Reconstruct the intended behavior and authoritative owner from code, tests, and contracts.
2. Read the complete changed functions plus callers and consumers that establish externally observable behavior.
3. Check state ownership, dependency direction, protocol translation, compatibility reads/writes, authorization, cancellation, retries, and cleanup as applicable.
4. Run focused diagnostics when static inspection cannot settle a claim.
5. Report only actionable findings caused by the change. Rank them by user or system impact and identify the smallest safe correction.

Do not treat formatting preference, speculative future work, or copied prose as a defect. Do not accept tests that assert prompt wording unless exact representation is the contract. Stop with `needs-decision` when correctness depends on an unresolved product or ownership choice.

Return `findings`, `verifiedBehaviors`, `residualRisks`, and `verdict`. Each finding includes severity, evidence, impact, and repair direction.
