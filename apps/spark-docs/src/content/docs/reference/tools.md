---
title: Agent tools
description: Complete catalog of canonical Spark tools, default profiles, side effects, and restricted surfaces.
---

Agent tools are model-facing capabilities, not commands users must memorize.
Describe the outcome first; inspect this page when auditing permissions,
building a host profile, or diagnosing why a capability is unavailable.

## Default native profile

| Intent | Canonical tools | Effect |
| --- | --- | --- |
| Ask for a decision | `ask` | Pauses for structured user input |
| Read and change files | `read`, `write`, `edit`, `grep`, `find` | Read or workspace write |
| Manage code delivery | `git` | Worktree, native PR-stack, commit, submit, sync, and cleanup lifecycle |
| Search and fetch the Web | `web_search`, `code_search`, `fetch_content`, `get_search_content` | External read; fetched text is untrusted |
| Inspect and change work | `task_read`, `task_write`, `assign`, `todo` | Task/session state; assignment may execute work |
| Preserve results | `artifact`, `evidence`, `memory`, `context` | Product output, internal ledger, memory, bounded context |
| Coordinate agents | `role`, `skill_agent`, `session` | Definitions, anonymous calls, dedicated multi-Skill Agents, persistent sessions, and mail |
| Choose models | `models` | Model catalog and selection |
| Choose Session behavior or autonomous continuation | `mode`, `goal`, `loop`, `repro` | Session `plan`/`execute` mode plus daemon-owned continuation state |
| Discover and run procedures | `workflow` | List, read, or run a selected `WORKFLOW.md` definition |

The file tools in this table are the Spark-native surface. The external Pi
product retains its own file and search tools; Spark does not replace Pi's
`read`, `write`, `edit`, `grep`, `find`, or `ls` implementations. Pi product
compatibility is additive and intentionally does not promise full Spark-native
feature parity.

`artifact` is user-facing and limited to Issue, GitChange, and Document
deliverables. GitChange owns one worktree and one native GitHub PR stack;
`git({ action })` owns that lifecycle. Preview is a view of a Document, not an
Artifact kind.
`evidence` is an agent-internal ledger and is not shown as a artifact.
`context` can only list or preview registered bounded providers; it does not
accept an arbitrary prompt.

`skill_agent({ skills, instruction, inputs? })` resolves one to eight exact
model-invocable Skills and runs one fresh anonymous dedicated Agent with every
selected Skill body loaded in full exactly once. The Agent receives the
self-contained instruction and bounded inputs, not the parent transcript. It
can use a bounded direct-work tool profile, but cannot recurse into Roles,
Skill Agents, or persistent Sessions, mutate coordination state, or publish
Git, Artifact, or Evidence state. Use `read` instead when the parent Session
itself must inspect and follow `SKILL.md`.

## Shell and script tools

The native profile includes ten cue-shell tools:

| Tools | Purpose |
| --- | --- |
| `cue_exec`, `cue_run` | Direct commands and managed jobs |
| `cue_script`, `script_run`, `script_eval` | Saved or inline controlled scripts |
| `cue_jobs` | Inspect and control jobs |
| `cue_resources` | Inspect resource providers and snapshots |
| `cue_schedule` | Manage schedules |
| `cue_scope` | Inspect or manage execution scopes |
| `cue_history` | Read execution history |

These tools can execute code or cause local/external side effects. Host policy
resolves approval, effect, and sequential/parallel behavior before execution.
Unknown or conflicting policy fails closed.

## Restricted and optional profiles

- Message-platform channels expose only `session`, `ask`, `context`, and
  `todo`.
- `fusion` is opt-in bounded multi-model deliberation. It does not write the
  final answer or prove a runtime claim.
- `graft` is a sealed, opt-in scratch/candidate/patch capability and is not
  part of the active Git workflow.
- `ls` remains available only to an explicitly configured Spark-native
  compatibility profile; it is not registered in the native default profile.
  Use `find` for file discovery and `grep` for content search.
- External Pi compatibility may expose a smaller additive subset. A capability
  is removed when its compatibility cost exceeds its retained product value.

Private implementation and orchestration helpers are deliberately absent from
this public catalog.

## Execution policy

Registration does not guarantee activation. A host may narrow the active tool
set by surface, mode, permission, or extension configuration. Only
approval-free read calls explicitly marked parallel may execute concurrently;
mixed, unknown, write-capable, policy-changing, and external-effect batches
remain sequential.
