# `@zendev-lab/spark-lens`

Internal, revision-safe primitives for Spark Lens.

This package owns the provider/session contract, capability-route ADT,
workspace revision capture, normalized observations, and fail-closed verdicts.
It has no production dependencies and performs no durable writes.

The internal Agent surface is one action ADT:

```text
lens status | inspect | check | fix | triage | verify
```

`inspect` returns revision-bound read locators rather than copying source;
`check` records current Observations without claiming completion; `fix` accepts
only Provider-created Patch Proposals; and `verify` is the only action that can
write a durable Pass receipt. Git-change verification additionally requires a
clean worktree, matching local and PR head SHAs, and an explicit complete set of
passing required GitHub checks.

The Spark daemon is the sole owner of provider processes and sessions,
cancellation, caches, persisted observations, and verification receipts.
Provider output is affirmative only when it is bound to the current workspace
revision; failure, timeout, cancellation, silence, and revision mismatch can
never become a clean result.

Profiles are fixed rather than plugin-routed. Missing fixed Providers are
reported as unavailable or inconclusive; Spark does not substitute a fallback
or auto-install repository commands. TypeScript project verification is the
currently executable profile. Python and Rust profiles remain typed inventory
until their fixed toolchains are wired to daemon sessions.

Spark Lens remains internal and unregistered by default until the release
scorecard graduates it.
