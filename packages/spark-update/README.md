# @zendev-lab/spark-update

This private workspace package is the single owner of Spark managed-install,
update-policy, quarantine, and rollback state. The public `spark` executable
only dispatches into it. The daemon and Hub may read updater state, but
must not write it.

Managed installs keep immutable package versions below the Spark XDG data
directory and switch a `current` symlink atomically. A version-independent
launcher in `$PREFIX/bin/spark` is the only executable referenced by service
managers.

Global npm, pnpm, Yarn, Bun, and Vite+ installs remain owned by their package
manager. The updater detects that owner, requests one exact Spark version, and
then performs the same daemon and running-Hub handoff checks. One macOS
launchd tick owns the configured daily check; daemon and Hub do not run
competing schedulers.
