import assert from "node:assert/strict";

import { test } from "vitest";

import { listOAuthProviderSummaries } from "./auth.ts";

test("Spark auth loads through Pi extension module aliases", () => {
  assert.deepEqual(
    listOAuthProviderSummaries().map((provider) => provider.id),
    ["anthropic", "github-copilot", "openai-codex"],
  );
});
