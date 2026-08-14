# Spark runtime integration contract

This specification owns the machine-consumable acceptance and invocation
semantics used by schedulers, CI, and local managers. User-facing command syntax
and examples belong in the public
[`CLI reference`](../../../apps/spark-docs/src/content/docs/reference/cli.md).

Integrations must use the canonical headless run/background surfaces and parse
only their documented machine output. Removed legacy root aliases are not
compatibility inputs.

## JSONL acceptance stream

The JSON headless run surface emits one UTF-8 JSON object per line in this order:

1. `session`
2. `agent_start`
3. `turn_start`
4. `queue_update`
5. `turn_end`
6. `agent_end`

`queue_update` reports steering or follow-up input. Consumers must ignore unknown
fields and tolerate added event types.

The durable acknowledgement is `turn_end.result`:

```json
{
  "type": "turn_end",
  "result": {
    "action": "submit",
    "result": {
      "invocationId": "inv_0123456789abcdef",
      "status": "queued",
      "acceptedAt": "2026-07-13T00:00:00.000Z"
    }
  }
}
```

Consumers persist the Session ID from the `session` event and the invocation ID
from this receipt. A non-zero process exit before `turn_end` means no accepted
acknowledgement was returned.

## Invocation control

The daemon invocation surface exposes submit, bounded status/stream reads,
cancel, result recovery, and Session export/replay. Exact command spelling is
owned by the public CLI reference; these semantics are the contract:

- submit returns `{ invocationId, status: "queued", acceptedAt }` only after
  durable admission;
- status never embeds an unbounded event array;
- stream is cursor-based and bounded;
- a stream consumer retains `nextCursor` and retries transport disconnects with
  the same `after` cursor;
- cursor-gap or unknown-invocation errors are terminal diagnostics, not reconnect
  signals;
- automation parses JSON output rather than human-readable rendering.

Fire-and-return behavior may allocate a Session when the manager does not supply
one. Integrations that need correlation/continuity retain the manager-owned
Session ID; project-bound integrations retain later Evidence/Artifact/review refs
in addition to the process receipt.
