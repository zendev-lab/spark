import assert from "node:assert/strict";
import { test } from "vitest";

import type { SparkAuthFlow, SparkModelCatalogProvider } from "@zendev-lab/spark-protocol";

import {
  authFlowStatusLabel,
  isTerminalAuthFlow,
  latestAuthProgress,
  lookupOAuthSettingsProvider,
  oauthHref,
  providerAuthKindLabel,
  providerAuthStatusLabel,
} from "./provider-auth.ts";

const oauthProvider: SparkModelCatalogProvider = {
  providerName: "openai-codex",
  label: "OpenAI Codex",
  auth: {
    providerName: "openai-codex",
    kind: "oauth",
    configured: false,
    reference: "openai-codex",
  },
  models: [],
};

const apiKeyProvider: SparkModelCatalogProvider = {
  providerName: "kimi-coding",
  label: "Kimi For Coding",
  auth: {
    providerName: "kimi-coding",
    kind: "api_key",
    configured: true,
    source: "stored",
    reference: "KIMI_API_KEY",
  },
  models: [],
};

test("settings href and labels distinguish OAuth from API-key providers", () => {
  assert.equal(oauthHref("openai-codex"), "/settings/oauth/openai-codex");
  assert.equal(oauthHref("openai/codex"), "/settings/oauth/openai%2Fcodex");
  assert.equal(providerAuthKindLabel("oauth"), "OAuth");
  assert.equal(providerAuthKindLabel("api_key"), "API key");
  assert.equal(providerAuthStatusLabel(oauthProvider), "Not connected");
  assert.equal(providerAuthStatusLabel(apiKeyProvider), "Connected");
});

test("oauth settings page only accepts catalog oauth providers", () => {
  const providers = [oauthProvider, apiKeyProvider];
  assert.deepEqual(lookupOAuthSettingsProvider(providers, "openai-codex"), {
    ok: true,
    provider: oauthProvider,
  });
  const apiKeyLookup = lookupOAuthSettingsProvider(providers, "kimi-coding");
  assert.equal(apiKeyLookup.ok, false);
  if (!apiKeyLookup.ok) assert.equal(apiKeyLookup.status, 400);
  const missing = lookupOAuthSettingsProvider(providers, "missing");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 404);
});

test("auth flow helpers treat succeeded/failed/cancelled as terminal", () => {
  assert.equal(isTerminalAuthFlow("pending"), false);
  assert.equal(isTerminalAuthFlow("waiting_for_user"), false);
  assert.equal(isTerminalAuthFlow("succeeded"), true);
  assert.equal(isTerminalAuthFlow("failed"), true);
  assert.equal(isTerminalAuthFlow("cancelled"), true);
  assert.equal(authFlowStatusLabel("waiting_for_user"), "Waiting for you");
  const flow = {
    id: "flow_1",
    providerName: "openai-codex",
    status: "waiting_for_user",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    progress: ["Opening browser", "Enter the code"],
  } satisfies SparkAuthFlow;
  assert.equal(latestAuthProgress(flow), "Enter the code");
});
