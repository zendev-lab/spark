---
title: Agent tools and permissions
description: Understand how Spark activates tools, owns their state, and applies effect and permission policy.
---

The active tool schemas supplied to an Agent by its Host and Session are the
authoritative tool surface for that run. Registration does not imply
activation: surface, mode, permission, extension configuration, and compatibility
policy can all narrow the available set.

This page documents stable domains and policy. It is intentionally not an
exhaustive list of tool names. Inspect the active schemas shown by the Host when
you need the exact names, actions, and arguments for a run.

## Stable tool domains

Spark groups related actions behind canonical `tool({ action })` surfaces when
they share one owner, state, permission, rendering, and result contract.

| Domain | What it is for | Authoritative owner |
| --- | --- | --- |
| Human interaction | Structured questions, approvals, and correlated answers | Shared interaction protocol and daemon lifecycle |
| Files and execution | Read, search, edit, and approved local execution | Host adapters operating in the selected workspace |
| Work coordination | Tasks, sessions, Goals, Loops, Repros, and Workflows | Their domain owner; durable scheduling remains daemon-owned |
| Result ownership | User-facing outcomes and internal Evidence | Artifact and Evidence stores remain separate |
| Agent composition | Roles and owner-bound Skill Agents | Session/Role registry and Skill loader |
| External adapters | Channels, ACP, MCP, Git, and provider-specific capabilities | The owning adapter behind Spark contracts |

## Artifacts and Evidence

User-facing Artifact kinds are exactly `issue | git_change | document`.
A `git_change` owns one worktree and one native PR stack; a preview is a
Document view, not another Artifact kind.

Evidence records internal claims and verification. Artifact and Evidence refs
use separate namespaces, stores, permissions, and lifecycle rules. A tool must
not silently promote a file path, transcript statement, or unverified result
into either one.

## Roles, Sessions, and Skill Agents

- A Role defines a typed capability and responsibility profile, including its
  semantic Model Type and `persistent` or `owned` instantiation policy.
- A Session is the runtime instance that owns continuity, bindings, calls, and
  mail. Owner-bound child Sessions are non-restorable and close with their
  parent operation.
- `skill_agent({ skills, instruction, inputs? })` resolves one to eight exact
  Skills and runs one fresh owned child Session with every selected Skill body
  loaded once. It receives the explicit packet, not the parent transcript, and
  cannot recurse into Roles, Skill Agents, or persistent Sessions.

Role and Skill Agent children select models through semantic Model Types. A
missing binding fails with `role_model_type_unconfigured`; Spark does not fall
back to the parent Session model. On close, an owned child seals a bounded
receipt before discarding its full transcript and Invocation payload. The
receipt is operational Session metadata rather than Evidence.

The parent Session remains responsible for decomposition, durable coordination,
verification of consequential claims, and user-facing synthesis.

## Effects, approval, and parallelism

Every active tool carries an effect and permission policy enforced by the Host.
Unknown or conflicting policy fails closed.

- Pure reads that explicitly allow parallel execution may run concurrently.
- Writes, policy changes, mixed batches, and external side effects remain
  serialized unless their owning contract proves a safe alternative.
- A required approval is part of execution authority, not presentation text.
- Compatibility and Channel profiles may expose a smaller set than the native
  TUI or Hub Session.

Private implementation helpers are not public tools. For the commands available
in your installed version, see [command discovery](/reference/cli/).
