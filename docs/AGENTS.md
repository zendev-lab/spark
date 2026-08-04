# Internal documentation agent guide

This file extends the repository-wide [`AGENTS.md`](../AGENTS.md) for changes
under `docs/`.

## Documentation boundary

This directory contains internal contracts and operator procedures:

- `docs/specs/` owns normative architecture, state, protocol, and behavior
  contracts;
- `docs/operations/` owns procedures, validation runbooks, deployment, release,
  migration execution, and rollback;
- `docs/README.md` is a concise index, not a second copy of each document.

Public installation, workflows, commands, tools, and troubleshooting belong in
the bilingual `apps/spark-docs` site. Product positioning belongs in the root
README, contribution procedure in `CONTRIBUTING.md`, and current intent or open
design direction in `SPARK.md`.

## Writing rules

- Keep one authoritative home for each fact and link to it elsewhere.
- Use normative language only for enforced or intentionally binding contracts.
- Distinguish an invariant from current implementation detail, rationale,
  migration status, and future proposal.
- Name the authoritative owner for state, policy, side effects, and recovery.
- Include invalid placements or failure behavior when ambiguity could create a
  second owner or unsafe fallback.
- Prefer stable domain vocabulary over filenames, temporary package counts, PR
  numbers, or short-lived migration status.
- Keep examples consistent with current command placement and public schemas.
- Use relative repository links and update `docs/README.md` when adding,
  removing, or renaming a spec or operation.

Do not turn a spec into an implementation diary. Move unresolved alternatives,
recent progress, and temporary sequencing to `SPARK.md` or the relevant PR.
Do not put normative policy only in comments, tests, or an operation runbook.

## Coupled changes

When behavior changes:

- update the owning spec in the same change;
- update the relevant operation when deployment, migration, recovery, or
  rollback steps change;
- update public English and Chinese documentation when users can observe or
  invoke the behavior;
- preserve archived public documentation unless the task explicitly targets a
  released archive.

A document that describes package ownership or dependency direction must agree
with `architecture/packages.json`. A document that describes public commands
must agree with the source dispatcher and user documentation.

## Validation

Use the documentation and repository validation matrix in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#validation). Check links, code fences,
terminology, final newlines, and the `docs/README.md` index before submitting a
change.
