import { anthropicMessagesApi, createProvider, getModels } from "@earendil-works/pi-ai/compat";

import { registerSparkAiProvider } from "./spark-provider-adapter.ts";
import type { ProviderRegistrationAPI } from "./provider-registry.ts";

export const KIMI_CODING_PROVIDER_ID = "kimi-coding";
export const KIMI_CODING_API_KEY_ENV = "KIMI_API_KEY";
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding";

/**
 * Register pi-ai's maintained Kimi For Coding catalog in Spark's host-neutral
 * provider registry. Spark owns credential storage; pi-ai owns model ids and
 * the Anthropic-compatible transport.
 */
export default function registerKimiCodingProvider(api: ProviderRegistrationAPI): void {
  const provider = createProvider({
    id: KIMI_CODING_PROVIDER_ID,
    name: "Kimi For Coding",
    baseUrl: KIMI_CODING_BASE_URL,
    auth: {
      apiKey: {
        name: "Kimi API key",
        resolve: async () => undefined,
      },
    },
    models: getModels(KIMI_CODING_PROVIDER_ID),
    api: anthropicMessagesApi(),
  });
  registerSparkAiProvider(api, provider, {
    authRef: KIMI_CODING_API_KEY_ENV,
    baseUrl: KIMI_CODING_BASE_URL,
  });
}
