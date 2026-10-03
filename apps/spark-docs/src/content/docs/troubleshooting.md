---
title: Troubleshooting
description: Diagnose local web, daemon, session, path, and Hub failures in the right order.
---

## `spark tui` reports that the TUI was removed

The terminal UI is no longer shipped. Use the local workbench or a headless
surface:

```bash
spark web
spark run --json "Inspect the repository."
```

## A run or Hub Web page appears stuck

Separate frontend health from daemon execution:

```bash
spark doctor
spark daemon status --json
spark daemon logs --lines 200
```

If you have an invocation identifier, inspect its status and event stream rather
than submitting the same work again.

## `spark web` says the daemon failed to start

Read the `details` line before treating a missing socket as the root cause. The
Web launcher waits for a real daemon RPC response and reports the last new
daemon startup diagnostic when the service exits before readiness.

```bash
spark doctor
spark daemon logs --lines 100
```

Do not delete or replace daemon state as a first repair step. If the detail is
a schema or migration error, preserve the database and report the diagnostic
code, detail, Spark version, and output of `spark paths --json`.

## A session cannot be attached

Sessions are workspace-bound. Change into the same canonical workspace used to
create the session, then retry:

```bash
spark daemon session list --json
spark web
```

## Spark is reading unexpected configuration

Check the effective roots:

```bash
spark paths --json
```

Look for an intentionally set `SPARK_HOME` and relevant XDG variables. Do not
copy credentials or state between roots as a first repair step.

## The curl installer stops before installation

Check its prerequisites first:

```bash
node --version
npm --version
```

The first curl release requires system Node.js 24 or newer and npm. The
supported native targets are macOS arm64, or Linux on arm64 or x86_64. A
checksum mismatch means the downloaded release asset was not accepted: do not bypass
verification or run the temporary binary. Retry the official `latest` command,
then report the asset name and checksum failure if it persists.

## The shell still runs another global Spark

Inspect the command selected by the shell:

```bash
command -v spark
export PATH="$HOME/.local/bin:$PATH"
```

For a custom prefix, put `<prefix>/bin` first instead. The installer prints the
exact correction when the managed launcher is not the command currently found
on `PATH`.

## npm reports `NATIVE_PACKAGE_MISSING`

The CLI resolver could not load the optional native package for the current
platform. Reinstall the complete package with optional dependencies enabled.
The resolver fails closed and does not fall back to the retired Node root
dispatcher.

## A managed update failed

Inspect the persisted updater state before retrying:

```bash
spark update status --json
```

A failed candidate is quarantined and is not retried automatically. Use
`spark update retry <version> --yes` only after addressing the reported
failure. Rollback switches executable versions; it does not restore an old
database snapshot or discard sessions.

Legacy managed state is intentionally read-only to ordinary update commands.
Run `spark install --managed` to perform the explicit native cutover. Spark
backs up the old versions, state, and launcher before replacement and restores
all of them when candidate health checks fail. Keep the reported backup until
you have independently verified the new installation.

## Hub returns an error or shows no workspace

Confirm that Hub itself is running, then verify daemon health, workspace
registration, and the URL used by the daemon:

```bash
spark daemon status --json
spark daemon workspace ls --json
```

For remote access, confirm HTTPS, machine login, workspace registration, and
browser-key scope independently.

## Before retrying a failed external delivery

Do not assume a timeout means nothing was sent. Spark fails closed when an
external delivery outcome is uncertain. Retry only when the recorded result
proves the work was not sent or the provider supplies a deduplicated identity.
