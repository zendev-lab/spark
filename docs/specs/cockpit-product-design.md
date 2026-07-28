# Cockpit product design contract

Cockpit is a projection and control adapter for inspectable work. It does not
own execution or infer state from prompts, transcript text, elapsed time, or
browser timers.

## Work-first session surface

- When a session has daemon-projected Goal/Repro work or any autonomous driver,
  `Work` is its default primary view. Ordinary conversations default to
  `Transcript`.
- `Work` and `Transcript` are peers. Switching views preserves the mounted
  transcript and is recoverable through `?view=work|transcript`.
- The header prioritizes the objective, current step, semantic work status, and
  pending attention. Connection health remains a separate transport indicator.
- Runtime metadata such as cwd, model, tokens, cache, and branch stays in the
  secondary inspector.

## State ownership and vocabulary

- The daemon owns execution truth. Cockpit consumes `SparkSessionView.work` and
  `drivers`; it never reconstructs work state from messages, logs, or time.
- Driver states remain
  `scheduled | running | retry_wait | dormant | blocked | stopped`. Do not
  collapse them into `working` or `idle`.
- A status needs visible text, an icon or shape, and an accessible name. Color
  alone is not a state signal.
- Missing or invalid domain state removes only the unproven projection. The
  session and driver snapshot must remain usable.

## Interaction boundaries

- Ask stays inline in its owning session. The workspace Inbox is a list/detail
  fallback; there is no global Ask modal.
- Consequential actions state their effect. Multiline composers use Enter for a
  newline and Command/Control+Enter to submit; IME composition never submits.
- Product Artifacts remain exactly `issue | pr | preview`. Verification
  receipts may expose proof summaries and evidence references, but never the
  internal evidence ledger body.
- Product Artifacts use `artifact:…` refs and `.spark/artifacts/`; internal
  evidence uses `evidence:…` refs and `.spark/evidence/`. Neither store scans,
  accepts, or projects records from the other namespace.

## Verification

Every reachable driver state needs a rendered UI test. Work/Transcript defaults,
deep links, keyboard tabs, inline Ask placement, composer keyboard behavior,
coarse-pointer targets, reduced motion, and the Product Artifact boundary are
behavioral contracts, not visual suggestions.
