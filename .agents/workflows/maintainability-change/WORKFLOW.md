---
id: maintainability-change
title: Maintainability change
description: Review an existing Spark behavior for correctness and unnecessary complexity, implement bounded improvements, and independently verify equivalence.
roles:
  - spark-architecture-guardian
  - spark-maintainability-reviewer
  - spark-agent-knowledge-curator
  - spark-delivery-verifier
handler: orchestrate.js
stages:
  - scope
  - review
  - improve
  - rereview
  - verify
workbench: none
---

Use this workflow for a bounded maintainability pass over existing code or a
current pull-request diff. It establishes the observable baseline before
changing code, reviews correctness separately from whether the current shape
should exist, implements only selected independent slices, and verifies that
behavior and ownership remain unchanged.

Input:

- `instruction: string`
- `target?: string`
- `acceptanceCriteria?: string[]`
- `validationCommands?: string[]`
- `maxChanges?: number` (default `3`, maximum `5`)

The workflow rejects changes that lack an owner, a behavior baseline, an
equivalence argument, or required validation evidence. It never creates,
pushes, merges, or publishes a pull request.
