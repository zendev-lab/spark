---
title: Agent tools
description: Complete catalog of canonical Spark tools, default profiles, side
  effects, and restricted surfaces.
slug: 0.2/reference/tools
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
| Search and fetch the Web | `web_search`, `web_fetch`, `get_search_content` | External read through `ctx.web`; fetched text is untrusted |
| Inspect and change work | `task_read`, `task_write`, `assign`, `todo` | Task/session state; assignment may execute work |
| Preserve results | `artifact`, `evidence`, `memory`, `context` | Product output, internal ledger, memory, bounded context |
| Coordinate agents | `role`, `session` | Definitions, calls, persistent sessions, and mail |
| Choose models | `models` | Model catalog and selection |
| Continue autonomously | `goal`, `loop`, `repro`, `drive`, `driver`, `phase` | Daemon driver or session-mode state |
| Discover and run procedures | `workflow`, `workflow_run` | Read saved workflows or execute a selected workflow |

`artifact` is user-facing and limited to Issue, GitChange, and Document
deliverables. GitChange owns one worktree and one native GitHub PR stack;
`git({ action })` owns that lifecycle. Preview is a view of a Document, not an
Artifact kind.
`evidence` is an agent-internal ledger and is not shown as a artifact.
`context` can only list or preview registered bounded providers; it does not
accept an arbitrary prompt.

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

* Message-platform channels expose only `session`, `ask`, `context`, and
  `todo`.
* `fusion` is opt-in bounded multi-model deliberation. It does not write the
  final answer or prove a runtime claim.
* `graft` is a sealed, opt-in scratch/candidate/patch capability and is not
  part of the active Git workflow.
* `ls` remains available only to an explicitly configured compatibility
  profile; it is not registered in the native default profile. Use `find` for
  file discovery and `grep` for content search.
* Pi compatibility aliases can be enabled by compatible hosts but are hidden
  from the native default profile.

Private implementation and orchestration helpers are deliberately absent from
this public catalog.

## Execution policy

Registration does not guarantee activation. A host may narrow the active tool
set by surface, phase, permission, or extension configuration. Only
approval-free read calls explicitly marked parallel may execute concurrently;
mixed, unknown, write-capable, policy-changing, and external-effect batches
remain sequential.
