import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";
import { test } from "vitest";

interface SparkAuthModule {
  listOAuthProviderSummaries(): Array<{ id: string }>;
}

test("Spark auth loads through Pi extension module aliases", async () => {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      "@earendil-works/pi-ai/providers/all": fileURLToPath(
        import.meta.resolve("@earendil-works/pi-ai/providers/all"),
      ),
      "@earendil-works/pi-ai/oauth": fileURLToPath(
        import.meta.resolve("@earendil-works/pi-ai/oauth"),
      ),
      "@earendil-works/pi-ai": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/compat")),
    },
  });
  const authModule = (await jiti.import(
    fileURLToPath(new URL("./auth.ts", import.meta.url)),
  )) as SparkAuthModule;

  assert.deepEqual(
    authModule.listOAuthProviderSummaries().map((provider) => provider.id),
    ["anthropic", "github-copilot", "openai-codex"],
  );
});
