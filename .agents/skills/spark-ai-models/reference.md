# spark-ai model change reference

## Sources

Research before editing. For Grok, start here:

- Models: https://docs.x.ai/developers/models
- Model page pattern: https://docs.x.ai/developers/models/grok-4.6
- Pricing: https://docs.x.ai/developers/pricing
- Reasoning / `xhigh`: https://docs.x.ai/developers/model-capabilities/text/reasoning
- Prompt cache billing: https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing

Baidu OneAPI is an internal gateway (`https://oneapi-comate.baidu-int.com`).
Gateway model ids and prompt-length errors are authoritative for
`contextWindow`. Do not send expensive live completions unless the user asked
for measurement and `BAIDU_ONEAPI_API_KEY` is available.

## Parameter fields

| Field | Meaning | How to set |
| --- | --- | --- |
| `id` / `name` | Spark-facing model id and label | Stable local slug; do not copy gateway display names unless they already match |
| `transportApi` | `anthropic-messages` or `openai-responses` | Verify the target model and gateway support; a sibling is only a starting point |
| `transportModelId` | Wire/gateway model id | `GATEWAY_MODEL_BY_ID` then `gatewayModelId(id)` |
| `baseUrl` | Responses models use `/v1` | GPT/Grok: `BAIDU_ONEAPI_OPENAI_BASE_URL`; Claude/DeepSeek: provider root |
| `reasoning` | Model always reasons | Verify the target model; preserve unrelated catalog rows |
| `thinkingLevelMap` | Spark → transport effort | Inspect the current map and verify supported efforts for the target model |
| `input` | Modalities | Verify supported modalities for this model and transport |
| `cost` | USD / 1M tokens | Headline vendor rates. Spark does not store long-context 2× tiers |
| `contextWindow` | Compact/preflight ceiling | Measured gateway ceiling, otherwise documented target-model limit; label unmeasured assumptions |
| `maxTokens` | Spark output budget | Preserve the current family budget unless target-model evidence requires a change |

## Baidu file checklist

When adding or retuning a Baidu model, update all that apply:

1. `packages/spark-llm-providers/src/baidu-oneapi.ts`
   - `GATEWAY_MODEL_BY_ID`
   - `BAIDU_ONEAPI_OPENAI_RESPONSES_MODEL_IDS` for Responses models
   - cost constant
   - `models[]` row (comments must cite measurement or vendor docs)
2. `packages/spark-llm-providers/src/baidu-oneapi-provider.test.ts` — `BAIDU_MODEL_IDS` order matches `models[]`
3. `apps/spark-daemon/src/product/__tests__/spark-provider-registry.test.ts` — window, maxTokens, transport, cost
4. `packages/spark-llm-providers/README.md` — catalog ids, transport sentence, measured windows
5. Default enable lives in `DEFAULT_SPARK_ENABLED_MODEL_PATTERNS`
   (`packages/spark-llm-providers/src/control/provider-catalog.ts`). Catalog rows are not
   automatically enabled. For a successor model:
   - add the new id (or current-family glob such as `baidu-oneapi/gpt-5.6-*`)
   - remove the predecessor from the default list (grok-4.5 → grok-4.6)
   - keep the predecessor catalog row unless the user asked to delete it
   - add the previous bundled default as a legacy migration set
   - assert `enabledModelIds.includes("baidu-oneapi/<new>")` and
     `!enabledModelIds.includes("baidu-oneapi/<old>")` in
     `packages/spark-llm-providers/src/spark-provider-control.test.ts`

Pi compat and native adapters share `baidu-oneapi.ts`. Do not fork the catalog.

## Other spark-ai providers

OpenAI Codex is adapted from pi-ai's maintained catalog
(`openai-codex-provider`). Kimi For Coding is the same pattern
(`kimi-coding-provider`, API key `KIMI_API_KEY`). Do not duplicate those rows
into Baidu. New standalone providers need a provider plugin, registry tests,
and a README section; they are out of scope unless the user asked for a new
provider.

## Validation

From the repo root (narrowest first):

```text
pnpm --filter @zendev-lab/spark-llm-providers test src/baidu-oneapi-provider.test.ts src/kimi-coding-provider.test.ts src/control/provider-catalog.test.ts src/spark-provider-control.test.ts
pnpm --filter @zendev-lab/spark-daemon test src/product/__tests__/spark-provider-registry.test.ts src/product/__tests__/spark-config.test.ts
```

Then the package or repo gate required by `CONTRIBUTING.md`.

## Metric-only edits

To retune an existing model:

1. Re-read the current row and README bullet.
2. Gather new evidence (vendor page and/or gateway overflow).
3. Change only the fields the evidence supports.
4. Keep the comment honest: `Measured:` vs vendor-documented.
5. Update tests that pin the old number.
