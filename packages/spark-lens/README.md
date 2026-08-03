# `@zendev-lab/spark-lens`

Internal, revision-safe primitives for Spark Lens.

This package owns the provider/session contract, capability-route ADT,
workspace revision capture, normalized observations, and fail-closed verdicts.
It has no production dependencies and performs no durable writes.

The Spark daemon is the sole owner of provider processes and sessions,
cancellation, caches, persisted observations, and verification receipts.
Provider output is affirmative only when it is bound to the current workspace
revision; failure, timeout, cancellation, silence, and revision mismatch can
never become a clean result.

Spark Lens remains internal and unregistered by default until the release
scorecard graduates it.
