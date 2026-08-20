# Local web workbench validation

Spark validates the local browser workbench without a terminal multiplexer or a
developer-owned long-lived daemon beyond the workbench's own loopback bind.

## Package contract

The in-process Vitest harness owns bind, gateway, and RPC allowlist behavior:

```bash
pnpm --filter @zendev-lab/spark-web run test
```

Typecheck the SvelteKit app before changing the validation boundary:

```bash
pnpm --filter @zendev-lab/spark-web run check
```

## Real-browser page check

When a running `spark web` service needs console, request, or onboarding
evidence, use the Playwright page-check procedure in
[`.agents/skills/spark-playwright-page-check/SKILL.md`](../../skills/spark-playwright-page-check/SKILL.md).
Do not treat an HTTP 200 as proof that the client booted.

## Coverage that is not done

Uncovered local-web capabilities stay in [`apps/spark-web/PARITY.md`](../../../apps/spark-web/PARITY.md).
That table is the remaining surface backlog; it is not a validation gate.
