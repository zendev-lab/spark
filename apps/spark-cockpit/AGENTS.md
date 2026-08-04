# Spark Cockpit agent guide

This file extends the repository-wide [`AGENTS.md`](../../AGENTS.md) for changes
under `apps/spark-cockpit`.

## Product boundary

Cockpit is a browser control and projection surface. It may submit commands and
render daemon or Hub state, but it is not an execution owner.

- Derive execution status from typed daemon or protocol projections.
- Never infer state from prompt text, transcript content, elapsed time, polling
  cadence, or browser timers.
- Do not run autonomous scheduling, retries, recovery, or local tool effects in
  the web application.
- Keep questions and approvals attached to their owning session and work. Do
  not introduce a global interaction state that bypasses that ownership.
- Treat Transcript as an audit view when durable work has a richer Work,
  Artifact, Change, or Task projection.

Cockpit-owned coordination storage and Hub modules have their own explicit
owner boundaries. Browser routes and components must use those owner APIs
rather than writing another package's database or local Spark state directly.

## Server and browser placement

Keep trust boundaries explicit:

- secrets, credentials, filesystem access, and privileged coordination remain
  server-side;
- browser data is a bounded projection and must not contain internal Evidence,
  provider secrets, unrestricted paths, or hidden policy state;
- shared semantics belong in `spark-protocol` or the authoritative owner, not
  in route loaders, actions, or components;
- reusable presentation primitives belong in the existing shared UI owner only
  when more than Cockpit genuinely uses them;
- Cockpit-private packages and catalogs must not become daemon or shared-package
  dependencies.

Generated or agent-produced content is data. Render it through the approved safe
Markdown and Artifact paths; do not execute MDX, JavaScript, JSX, imports,
exports, or raw HTML. Validate external links and preserve the existing allowed
URL schemes.

## Interaction and accessibility

- Every reachable status and control state needs an explicit rendering test.
- Preserve keyboard access, focus behavior, semantic roles, labels, and empty,
  loading, unavailable, and error states.
- Keep optimistic UI bounded and reconcile it with the authoritative projection.
- Do not hide owner errors behind generic success or silently repair invalid
  protocol data in the browser.
- Update the Cockpit message catalog rather than embedding user-visible strings.
  Keep supported locales in sync.

## Testing

Use focused server, component, and browser tests according to the changed
boundary. Browser tests are required for interaction contracts that depend on
routing, focus, keyboard input, dialogs, real rendering, or browser APIs.

Follow [`CONTRIBUTING.md`](../../CONTRIBUTING.md#validation) for the canonical
validation commands. Run the Cockpit browser lane when changing user-visible
interaction, navigation, or rendering behavior.
