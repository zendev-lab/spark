# Adjacent-release compatibility

Spark publishes Hub, daemon, and TUI in lockstep, but deployments do not switch
all running processes atomically. Lockstep package versions therefore do not
permit lockstep-only runtime assumptions.

The machine-readable source of truth is
[`architecture/release-compatibility.json`](../../architecture/release-compatibility.json).
This document defines its semantics.

## Compatibility invariant

For every stable release `N`, each supported product edge must accept peers from
`N - 1`, `N`, and `N + 1`:

```text
Hub N-1 ─┐                 ┌─ TUI N-1
Hub N   ─┼─ daemon N-1/N/N+1 ─┼─ TUI N
Hub N+1 ─┘                 └─ TUI N+1
```

There is no direct Hub ↔ TUI compatibility promise. The daemon is the boundary
between control-plane projection and terminal interaction.

A release candidate can only test versions that already exist. Consequently,
the release gate for candidate `N` proves both directions of `N ↔ N - 1`; the
next release's gate proves the remaining `N ↔ N + 1` obligation. Same-version
smoke remains necessary but is not evidence of adjacent compatibility.

The first split release, `0.3.0`, has one bounded exception: published `0.2.1`
is the legacy all-in-one package and has no independent Hub or TUI artifacts.
Once `0.3.0` is the published baseline, every later stable release must run the
complete split-product matrix. The exception must not be copied forward.

## Required release matrix

The tag workflow must install the reviewed published baseline and the candidate
from exact immutable artifacts, then exercise these phases in isolated homes:

| Phase | Required proof |
| --- | --- |
| candidate Hub → baseline daemon | registration/handshake, projection read, command delivery, reconnect |
| baseline Hub → candidate daemon | the same operations with the ownership reversed |
| candidate TUI → baseline daemon | local RPC status, session snapshot, event decoding, cancellation-safe detach |
| baseline TUI → candidate daemon | the same operations with the ownership reversed |
| candidate ↔ candidate | current transport and feature sanity |

Each phase must use a fresh `SPARK_HOME`, runtime directory, database, ports, and
process generation. Cleanup must prove that the exact process it started has
exited; an unverifiable cleanup preserves the fixture and fails the release.
Tests must use the packaged Hub/TUI clients, not a source-checkout client or a
root CLI standing in for those products.

The current `test-release-migration.mjs` CLI ↔ daemon matrix remains valuable
for launcher and legacy transport compatibility, but it does not satisfy either
product edge above.

## Wire protocol rules

Product SemVer is not a wire-protocol version. Compatible adjacent releases may
share a protocol identifier.

- Additive fields are optional and have deterministic defaults.
- Peers negotiate the intersection of advertised capabilities.
- Unknown optional fields do not fail decoding.
- A required capability that cannot be negotiated fails before state mutation
  with both peer product versions, protocol versions, supported ranges, and the
  corrective action.
- A breaking schema or semantic change requires a bounded dual decoder/encoder
  bridge for one published release. The old path receives no new behavior and
  is removed only after the adjacent matrix no longer contains it.
- Persisted envelopes follow the same rule as transmitted envelopes.

Diagnostics must not tell operators that Hub and daemon must be from the exact
same release when the supported condition is an adjacent-version window.

## Database upgrade protocol

A successful SQL migration is not sufficient evidence that an installation is
upgrade-safe. Every durable database owner must publish a schema compatibility
contract and classify each immutable migration as one of:

1. **expand** — add nullable/defaulted columns, tables, indexes, or compatible
   representations. Both `N` and `N - 1` readers and writers remain valid.
2. **backfill** — populate or verify expanded structures without removing the
   old representation. It is restartable and idempotent.
3. **contract** — remove or reinterpret the old representation. It is never an
   automatic adjacent update and may occur no earlier than two releases after
   the corresponding expand migration.

Only `expand` migrations are eligible for automatic managed updates. A
`backfill` may run online only when explicitly declared bounded and restartable.
A `contract` migration requires an operator-confirmed maintenance path and a
verified backup.

### Migration metadata

Starting with the first release after `0.3.0`, each database migration set must
have machine-readable metadata. The contract inventories both product-level
SQLite owners and their required manifests:

- daemon: `apps/spark-daemon/src/store/migrations/manifest.json`;
- Hub: `packages/spark-hub-db/src/migrations/manifest.json`.

Each manifest must contain at least:

- immutable migration identity and SQL checksum;
- phase (`expand`, `backfill`, or `contract`);
- release that introduced it and, for contract, the expand migration it closes;
- minimum readable and writable schema heads;
- whether it is transactional, restartable, and backup-required.

On open, the owner must fail closed for a modified applied migration, an
incomplete/dirty migration, or a future schema outside its declared reader
range. It must not silently interpret unknown state. Migration locking and
transaction boundaries must prevent two versions from migrating concurrently.

### Database release tests

For every database owner changed by candidate `N`, the release gate must prove:

1. create and write representative state with `N - 1`;
2. open/migrate/read/write with `N`;
3. reopen/read/write the migrated database with `N - 1`;
4. reopen with `N` and prove migration idempotence;
5. create fresh state with `N` and prove `N - 1` can read/write it when the
   candidate is classified `expand`;
6. inject interruption at migration boundaries and prove deterministic recovery;
7. reject automatic update for `backfill`/`contract`, checksum mismatch, dirty
   state, and unsupported future schema.

Executable rollback switches application versions. It does not restore an old
database snapshot or discard daemon sessions/messages. Destructive rollback is
a separate, explicit recovery operation.

## Change procedure

A change to a cross-product protocol, persisted envelope, database migration,
or release artifact must update the compatibility contract and its behavioral
fixtures in the same PR. A release cannot waive a failed adjacent phase by
marking the migration manual; manual migration only changes rollout mechanics,
not Hub/daemon/TUI wire compatibility.
