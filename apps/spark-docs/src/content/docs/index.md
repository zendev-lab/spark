---
title: Spark Docs
description: User documentation for Spark across its CLI, TUI, daemon, and Hub surfaces.
template: splash
hero:
  tagline: Describe a goal, turn it into verifiable tasks, and supervise the implementation from the terminal or Hub Web.
  actions:
    - text: Get started
      link: /getting-started/
      icon: right-arrow
    - text: CLI reference
      link: /reference/cli/
      icon: right-arrow
      variant: minimal
sidebar:
  order: 1
---

Spark is a controlled coding-agent suite with one public `spark` command and
three product surfaces:

- the **TUI** for interactive work,
- the **daemon** for durable sessions and background work, and
- **Hub Web** for web-based control and projection.

Start with [installation and your first run](/getting-started/), then
[plan and implement a change](/guides/plan-and-implement/). Learn
[the complete feature map](/concepts/feature-map/) when you want to see how
CLI, daemon, TUI, Hub, tools, automation, and collaboration fit together.
Read [surface ownership](/concepts/surfaces/) only when you need to automate,
operate remotely, or diagnose the system.

## What this documentation covers

- installing the published npm product,
- choosing foreground, background, TUI, or Hub Web workflows,
- resuming workspace-bound sessions,
- supervising tasks, automation, channels, and multi-session collaboration,
- inspecting configuration and state paths, and
- diagnosing common local and remote-access failures.

The implementation repository remains the source of truth. User-facing command
examples in this site are checked against the source `spark --help` dispatcher.
