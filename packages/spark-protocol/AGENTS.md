# Spark protocol agent guide

This file extends [`packages/AGENTS.md`](../AGENTS.md) for
`packages/spark-protocol`.

## Responsibility

`spark-protocol` owns cross-surface wire schemas, validation, and shared
interaction semantics. It is a contract package, not a transport, store, client,
or orchestration runtime.

Keep it free of production dependencies on other Spark workspaces. A protocol
shape must remain usable by daemon, clients, TUI, Cockpit, channels, and ACP
without importing an application implementation.

## Contract design

- Use JSON-friendly data: explicit objects, arrays, strings, numbers, booleans,
  and nullability. Do not expose classes, functions, `Date`, `Map`, `Set`, or
  process-local handles.
- Make identity, revision, generation, status, timestamps, and optionality
  explicit where they affect behavior.
- Validate untrusted input at the boundary. Do not rely on TypeScript types
  alone or silently coerce malformed data into a successful operation.
- Keep wire schemas separate from presentation labels and application-specific
  view models.
- Put semantics here only when multiple surfaces must make the same decision.
  Storage policy and side effects remain with the authoritative owner.
- Preserve distinct lifecycle states and failure kinds when callers need to
  render or recover them correctly.

## Compatibility

Treat persisted and transmitted shapes as compatibility contracts.

- Prefer additive optional fields with deterministic defaults.
- Reject unknown or invalid combinations when accepting them would invent
  state or weaken a safety boundary.
- A breaking rename, removal, or semantic change requires an explicit version,
  decoder, migration, or coordinated hard cut with all supported callers.
- Compatibility decoders are bounded and tested; they must not become a second
  native model or receive new behavior.
- Status unions and discriminated variants require exhaustive tests for every
  reachable member and invalid discriminator.

Do not use a frontend-specific convenience as the canonical protocol shape.
First model the owner fact, then let each surface derive its presentation.

## Testing

Protocol changes should test:

- valid round trips and canonical serialization;
- malformed, incomplete, contradictory, and unknown input;
- supported older payloads and deterministic normalization;
- exhaustive discriminated unions and lifecycle states;
- semantics shared by more than one surface;
- dependency purity and exported API shape.

Follow [`CONTRIBUTING.md`](../../CONTRIBUTING.md#validation). Run the protocol
package check and the affected daemon/client/surface tests; compatibility or
export changes also require the repository static and boundary gates.
