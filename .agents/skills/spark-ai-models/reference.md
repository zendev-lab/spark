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
| `transportApi` | `anthropic-messages` or `openai-responses` | Same family as the closest sibling on this gateway |
| `transportModelId` | Wire/gateway model id | `GATEWAY_MODEL_BY_ID` then `gatewayModelId(id)` |
| `baseUrl` | Responses models use `/v1` | GPT/Grok: `BAIDU_ONEAPI_OPENAI_BASE_URL`; Claude/DeepSeek: provider root |
| `reasoning` | Model always reasons | `true` for current Baidu catalog |
| `thinkingLevelMap` | Spark → transport effort | GPT/Grok: `GPT_THINKING_LEVEL_MAP` (`minimal→low`, `xhigh→xhigh`). Claude/DeepSeek have explicit maps |
| `input` | Modalities | Grok/GPT/Claude: `["text", "image"]`; DeepSeek V4 Flash: `["text"]` |
| `cost` | USD / 1M tokens | Headline vendor rates. Spark does not store long-context 2× tiers |
| `contextWindow` | Compact/preflight ceiling | Measured gateway reject point, else vendor context corroborated by a sibling on this gateway |
| `maxTokens` | Spark output budget | Family default (Grok/GPT 32768, Claude 32000) unless a measured cap exists |

Known Grok 4.6 vendor facts (xAI, Aug 2026): id `grok-4.6`; context 500k; no
text output limit; modalities text+image → text; reasoning `low` / `medium` /
`high` (default) / `xhigh`; headline `<200k` cost input $2, cached input $0.50,
output $6; `≥200k` doubles those rates for the whole request. Spark registers
headline cost only. `cacheWrite` is not an xAI line item; keep `2` like grok-4.5.

## Baidu file checklist

When adding or retuning a Baidu model, update all that apply:

1. `packages/spark-ai/src/baidu-oneapi.ts`
   - `GATEWAY_MODEL_BY_ID`
   - `BAIDU_ONEAPI_OPENAI_RESPONSES_MODEL_IDS` for Responses models
   - cost constant
   - `models[]` row (comments must cite measurement or vendor docs)
2. `packages/spark-ai/src/baidu-oneapi-compat-extension.test.ts` — `BAIDU_MODEL_IDS` order matches `models[]`
3. `apps/spark-tui/src/__tests__/spark-provider-registry.test.ts` — window, maxTokens, transport, cost
4. `packages/spark-ai/README.md` — catalog ids, transport sentence, measured windows
5. Default `enabledModels` is `baidu-oneapi/*`, so a new Baidu model is in
   product scope. Still add a `scopedModelIds.includes("baidu-oneapi/<id>")`
   assertion in `packages/spark-ai/src/spark-provider-control.test.ts`. If this
   repo later uses an explicit allow-list, update that list in the same change.

Pi compat and native adapters share `baidu-oneapi.ts`. Do not fork the catalog
in the compat extension.

## Other spark-ai providers

OpenAI Codex is adapted from pi-ai's maintained catalog
(`openai-codex-provider`). Do not duplicate Codex rows into Baidu. New
standalone providers need a provider plugin, registry tests, and a README
section; they are out of scope unless the user asked for a new provider.

## Validation

From the repo root (narrowest first):

```text
pnpm --filter @zendev-lab/spark-ai test src/baidu-oneapi-compat-extension.test.ts
pnpm --filter @zendev-lab/spark-tui test src/__tests__/spark-provider-registry.test.ts
```

Then the package or repo gate required by `CONTRIBUTING.md`.

## Metric-only edits

To retune an existing model:

1. Re-read the current row and README bullet.
2. Gather new evidence (vendor page and/or gateway overflow).
3. Change only the fields the evidence supports.
4. Keep the comment honest: `Measured:` vs vendor-documented.
5. Update tests that pin the old number.
