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

Starting a Goal, Loop, or Repro gives that driver bounded authority for its
confirmed objective, Workspace, repository, and writable targets. While it is
active, the driver may perform `manual_only` operations without asking again.
Those operations must be low-risk and reversible; creating, updating, and
synchronizing a Draft PR are examples.

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

Repro organizes evidence-gated work into Implementation Explore, Exactness
Explore, and Formalize. The two Explore lanes may proceed independently but do
not advance normative progress. Only an accepted Formalize retirement updates
`formalizedTip`; that value is distinct from the current Git Change stack tip.

Implementation hands candidates forward to Exactness, and Exactness hands
verified candidates to Formalize. Resolutions flow backward to retire temporary
work. An Exactness mismatch records the first bad boundary, classification,
confidence, and disposition; skipping a check requires both isolation and a
resynchronization point. Repro pauses instead of guessing when a baseline,
material authority decision, or `required` approval is missing. Use
`/inspect repro` to inspect the bounded daemon projection in the TUI.

`/repro <objective>` immediately reserves three stable child Sessions in the
owning Workspace. The Workspace may contain zero, one, or many repositories;
launch does not assume that cwd is a repository and does not preselect a Git
Change. Each lane discovers and constructs the repository/worktree topology its
work needs. Implementation runs first; terminal TaskRuns automatically advance
Exactness, Formalize, and the two backward refreshes. Persisted routes, bindings,
receipts, Evidence refs, and logical revisions are the checkpoints. They do not
live in the Root transcript.

You may compact the Root or a lane Session while Repro is active. A continuation
reloads the durable checkpoint and reuses the same lane Sessions; it must not
replay the launch. If a lane needs attention, the Ask appears on Root and
survives daemon restart or context compaction. Your answer resumes the original
lane Session and Git Change.

```text
/repro <objective>
/repro status
/repro stop
/repro restart [objective]
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
