---
name: cue
description: |
  Use when cue-shell is the active command backend and shell execution must go
  through its structured jobs, scripts, schedules, scopes, and history tools.
  Applies when choosing between cue_exec, cue_run, cue_script, script_run, and
  script_eval; composing cue-shell operators; or managing durable work.
---

# cue

Use the Cue tools for command execution. cue-shell is a direct-exec process
runtime with its own composition grammar; it is not a Bash-compatible shell.

## Execution contract

- Run ordinary commands with `cue_exec`. Pass the working directory through its
  `cwd` parameter instead of relying on a preceding `cd`.
- The host selects the active cue-shell transport profile. Local profiles may
  start a local daemon; SSH profiles connect through the configured gateway and
  do not start the remote daemon.
- A remote `cwd` must exist on the remote host.
- Do not assume credential-like environment variables are forwarded. Treat
  values returned by `cue_scope` as intentionally redacted.
- Leave `pty=false` for normal commands. Use `pty=true` only for a command that
  requires terminal semantics; direct the user to the Cue TUI for sustained
  interactive work.

## Choose the tool

| Need | Tool |
| --- | --- |
| Run a direct command | `cue_exec` |
| Run a `.cue` file | `cue_run` |
| Run an inline `.cue` body | `cue_script` |
| Run a file in an explicit generic language | `script_run` |
| Run inline code in an explicit generic language | `script_eval` |
| List, inspect, wait for, or stop jobs | `cue_jobs` |
| Inspect resource providers and snapshots | `cue_resources` |
| Add, list, pause, resume, or remove schedules | `cue_schedule` |
| Inspect or update session cwd/environment state | `cue_scope` |
| Read recent job, schedule, or global history | `cue_history` |

The active tool schema is authoritative for parameters. In particular,
`cue_run` is the native `.cue` file operation; `script_run` is not its alias or
replacement. Use `script_run` or `script_eval` only when the language is
explicit and generic script execution is intended.

For resource-gated work, pass `cue_exec` a `needs` object whose keys omit the
`need.` prefix, for example `needs={ gpu: 1, gpu_mem: "24GiB" }`. Do not embed
`:run(need...)` in the command.

## Compose commands

cue-shell tracks a direct command as a job and provides native operators:

| Operator | Meaning |
| --- | --- |
| `\|>` | Pipe stdout to the next command within one job |
| `\|&>` | Pipe stdout and stderr to the next command within one job |
| `\|!>` | Pipe stderr to the next command within one job |
| `&&` | Run the right command if the left command succeeds, within one job |
| `\|\|` | Run the right command if the left command fails, within one job |
| `->` | Run the next tracked job after success |
| `~>` | Run the next tracked job regardless of failure |
| `\|\|\|` | Run tracked jobs concurrently |
| `\|?\|` | Run tracked jobs concurrently and stop after one succeeds |

Precedence is pipeline, then job logic, then parallel/race chains, then serial
chains. Use parentheses when grouping matters.

```text
cue_exec(command="cargo build -> cargo test")
cue_exec(command="cargo clippy ||| cargo test")
cue_exec(command="(cargo build ||| cargo audit) -> cargo test")
```

## Avoid shell assumptions

Do not write Bash syntax and expect cue-shell to expand it:

| Avoid | Use instead |
| --- | --- |
| `cmd1 \| cmd2` | `cmd1 \|> cmd2` |
| `cmd1 & cmd2` | `cmd1 \|\|\| cmd2`, or a background job |
| `ls *.pdf` | `find . -name '*.pdf'` |
| redirects such as `2>/dev/null` | inspect the job's separate stderr |
| command substitution such as `$(date)` | split the work into explicit jobs or a script |
| heredocs or fragile nested `-c` quoting | write a script file and use the matching script tool |
| `cd /path` before another call | pass `cwd="/path"` to the call |

Use `&&` and `||` only when both commands should remain inside one job. Use
`->` and `~>` when each step should be a separately tracked job.

## Durable and scheduled work

Start long-running work in the background, retain the returned ID, and inspect
it through `cue_jobs` or `cue_history`:

```text
cue_exec(command="npm run dev", background=true)
cue_jobs(action="status", id="J42")
cue_jobs(action="wait", id="J42", timeout=120)
cue_jobs(action="stop", id="J42")
```

Each leaf of a chain has its own job ID. Inspect a leaf when the aggregate chain
summary does not contain enough detail.

Before adding a recurring schedule, run the command directly and then test a
one-shot delayed schedule such as `in 30s`. Create the recurring schedule only
after both succeed.

Use the Cue TUI for foreground PTY attachment, ongoing interaction, or visual
scope inspection. Programmatic tools are better for bounded execution and
state reads.

## Failures and bounded output

- A failed synchronous call includes bounded stderr. Read job status/history
  before rerunning or increasing output limits.
- Output is intentionally bounded. Increase `tail_bytes` only when the missing
  tail is necessary for the current decision.
- Foreground wait expiry can detach while the daemon job keeps running. Use the
  returned ID to wait for or stop it; do not assume a client timeout killed it.
- For non-UTF-8 output, typed/base64 fields are the exact representation and
  model-visible text may be lossy.

## Transport recovery

For a local profile, confirm that `cued` is installed and inspect it with
`cued status`; start it with `cued start` when automatic startup fails. For an
SSH profile, diagnose the configured gateway and start the remote daemon
explicitly before retrying. Do not interpret a remote connection failure as a
local daemon failure.
