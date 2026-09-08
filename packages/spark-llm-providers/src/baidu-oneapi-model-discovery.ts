import { createHash } from "node:crypto";
import type { ProviderConfig, ProviderModelDefinition } from "./provider-registry.ts";

// /models supplies identity, not limits or prices. These are conservative
// operational defaults, not measured gateway ceilings. Zero cost means unpriced.
export function discoveredBaiduGptModel(id: string, baseUrl: string): ProviderModelDefinition {
  return {
    id,
    name: id,
    baseUrl: `${baseUrl.replace(/\/$/u, "").replace(/\/v1$/u, "")}/v1`,
    transportApi: "openai-responses",
    transportModelId: id,
    reasoning: /^gpt-[5-9]/u.test(id),
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

type Discovery = NonNullable<ProviderConfig["discoverModels"]>;
type Result = Awaited<ReturnType<Discovery>>;

export function createBaiduModelDiscovery(
  options: {
    fetcher?: typeof fetch;
    now?: () => number;
    ttlMs?: number;
  } = {},
): Discovery {
  const cache = new Map<string, { expires: number; result: Result; pending?: Promise<Result> }>();
  const now = options.now ?? Date.now;
  return async ({ apiKey, baseUrl }) => {
    const endpoint = `${baseUrl.replace(/\/$/u, "").replace(/\/v1$/u, "")}/v1/models`;
    const key = createHash("sha256").update(endpoint).update("\0").update(apiKey).digest("hex");
    const previous = cache.get(key);
    if (previous?.pending) return previous.pending;
    if (previous && previous.expires > now()) return previous.result;
    const entry = previous ?? { expires: 0, result: { models: [] } };
    const refresh = async (): Promise<Result> => {
      try {
        const response = await (options.fetcher ?? fetch)(endpoint, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Model catalog request failed");
        const payload: unknown = await response.json();
        if (
          !payload ||
          typeof payload !== "object" ||
          !("data" in payload) ||
          !Array.isArray(payload.data)
        ) {
          throw new Error("Invalid model catalog");
        }
        const ids = new Set<string>();
        for (const row of payload.data) {
          if (
            row &&
            typeof row === "object" &&
            typeof row.id === "string" &&
            /^gpt-\d[^\s/]*$/u.test(row.id) &&
            row.id.length <= 200
          )
            ids.add(row.id);
        }
        entry.result = { models: [...ids].map((id) => discoveredBaiduGptModel(id, baseUrl)) };
        entry.expires = now() + (options.ttlMs ?? 300_000);
      } catch {
        entry.result = {
          ...entry.result,
          diagnostic: "model discovery unavailable; using cached or bundled models",
        };
        entry.expires = now() + 30_000;
      } finally {
        delete entry.pending;
      }
      return entry.result;
    };
    entry.pending = Promise.resolve().then(refresh);
    cache.set(key, entry);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return entry.pending;
  };
}
