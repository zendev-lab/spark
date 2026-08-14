# Agent knowledge instructions

This subtree contains versioned project assets for coding agents. Keep machine-local worktrees outside version control as required by [`.gitignore`](./.gitignore).

## One home per fact

- Put stable automatically applied constraints in the nearest `AGENTS.md`.
- Put internal contracts, dated decisions, and runbooks in `notes/`; Notes are read on demand and are never runtime-loaded context.
- Give each Role one responsibility. Its body contains only responsibility, authority, stop conditions, and output contract; bind reusable methods through ordered `skills`.
- Put reusable task decision procedures in Skills. Every Role and Skill description starts with `Use when ...` so routing follows the same rule.
- Put stage order, handoffs, parallel boundaries, rejection rules, and completion conditions in Workflows.
- Keep public behavior in `apps/spark-docs` and implementation contracts in their authoritative code or machine-readable inventory.

Link to the authoritative home instead of copying it. When ownership changes, update active inbound links in the same change.

## Progressive disclosure

Root and subtree `AGENTS.md` files should stay short enough to apply on every task. Role Sessions preload only their declared Skills, in declaration order. Skill references are read from the Skill directory only when needed. Workflows pass bounded structured handoffs rather than concatenating transcripts. Notes never gain a runtime loader.

Knowledge assets may cite repository standing orders. `AGENTS.md` files outside
this subtree must not link back into this subtree or require its contents to
interpret their standing orders.

Do not add lifecycle, supersession, or archive metadata to Notes without an explicit owner and enforced need. Do not modify archived public documentation unless the task targets an archive.
