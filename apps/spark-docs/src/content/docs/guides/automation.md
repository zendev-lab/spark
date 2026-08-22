---
title: Automate long-running work
description: Choose a goal, loop, reproduction, or workflow only after the ordinary plan-and-execute path is not enough.
---

Start with [plan and implement](/guides/plan-and-execute/) for ordinary
project changes. Choose automation when the work must continue autonomously
across multiple steps, repeat, follow reproduction gates, or use a saved
procedure.

If you do not know which mode fits, use:

```text
/automate
```

The picker only pre-fills one of the canonical commands below. It does not
start work or create a fifth automation mode.

| Need | Use | Example |
| --- | --- | --- |
| Continue until a defined outcome is complete | Goal | `/goal start Finish the release checklist` |
| Repeat open-ended work | Loop | `/loop start Watch for new failures and triage them` |
| Reproduce a model or system with evidence at each milestone | Repro | `/repro Reproduce model X in framework Y` |
| Execute a saved, staged procedure | Workflow | `/workflow run builtin:research Compare the two designs` |

## Authority while a driver is active

Starting a Goal, Loop, or Repro on an interactive session asks once whether
that Session may use driver authority. If you grant it, the driver may perform
`manual_only` operations without asking again while it remains active. CLI,
API, and other non-interactive starts record the same Session grant silently
and do not prompt. If you keep per-tool approval, `manual_only` operations
still require human approval even while a driver is active.

Those operations must be low-risk and reversible; creating, updating, and
synchronizing a Draft PR are examples. Driver authority stays inside the
confirmed objective, Workspace, repository, and writable targets.

This does not authorize `required` operations. Destructive, irreversible,
security-sensitive, costly, high-impact, or materially scope-expanding actions
always need human approval, as do release, deployment, merge, and promotion of
a Draft PR to Ready. When the driver stops, completes, or is replaced,
that driver's authority expires. Later continuation uses manual approval
behavior when no driver is active.

A WorkflowRun is an execution mechanism, not a continuation driver. It inherits
the approval context of the driver that started it only while that authority
remains active, and grants or retains no authority by itself.

## Goal

A goal keeps working toward one durable outcome and stops when it completes,
fails, or needs your input.

Goal remains one runtime line. Its `active`, `waiting_decision`, `paused`, and
`complete` presentation is derived from the TaskGraph; a pending decision does
not prevent unrelated ready Tasks from continuing.

```text
/goal start <objective>
/goal status
/goal stop
/goal restart [objective]
```

## Loop

A loop is intentionally open-ended. It continues only after the current step
schedules another one.

```text
/loop start <objective>
/loop status
/loop stop
/loop restart [objective]
```

Use `/loop fresh <objective>` when each step should run in a fresh owned child
Session while keeping the same Workspace state. The child closes after the
tick and normally discards its full transcript. Before removal, the daemon
seals a bounded close receipt from the tick result. A driver-lifetime Loop
instead seals its final evaluation result when that driver Session closes.
The parent retains bounded activity, usage, and explicit Evidence without
receiving either receipt as a transcript message.

## Repro

Repro organizes evidence-gated work into three stable child Sessions:
Implementation, Exactness, and Formalize. It follows five daemon-owned
checkpoints: Implementation, Exactness, Formalize, Exactness refresh, and
Implementation refresh. Only Formalize may set the accepted
`formalizedRevision`. Use `/inspect repro` to inspect the bounded projection.

`/repro <objective>` immediately reserves three stable child Sessions in the
owning Workspace. The Workspace may contain zero, one, or many repositories;
launch does not assume that cwd is a repository and does not preselect a Git
Change. Each lane discovers and constructs the repository/worktree topology its
work needs. Implementation runs first; strict terminal TaskRun Evidence
automatically advances the remaining checkpoints. The daemon-owned v10 record,
TaskGraph, Evidence, and Session registry are recovery truth. They do not live
in the Root transcript.

You may compact the Root or a lane Session while Repro is active. A continuation
reloads the durable checkpoint and reuses the same lane Sessions; it must not
replay the launch. If a lane needs attention, the Ask appears on Root and
survives daemon restart or context compaction. Your answer creates a new attempt
in the same checkpoint and lane Session.

```text
/repro <objective>
/repro status
/repro stop
```

`/repro start <objective>` remains an explicit spelling of the same start.

## Workflow

Use one canonical command to discover, run, and control workflows:

```text
/workflow
/workflow list
/workflow run <builtin:foo|workspace:foo|user:foo> [focus]
/workflow runs [runRef]
/workflow inspect <runRef>
/workflow pause <runRef>
/workflow resume <runRef>
/workflow stop <runRef>
/workflow restart <runRef>
/workflow save <runRef>
/workflow ack <runRef>
```

The empty `/workflow` command opens the picker. Existing commands such as
`/workflows`, `/workflow-runs`, and `/workflow-pause` remain executable as
compatibility aliases but are hidden from the normal command catalog.

Spark includes three repository-owned engineering workflows:

- `workspace:repo-change` runs an already-bounded change through owner scoping,
  implementation, independent review, and delivery verification;
- `workspace:maintainability-change` establishes the behavior baseline, reviews
  correctness and unnecessary complexity, applies a bounded set of equivalent
  improvements, then reruns independent review;
- `workspace:feature-change` separates repository/external research,
  architecture selection, planning, implementation, and independent review.

Changes to `.agents` knowledge add an independent curator review. Each workflow
returns structured accepted or rejected evidence; none creates, pushes, merges,
or publishes a pull request.

## Supervise instead of memorizing states

Use `/help` for the short everyday path, `/help commands` for grouped commands,
and `/help all` only when diagnosing aliases or extension registration.

When automated work needs a decision, answer it in the current Session or
open `/inbox`. Hub Web provides Session activity plus Tasks, Artifacts, and
Inbox views.
