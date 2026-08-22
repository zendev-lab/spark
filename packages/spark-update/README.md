# @zendev-lab/spark-update

This owner contains the Rust library that exclusively writes Spark
managed-install, update-policy, quarantine, and rollback state. Its TypeScript
surface is a read-only build-info and deployment projection for daemon and Hub.

Native generation v2 managed installs keep immutable package versions below the Spark XDG data
directory and switch a `current` symlink atomically. A version-independent
launcher in `$PREFIX/bin/spark` is the only executable referenced by service
managers.

Global npm, pnpm, Yarn, Bun, and Vite+ installs remain owned by their package
manager. The updater detects that owner, requests one exact Spark version, and
then performs the same daemon and running-Hub handoff checks. One macOS
launchd tick owns the configured daily check; daemon and Hub do not run
competing schedulers. Schema v1 state is never modified in place; an explicit
`spark install --managed` backs up the legacy versions, state, and stable
launcher before activating a native generation.
