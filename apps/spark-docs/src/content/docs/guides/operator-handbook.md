---
title: Operator handbook
description: Run Spark end to end, connect Cockpit, create sessions, inspect invocations, and recover safely.
---

This guide is the shortest complete path through a local Spark installation. It
also defines the checks to run before changing state when something goes wrong.

## Know which surface owns what

- The **daemon** owns execution, sessions, invocations, workspace bindings, and
  recovery.
- The **TUI** is the interactive terminal host. It presents daemon state and
  sends user intent to the daemon.
- **Cockpit** is the browser coordination and projection surface. It does not
  infer execution state from browser timers or transcript text.
- Product artifacts are exactly Issues, PRs, and previews. Internal verification
  evidence is a separate namespace and is not a product artifact.

When two surfaces disagree, inspect the daemon first.

## 1. Freeze the effective installation and state root

Start every investigation with read-only commands:

```bash
spark version --json
spark paths --json
spark doctor
```

`spark paths --json` is the authority for effective paths. Do not copy state or
credentials between roots to repair a problem.

For an isolated test, choose an explicit directory before starting any Spark
process:

```bash
export SPARK_HOME=/absolute/path/to/isolated-spark-home
spark paths --json
```

Every command in that test, including daemon and Cockpit commands, must use the
same `SPARK_HOME`.

## 2. Configure an authenticated model

For a 0.2.0 migration from Pi, inspect and import without starting Pi:

```bash
spark daemon auth status --json
spark daemon auth import pi --json
spark daemon model list --all --json
```

The import source is `PI_CODING_AGENT_DIR/auth.json` when that directory is set,
otherwise `~/.pi/agent/auth.json`. The command imports only registered providers
whose credential kind matches. It never expands `$ENV`/`${ENV}`, runs
`!command`, or changes the Pi file. Existing Spark credentials are preserved;
review the secret-free report before using `--overwrite`.

An all-skipped report still exits `0`. A source, parse, or Spark-store failure
exits `1` and writes nothing; invalid command use exits `2`. Fix file
readability or malformed JSON and rerun the same import. Do not copy credential
values into a diagnostic.

To configure a provider directly:

```bash
spark daemon auth login [provider]
spark daemon model set <provider/model> --default --json
```

Or open `spark`, run `/login`, then `/model`. Unavailable models remain visible
with their reason and login action, but cannot become active. Enter API keys
only in Spark's secret prompt. Do not put them in a repository, command history,
or a Cockpit registration command.

Cockpit disables conversation submission when no authenticated model is
available. A JSON CLI submission reports an actionable error:

```json
{
  "action": "error",
  "error": {
    "code": "cli_error",
    "message": "Configure a provider before selecting this model."
  }
}
```

Configure the provider, then retry the original submission once.

`spark daemon login` is unrelated: it authorizes machine connectivity to
Cockpit. Provider authentication exists only under `spark daemon auth` and the
corresponding TUI slash commands.

## 3. Start the daemon and Cockpit independently

Start and inspect the execution plane:

```bash
spark daemon start --json
spark daemon status --json
```

For a background local Cockpit:

```bash
HOST=127.0.0.1 \
PORT=5174 \
SPARK_COCKPIT_PUBLIC_URL=http://127.0.0.1:5174 \
spark cockpit web start --json

spark cockpit web status --json
```

Open the exact public URL. The scheme, hostname, and port used by the browser
must match `SPARK_COCKPIT_PUBLIC_URL`; for example, do not switch between
`localhost` and `127.0.0.1` during setup.

Use `spark cockpit` instead when you want the foreground production host. The
daemon and Cockpit are separate processes and should always be diagnosed
separately.

## 4. Create and register the first workspace

1. Open `/workspaces/new` in Cockpit.
2. Choose the fresh profile or a Git-hosted workspace profile.
3. Enter the Cockpit workspace name, URL slug, and optional description.
4. Generate the one-time registration command.
5. Change to the local directory that this workspace should own.
6. Run the generated command exactly once.
7. Wait for the connected directory to appear, then enter the workspace.

The generated command has this shape:

```bash
spark daemon workspace register . \
  --server-url http://127.0.0.1:5174 \
  --token <one-time-workspace-token> \
  --name <workspace-name>
```

The token is shown once and authorizes one directory. It is not a provider
credential or a reusable daemon login.

Verify the daemon-owned binding:

```bash
spark daemon workspace ls --json
```

During registration, the daemon may use the local directory basename as a
placeholder. After setup is finalized, Cockpit owns the configured workspace
name and URL slug; the daemon continues to own the canonical local path and
binding display name.

## 5. Create, inspect, and attach a session

Read the server workspace ID from `spark daemon workspace ls --json`, then
create a managed session:

```bash
spark daemon session create \
  --workspace <server-workspace-id> \
  --role operator \
  --json

spark daemon session list --registry --json
spark daemon session show <session-id> --json
```

For managed sessions, `role` is the stable division-of-labour identity and is
also used as the compatibility title. Run attach commands from the same
canonical workspace:

```bash
spark tui --session-id <session-id>
```

Cockpit lists the same daemon-owned session under Conversations. Creating a
second frontend does not create a second executor.

## 6. Submit and observe durable execution

Submit to a known session:

```bash
spark daemon submit \
  --session <session-id> \
  --prompt "Inspect the repository and report the validation command." \
  --json
```

Use the returned invocation ID to inspect execution:

```bash
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after 0 --limit 500 --json
spark daemon invocation result <invocation-id> --json
```

Cancel only the known invocation:

```bash
spark daemon invocation cancel <invocation-id> \
  --reason "No longer needed" \
  --json
```

For everyday work:

```bash
spark run --json "Return one foreground result."
spark bg --json "Queue durable background work."
spark bg --session <session-id> "Continue the existing work."
```

Do not resubmit because a browser looks idle. Check the invocation first; an
unknown mutation or delivery outcome must fail closed rather than replay.

## 7. Exercise the product workflow

Inside the TUI, use:

```text
/plan <goal>
/implement [focus]
/inspect
/goal start <objective>
/repro start <objective>
/workflow list
/help commands
```

`/help` is rendered locally and is never submitted as an agent prompt. `/model`
Esc cancellation is a no-op. `/status`, the action bar, and the palette execute
normal actions on one Enter. The TUI retains complete logical messages at
`60x18` and larger; use terminal scrollback instead of assuming only the final
visible row exists.

Use these surfaces together:

- **Conversations** and the TUI show daemon-owned sessions and turns.
- **Inbox** shows inline questions and approvals without moving Ask into a
  global modal.
- **Artifacts** contains only Issues, PRs, and previews.
- **Resources** contains workspace repositories, documents, URLs, files, tools,
  and secret references.
- Goal, Repro, Workflow, and background drivers remain distinct; do not collapse
  scheduled, running, retry-waiting, dormant, blocked, and stopped states.

Continue with [TUI](/guides/tui/), [runs and sessions](/guides/runs-and-sessions/),
[Cockpit](/guides/cockpit/), and [long-running work](/guides/automation/).

### Renderer status

Spark 0.2.0 keeps the Pi TUI kernel behind the private
`SparkTerminalController`. OpenTUI is an isolated candidate, not a production
dependency. Run `pnpm run audit:renderer` to see the fail-closed readiness
report. Spark will not raise its Node baseline or switch renderers until
launcher flags, native artifacts, PTY lifecycle, all four terminal sizes, and
the complete controller contract pass as reproducible gates.

## 8. Remote access

Use HTTPS or an encrypted private path for every non-loopback Cockpit.

Machine connectivity and browser access are separate:

```bash
spark daemon login --server-url https://cockpit.example
spark cockpit access create
spark cockpit workspace access create --workspace <cockpit-workspace-id>
```

- Exchange the Cockpit key at `/login`.
- Exchange the workspace key at `/{slug}/login`.
- Generate a fresh workspace registration token for every additional local
  directory.

Treat all one-time keys as secrets and never copy them into logs or PRs.

## 9. Diagnose in ownership order

### Help unexpectedly runs a command

Help is read-only at every nested surface:

```bash
spark doctor --help
spark cockpit web start --help
spark daemon session create --help
```

If a packaged installation behaves differently, compare `spark version --json`
with the source or package version you intended to run.

### Cockpit opens but setup or submission does not advance

Check the canonical origin and both processes:

```bash
spark cockpit web status --json
spark daemon status --json
spark daemon workspace ls --json
spark daemon logs --lines 200
```

Use exactly one hostname during the setup flow. If a token was consumed, mint a
new token instead of trying to recover or replay it.

### Cockpit reports that a binding belongs to another workspace

Do not delete either database. Inspect `spark daemon workspace ls --json` and
the Cockpit workspace settings. A binding can have only one active Cockpit
lease. Unbind it deliberately from the current Cockpit workspace before
registering it elsewhere.

### No authenticated model is available

Run `spark daemon auth status --json` and
`spark daemon model list --all --json`. Then use
`spark daemon auth login <provider>` or return to the TUI and run `/login`,
followed by `/model`. Cockpit should enable submission only after the daemon
reports an available authenticated model.

### A run appears stuck

```bash
spark daemon invocation list --session <session-id> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after 0 --limit 500 --json
```

Inspect before retrying. Frontend elapsed time is not execution truth.

### Spark reads unexpected state

```bash
spark paths --json
```

Confirm that the terminal, daemon, and Cockpit use the same intended root. Do
not restart a process owned by another service manager or another test root.

## 10. Stop an isolated run

Stop only the services belonging to the selected state root:

```bash
spark cockpit web stop --json
spark daemon stop --yes
```

Final acceptance checks:

```bash
spark doctor
spark daemon status --json
spark cockpit web status --json
spark daemon workspace ls --json
spark daemon session list --registry --json
spark daemon invocation list --json
```

Record the exact version, `SPARK_HOME` or XDG roots, failing command, exit code,
and invocation/session IDs when reporting a problem. Never include provider
credentials or one-time registration and browser keys.
