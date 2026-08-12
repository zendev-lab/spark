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

## Authority while a driver is active

Starting a Goal, Loop, or Repro gives that driver bounded authority for its
confirmed objective, Workspace, repository, and writable targets. While it is
active, the driver may perform `manual_only` operations without asking again.
Those operations must be low-risk and reversible. Creating or updating a Draft
PR with `git submit` is the canonical example. `git sync` remains
approval-required because it can discover remote-only stack members.

Starting or reactivating a driver is itself a human-authorized authority grant.
An agent cannot turn a manual continuation into a driver on its own, and an
explicitly stopped Repro is not silently restarted by status or recovery.

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

Repro guides evidence-gated work through setup, scaffold, reproduce, scale,
and deliver. It pauses instead of guessing when a baseline, material authority
decision, or `required` approval is missing.

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

## Supervise instead of memorizing states

Use `/help` for the short everyday path, `/help commands` for grouped commands,
and `/help all` only when diagnosing aliases or extension registration.

When automated work needs a decision, answer it in the current Session or
open `/inbox`. Hub Web provides Session activity plus Tasks, Artifacts, and
Inbox views.
