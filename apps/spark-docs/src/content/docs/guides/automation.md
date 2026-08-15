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
| Reproduce a model or system with evidence at each milestone | Repro | `/repro start Reproduce model X in framework Y` |
| Execute a saved, staged procedure | Workflow | `/workflow run builtin:research Compare the two designs` |

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
resynchronization point.

The current user Session is the Repro Root. Each writable WorkItem in
Implementation or Exactness runs in its own managed Task Session and candidate
worktree. Formalize uses one serial canonical integrator and one Git Change;
each WorkItem becomes one Draft stack entry. Typed lane-result Evidence routes
forward automatically and then refreshes Exactness and Implementation in their
original worktrees after Formalize. Lane workers cannot Ask directly: only a
deduplicated structured decision request reaches the Root Inbox. Repro pauses
instead of guessing when a baseline, authority decision, or approval is missing.
Use `/inspect repro` to inspect binding, TaskRun, Git Change, route, and refresh
state in the bounded daemon projection.

```text
/repro start <objective>
/repro status
/repro stop
/repro restart [objective]
```

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

The repository-owned `workspace:repo-change` workflow runs owner scoping,
implementation in the current owning worktree, independent review, and delivery
verification. Changes to `.agents` knowledge add an independent curator review.
The workflow returns structured accepted or rejected evidence; it never creates,
pushes, merges, or publishes a pull request.

## Supervise instead of memorizing states

Use `/help` for the short everyday path, `/help commands` for grouped commands,
and `/help all` only when diagnosing aliases or extension registration.

When automated work needs a decision, answer it in the current Session or
open `/inbox`. Hub Web provides Session activity plus Tasks, Artifacts, and
Inbox views.
