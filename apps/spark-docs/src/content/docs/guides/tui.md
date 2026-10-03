---
title: TUI
description: The Spark terminal UI has been removed. Use spark web or spark run.
---

The Spark TUI is no longer shipped. Interactive local work now uses the
loopback browser workbench; headless turns use the daemon.

```bash
spark web
spark run --json "Summarize the current repository."
```

See the [local web workbench](/guides/web/) for session attach, conversation,
and settings. Use [runs and sessions](/guides/runs-and-sessions/) for
foreground and background daemon turns. `spark tui` prints an error and exits.
