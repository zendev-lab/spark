# 2026-08-14: Agent operating model

## Decision

Spark separates automatically applied standing orders from on-demand engineering knowledge and executable agent composition:

- `AGENTS.md` supplies stable standing orders.
- Agent Notes hold internal contracts, decisions, and runbooks without entering runtime context.
- a Role supplies one responsibility and an authority ceiling, and may declare ordered Skills that are resolved and preloaded before its Session is created;
- a Skill supplies a reusable task decision procedure routed by a `Use when ...` description;
- `skill_agent` is reserved for ad-hoc, self-contained capability execution when no predefined Role owns the responsibility;
- a Workflow owns stage order, structured handoffs, parallel validation, rejection, and completion conditions.

A predefined Role follows its preloaded Skills directly in the same Session. It does not call `skill_agent` for them. Role definition revisions include ordered Skill names; execution composition revisions also include exact Skill source digests.

## Rationale

This keeps identity and authority stable while allowing methods to be reused and revised independently. Progressive disclosure limits standing context, and content-addressed composition makes an executed Role reproducible without turning Notes into another runtime knowledge system.

Standing orders form the independent base layer: repository and ordinary
subtree `AGENTS.md` files must remain interpretable without linking to Agent
Notes, Roles, Skills, or Workflows. Agent knowledge may depend on standing
orders, never the reverse.

## Consequences

Each fact has one authoritative home. Role bodies stay small, Skills contain method, and Workflows contain orchestration. Missing, disabled, non-model-invocable, or oversized Role Skills fail before child Session creation. Roles without Skills keep their previous execution behavior.
