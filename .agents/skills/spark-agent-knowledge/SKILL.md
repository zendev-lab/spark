---
name: spark-agent-knowledge
description: Use when Spark engineering knowledge must be placed, deduplicated, migrated, or validated across AGENTS, Notes, Roles, Skills, and Workflows.
---

# Spark agent knowledge

Apply one home per fact and progressive disclosure.

## Classification

- `AGENTS.md`: short, stable standing orders that apply automatically within its subtree.
- Agent Notes: internal contracts, dated decisions, and runbooks read on demand; never runtime-loaded context.
- Role: one responsibility, its authority ceiling, stop conditions, output contract, and ordered preloaded Skill names.
- Skill: a reusable task decision procedure whose description starts with `Use when ...`.
- Workflow: stage order, handoff data, parallel boundaries, rejection rules, and completion conditions.
- Public product behavior: current English and Chinese pages in `apps/spark-docs`, not Agent Notes.

## Procedure

1. Locate the enforced or runtime owner of each fact and existing copies.
2. Classify each fact before editing; link to the authoritative home instead of restating details.
3. Keep Role bodies free of methods owned by Skills. Keep Workflows free of specialist implementation instructions.
4. Update all active inbound links atomically and leave archived public docs unchanged unless explicitly requested.
5. Run the repository agent-knowledge and documentation checks that apply.

Stop when classification would make internal Notes runtime context, when public behavior would become internal-only, or when an enforced contract conflicts with prose. Return `classification`, `authoritativeHomes`, `moves`, `linksUpdated`, `validation`, and `blockers`.
