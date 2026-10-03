# 2026-08-18: Driver authority consent

## Decision

`manual_only` bypass requires a persisted Session fact, not a live loop
binding:

- Store `driverAuthority?: "granted" | "denied"` on Session workspace state
  (`sessions/{key}/state.json`, version 4).
- Grain is the Session. One consent covers later Goal, Loop, and Repro drivers
  on that Session.
- Interactive hosts (`hasUI === true`) ask once via `askFlow`
  (`spark.driver-authority`) at the first `manual_only` dispatch that would
  bypass approval. They do not ask at `loop.start`; daemon ticks have no UI.
- Non-interactive hosts (CLI, API, daemon ticks) persist a silent grant and
  must not prompt.
- Denied consent degrades `manual_only` to per-tool approval. It does not fail
  the driver.
- Binding alone is not consent. Sync `toolRequiresApproval` fail-closes unless
  `driverAuthority === "granted"`.
- Unanswered or blocked UI returns denied for the current turn and does not
  persist, so a missing transport cannot mint a durable grant or denial.

The daemon broker currently settles `askFlow` and `toolApproval` only.
Consent therefore uses `askFlow`, not `confirmation`.

## Rationale

Trusted driver context previously treated any Goal/Loop/Repro binding as
authority. That let interactive starts and some model-triggered recoveries
bypass `manual_only` without a user grant. Session-grained consent keeps the
ask once per working context, while silent grant keeps CLI/API send and
daemon recovery unblocked.

## Consequences

Workspace state migrates 1–3 → 4 on load. Mode writes must preserve
`driverAuthority`. Spark-turn reads the fact and an optional host hook; it
does not persist and does not depend on `spark-loop`.

Accepted residual risk: a non-interactive `repro({ action: "status" })` path
that starts a loop still silently grants. Closing that hole needs a separate
escalation-vs-recovery classification, not a prompt in headless callers.
