---
id: repo-change
title: Repository change
description: Run a bounded repository change through owner scoping, implementation, independent review, and delivery verification.
roles:
  - spark-architecture-guardian
  - spark-agent-knowledge-curator
  - spark-delivery-verifier
handler: orchestrate.js
stages:
  - scope
  - implement
  - review
  - verify
workbench: none
---

Use this workflow for a repository change that needs explicit owner boundaries,
an implementation in the current owning worktree, independent review, and
structured delivery evidence. The workflow never creates, pushes, merges, or
publishes a GitHub pull request.

Input:

- `instruction: string`
- `acceptanceCriteria?: string[]`
- `validationCommands?: string[]`

The result is accepted only when both guardians accept, every required
validation command has passing evidence, and the delivery verifier accepts the
diff and acceptance evidence.
