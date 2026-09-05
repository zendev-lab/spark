import assert from "node:assert/strict";
import { test } from "vitest";
import { loadSparkProviderCatalog } from "@zendev-lab/spark-llm-providers/control";
import { selectInitialModel } from "../host/bootstrap.ts";
import { mergeWithDefault } from "../host/config.ts";

test("native host uses the shared Astra default and keeps an explicit configured model", async () => {
  const { registry } = await loadSparkProviderCatalog();
  const defaults = mergeWithDefault({});
  assert.deepEqual(selectInitialModel(registry, defaults), {
    providerName: "openai-codex",
    modelId: "gpt-6-astra",
  });
  assert.equal(defaults.activeModelId, "openai-codex/gpt-6-astra");
  const explicit = mergeWithDefault({ activeModelId: "baidu-oneapi/claude-opus-5" });
  assert.deepEqual(selectInitialModel(registry, explicit), {
    providerName: "baidu-oneapi",
    modelId: "claude-opus-5",
  });
});
