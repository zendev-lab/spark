# Pi product compatibility

## Scope

Spark retains Pi SDK concepts and packages behind the `spark-ai`, `spark-tui`,
`spark-text`, and `spark-turn` boundaries. This document governs compatibility
with the external Pi **product loader**. It does not govern the retained SDK
kernel.

Pi product compatibility is a bounded adapter surface, not a product parity
commitment. Spark-native TUI, Hub, channels, ACP, and daemon interfaces are
the supported product surfaces and may add behavior without extending Pi
compatibility.

## Admission rule

A capability may remain in the Pi compatibility manifest only when all of the
following hold:

1. it is additive and does not replace a Pi built-in capability;
2. it delegates to the existing Spark owner API and creates no Pi-only state,
   policy, scheduler, or recovery path;
3. it does not import Pi product-private internals or depend on undocumented
   loader behavior;
4. its user value exceeds the ongoing protocol, process-lifecycle, release,
   and regression-test cost;
5. the production Pi loader has a focused test for registration and failure
   behavior.

Compatibility difficulty exceeding the retained user benefit is sufficient
reason to remove the capability. Spark does not preserve feature parity merely
because a capability was previously discoverable by Pi.

## File-tool boundary

External Pi owns its native `read`, `write`, `edit`, `grep`, `find`, and `ls`
tools. The root Pi compatibility manifest must not register
`@zendev-lab/spark-files` as a replacement.

Spark's versioned, line-anchored, CAS-protected file tools remain supported by
Spark-native hosts. The explicit daemon Files adapter may be retained for
migration and integration verification, but it is not a Pi product surface and
must not receive new Pi-specific behavior.

This cut is intentional: replacing ordinary Pi file operations coupled them to
Spark daemon availability, daemon/client version agreement, session/workspace
cwd validity, operation-id replay semantics, and local RPC error mapping. That
failure domain and maintenance burden exceeded the incremental value over Pi's
built-ins.

## Daemon-backed compatibility behavior

Remaining additive Pi-compatible tools such as Artifact, Git, or Lens may call
the daemon through the protocol-aware daemon client. They must satisfy these
invariants:

- operation ids are scoped by client process, execution root, workspace and
  surface context, rather than bare host tool-call ids;
- an exact replay returns the original result;
- reuse of one operation id with different input fails closed without executing
  the second operation;
- workspace-cwd, idempotency, unavailable implementation, and owner execution
  failures return structured tool results with an actionable error code and
  retry instruction;
- predictable owner failures must not be collapsed into an opaque `Internal
  Server Error`;
- compatibility errors never cause implicit mutation replay after dispatch.

An unrecoverable transport or protocol-decoding failure may still reject the
call, but its diagnostic must identify the daemon boundary and advise checking
client/daemon version agreement.

## Growth and removal

The root `package.json#pi.extensions` list is a shrinking allowlist. Adding an
entry requires an explicit architecture rationale and the admission evidence
above. Removing an entry is always allowed when it reduces a compatibility
failure domain or deletes duplicate product behavior.

A removed compatibility capability remains available only through its owning
Spark-native surface unless a separately justified, bounded adapter is retained
for migration. Compatibility code receives no new product behavior while it is
awaiting removal.

## Verification

The enforced gates are:

- the production Pi loader confirms that the Files compatibility entry
  registers no Pi-native file-tool names and is absent from the root manifest;
- daemon integration tests exercise a large paginated read window, versioned
  write/CAS behavior, invalid workspace cwd, exact replay, and operation-id
  conflict handling through `file.execute`;
- daemon-client tests prove operation ids are deterministic within one context,
  distinct across contexts, bounded, and free of raw paths/tool-call ids;
- architecture ratchets reject compatibility-manifest growth outside the frozen
  allowlist.
