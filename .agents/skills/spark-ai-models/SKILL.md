---
name: spark-ai-models
description: >
  Add or update Spark AI provider models and their compact/preflight metrics
  (contextWindow, maxTokens, cost, thinkingLevelMap, transport). Use when adding
  a new model to spark-ai, especially baidu-oneapi; when tuning model parameter
  metrics; or when the user mentions Grok, Claude, GPT, DeepSeek, OneAPI, 百度
  provider, 新模型, or context/pricing windows.
---

# Spark AI model catalog

Owner: `packages/spark-ai`. Catalog, gateway rewrites, and measured windows live
in `baidu-oneapi.ts`. Do not guess vendor ids, context, or prices.

## Workflow

1. Identify the change: new model, metric correction, or both.
2. Research current vendor docs (and gateway ids). Record source URLs and the
   exact numbers. If docs conflict with a live gateway, keep both in comments
   and register the **gateway ceiling** for `contextWindow`.
3. Edit the existing provider owner. For Baidu, follow
   [reference.md](reference.md). Do not add a second catalog or public alias.
4. Update the focused tests and `packages/spark-ai/README.md` in the same change.
5. Run the package and registry tests listed in the reference.

## Research rules

- Prefer the vendor's current model and pricing pages over training memory,
  blogs, or aggregator tables.
- Model id uses a **dot** when the vendor does (`grok-4.6`, not `grok-4-6`).
- `contextWindow` is the prompt+output ceiling Spark compact/preflight uses.
  On Baidu, **measured provider input** beats advertised vendor context.
- `maxTokens` is Spark's output budget, not always the vendor max. If the
  vendor lists no output cap, keep the same-family budget unless measurement
  says otherwise.
- Spark `cost` is USD per million tokens:
  `{ input, output, cacheRead, cacheWrite }`. Use headline rates (Baidu/Spark
  do not model xAI `≥200k` 2× long-context pricing). If the vendor has no
  cache-write fee, set `cacheWrite` to the input rate like existing Grok rows.
- `thinkingLevelMap` only remaps Spark levels that differ from the transport.
  Confirm whether `xhigh` is real, aliased to `high`, or invalid.

## Baidu OneAPI

- Claude and DeepSeek → `anthropic-messages`. GPT-5.6 and Grok →
  `openai-responses` (`BAIDU_ONEAPI_OPENAI_RESPONSES_MODEL_IDS`).
- Local id and gateway id can differ (`claude-opus-5` → `Opus 5`). GPT/Grok
  are currently 1:1.
- Adding a model also requires `GATEWAY_MODEL_BY_ID` plus the `models[]` row.
- Keep grok-4.5 when adding grok-4.6 unless the user asks to remove it.

## Metric edits

Changing only windows or prices still needs tests and README notes. Do not
advertise a round number (1M, 256k) when the gateway hard-fails earlier.
