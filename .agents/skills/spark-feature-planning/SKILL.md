---
name: spark-feature-planning
description: Use when designing a Spark feature or writing or materially revising a design proposal that needs repository-first research, user input on unresolved key choices, and an owner-aligned implementation plan before code changes.
---

# Spark feature planning

Turn a requested capability into an evidence-backed decision and the smallest
plan that can prove it.

## Procedure

1. Reconstruct the user problem and current behavior from the owning code, specifications, package README, nearby tests, and machine-readable inventory.
2. Separate repository facts, external facts, assumptions, constraints, and unresolved product decisions. Research questions whose answers can change the selection or acceptance boundary before drafting a direction. Verify external claims against current primary sources such as official documentation, source code, or papers; record sources and applicable versions. If necessary evidence is unavailable, identify the gap and continue only work independent of it.
3. Compare the status quo and viable options against owner fit, semantic duplication, dependency direction, compatibility cost, lifecycle and failure modes, operational burden, and validation cost.
4. Before settling a proposal or plan, ask the user about unresolved choices that change scope, user-visible behavior, authority, ownership, compatibility, or long-term cost. Present viable options with a recommendation, evidence, and the main tradeoffs; ask root choices before dependent questions. Do not ask the user for facts available from the repository or manufacture options to fill a list.
5. Select a direction only after obtaining the key choices. Reuse explicit user choices and applicable existing decisions without asking again; cite their basis. If the user explicitly delegates a choice, decide within those constraints and record the delegation and rationale. A request to write a proposal alone is not a choice or delegation. Explain why rejected options lose without inventing future requirements.
6. Produce a dependency-ordered plan whose first slice proves the highest-risk behavior. Name the owner, affected surfaces, observable acceptance criteria, failure cases, compatibility evidence, documentation owner, and validation commands.
7. Keep adjacent cleanup and speculative extensibility out of the feature plan. Record them as rejected or out of scope rather than prebuilding them.

When a key choice is unresolved, actually ask the user and mark the dependent
selection and plan `needs-decision`. Returning an open-question list alone does
not complete that step. Do not first write a complete proposal that assumes the
answer, treat silence as agreement, or implement the dependent behavior while
waiting. Continue independent research and unaffected draft sections, clearly
marking open alternatives. Resolve routine reversible details independently;
editorial corrections and implementation of existing decisions do not reopen
settled choices or require a new proposal.

Record research evidence, the basis of each selection, rejected alternatives,
and unresolved questions in the existing result fields. A user choice establishes
the design direction, not proposal acceptance or implementation authority.
Return `problemEvidence`,
`options`, `selection`, `plan`, `acceptanceCriteria`, `risks`, `outOfScope`,
`validationCommands`, `openQuestions`, and `verdict`.
