---
id: feature-change
title: Feature change
description: Research, select, plan, implement, review, and verify a bounded Spark feature through explicit owner-aligned handoffs.
roles:
  - spark-feature-planner
  - spark-architecture-guardian
  - spark-maintainability-reviewer
  - spark-agent-knowledge-curator
  - spark-delivery-verifier
handler: orchestrate.js
stages:
  - research
  - select
  - plan
  - implement
  - review
  - verify
workbench: none
---

Use this workflow when a Spark feature still needs repository or external
research, a technical choice, and a concrete plan before implementation. Each
stage receives a bounded structured handoff; research does not silently become
a product decision, and implementation cannot begin until the owner and
acceptance boundary are accepted.

Input:

- `instruction: string`
- `researchQuestions?: string[]`
- `constraints?: string[]`
- `acceptanceCriteria?: string[]`
- `validationCommands?: string[]`

The workflow stops with the unresolved decision when selection would guess
user-visible behavior, authority, ownership, or material cost. It never
creates, pushes, merges, or publishes a pull request.
