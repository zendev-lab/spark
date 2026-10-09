import assert from "node:assert/strict";
import { test } from "vitest";
import { loadSparkProviderCatalog } from "./control/provider-catalog.ts";
import { resolveWorkflowModelSelection } from "./provider-runner.ts";

test("an unbound workflow uses Astra; active and explicit models retain precedence", async () => {
  const { registry } = await loadSparkProviderCatalog();
  assert.deepEqual(resolveWorkflowModelSelection(registry, undefined), {
    providerName: "openai-codex",
    modelId: "gpt-6-astra",
  });
  registry.setActive({ providerName: "baidu-oneapi", modelId: "claude-opus-5" });
  assert.deepEqual(resolveWorkflowModelSelection(registry, undefined), registry.getActive());
  assert.deepEqual(resolveWorkflowModelSelection(registry, "openai-codex/gpt-5.6-luna"), {
    providerName: "openai-codex",
    modelId: "gpt-5.6-luna",
  });
});
