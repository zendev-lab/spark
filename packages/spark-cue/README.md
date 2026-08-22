# spark-cue

Reusable host-neutral capability that exposes Cue as a durable, observable execution substrate.

`@zendev-lab/spark-cue` is infrastructure: it stays independent from Spark product composition and can be reused by supported host adapters.

Host adapters consume `@zendev-lab/spark-cue/operations`. Its
`createCueToolRuntime(config)` API is the single host-neutral owner of parameter
normalization, IPC, connection reuse, idempotent retries, cancellation,
environment filtering, SSH cwd selection, and daemon lifecycle. The daemon
product adapter and the DSH adapter translate their host contracts into this
runtime rather than reimplementing Cue behavior.

## Transport profiles

`@zendev-lab/spark-cue` uses Cue's client transport resolver (`cue-client target resolve --json`, falling back to `cue client target resolve --json`). It supports both local Unix socket profiles and SSH profiles.

Spark preserves the host `PATH` and also searches the standard user install locations used by Cue's supported installers: `UV_TOOL_BIN_DIR`, `~/.local/bin`, and `${CARGO_HOME:-~/.cargo}/bin`. This keeps native TUI and daemon sessions independent of the narrower `PATH` commonly inherited from GUI launchers and service managers.

For SSH profiles, `@zendev-lab/spark-cue` spawns the system OpenSSH client as:

```text
ssh <destination> <gateway_command>
```

The gateway command is usually `cued gateway --stdio`, so the Node client speaks the same length-prefixed IPC protocol through the SSH stdio stream. Remote daemon startup remains explicit: `@zendev-lab/spark-cue` does not run `start_command` or auto-start remote `cued`; start it separately, for example with `ssh host "cued start"`. If the remote gateway is unavailable, the tool fails loudly with bounded trailing SSH stderr diagnostics.

When an SSH profile is active, daemon-side paths such as `cwd` and Python `script_run` paths must exist on the remote host. Spark never maps the local session path onto the remote host: provide an absolute `cue_exec.cwd` or configure `SPARK_CUE_REMOTE_CWD` in the trusted host/profile. `cue_run` reads its `.cue` source locally and sends the body over IPC, so its path is only a source label on the remote side. Spark file tools still operate on the local session cwd.

Session handshakes omit credential-like environment variables by default, including tokens, passwords, API/access keys, cookies, DSNs, and common database URLs. Set `SPARK_CUE_FORWARD_SENSITIVE_ENV=1` only for an explicitly trusted target that must inherit them. `cue_scope` always redacts sensitive values before returning environment text to the model.

## Tools

Resource-oriented tools:

- `cue_exec` — submit one typed Cue execution through the active transport profile. Local tool/API runs use the immutable Spark session cwd by default; relative overrides resolve from it. SSH runs require an absolute remote cwd or `SPARK_CUE_REMOTE_CWD`. Runs use pipe mode (`pty: false`) by default; set `pty: true` only when a command genuinely needs terminal semantics. Foreground aborts cancel the daemon execution and wait for it to stop. Foreground wait-budget expiry detaches and leaves the execution running; only an explicit abort/`cue_jobs action=stop` terminates it. Results expose one `executionId`, stable process `stepIds`, and bounded per-stream output metadata.
- `cue_run` — compile the direct-execution subset of a `.cue` file locally and submit one fail-fast typed execution. Top-level command expressions execute sequentially; directives such as `:cd`, `:env`, and `:run(...)` are rejected explicitly. Results expose only Execution/Step identities.
- `cue_script` — compile an inline direct-execution `.cue` body into the same typed execution form. Use this when the script content is generated in the Pi session; prefer `cue_run` when a real `.cue` file exists on disk. The same `:cd`, `:env`, and `:run(...)` rejection applies.
- `script_run` — run a script file with an explicit `language`. Supported values are `cue` and `python`; Cue input is compiled locally into one `ExecutionSpec`, while Python runs through `uv run --script <path>` (or `uv run --python <venv>/bin/python --script <path>` when `venv` is supplied) in the selected Cue transport environment.
- `script_eval` — run an inline script body with an explicit `language`. Inline Python is piped to `uv run --script -` so it runs as a uv script in the selected Cue transport environment; `venv` selects `<venv>/bin/python` via `uv run --python <venv>/bin/python --script -` and is valid only for `language: "python"`. Tool-call rendering shows a fixed, bounded preview of the leading inline code.
- `cue_jobs` — list, inspect, wait for, and cancel executions via `action`. The retained tool name is a host-facing compatibility surface; IDs and results are strictly `E<n>` executions and `E<n>/S<n>` steps. Cancelled executions retain a structured `user` or `forced` reason while their terminal identity remains the original immutable execution ID.
- `cue_resources` — inspect resource providers and snapshots via `action: "providers"` or `action: "resources"`.
- `cue_schedule` — add/list/pause/resume/remove typed schedule templates (`T<n>`). Every trigger creates a fresh execution.
- `cue_scope` — inspect or update Cue's tool-local scope. It supports list/env/config/status, env set/unset, PATH prepend, cwd changes, and explicit host refresh. It never changes the immutable Spark session cwd. Scope lists omit env unless requested; sensitive values are always redacted from model-visible output.
- `cue_history` — recent history only by default; `limit` and `tail_bytes` are passed to `cued` when supported and must be positive.

## Resource-gated commands

```text
cue_resources(action="providers")
cue_resources(action="resources")
cue_exec(command="uv run --script train.py", needs={ gpu: 1, gpu_mem: "24GiB" }, background=true)
cue_exec(command="run-licensed-tool", needs={ license: 1 })
```

Use `needs` for resource requirements. Do not include `:run(need.gpu=1)` in `command`; `@zendev-lab/spark-cue` already wraps `command` in `:run(...)` and encodes `needs` as `need.<key>=<quantity>` mode params.
