# @zendev-lab/spark-ask

Structured human-input primitives for Spark host adapters. The package is host-neutral and exposes one public action tool:

- `action: "ask"` for structured questions;
- `action: "flow"` when the fullscreen multi-question renderer is required.

## Contract

- Asks wait for an answer, explicit cancellation, or explicit no-selection. Time passing never implies a decision.
- Protocol hosts declare blocking/async, timeout, correlation, and ACK capabilities. Async success requires a request-correlated `pending` response with a durable `humanRequestId`; transport rejection or malformed correlation fails closed.
- Canonical blocking Ask uses only the host-owned wait timeout. Caller `timeoutMs` is ignored, and reviewer takeover occurs only after a correlated host timeout; a missing transport never starts a synthetic local wait.
- `value` is the stable machine ID; `label` and `description` are user-facing fields.
- Custom input is stored as `customText`. Callers must not add business options named `Other` or `Type your own`.
- Result status is explicit: `answered`, `cancelled`, or `no_selection`.
- Decision and approval gates block on `cancelled` and `no_selection`. Custom text without a required option ID also blocks those gates.
- `summarizeAskResult()`, `summarizeAskAnswers()`, and `createAskEvidenceBody()` provide shared human summaries and persistence data.
- Freeform-only flows may submit optional blank answers as `kind: "skipped"`.
- `defaultValues` is valid only for `single` and `multi`, references business option values, and is a recommendation rather than an answer.

Host wrappers own option-description policy and renderer integration. Legacy select/input primitives remain blocking-only compatibility. This package owns generic structural validation, transport preflight, correlation, and ask runtime semantics.
