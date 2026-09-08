import { expect, test, vi } from "vitest";
import { createBaiduModelDiscovery } from "./baidu-oneapi-model-discovery.ts";
import { SparkProviderRegistry } from "./provider-registry.ts";
import registerBaiduOneApiProvider from "./baidu-oneapi-provider.ts";

const input = { apiKey: "test-key", baseUrl: "https://gateway.test" };

test("discovers future GPT IDs once per endpoint/credential and preserves exact wire names", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      data: [
        { id: "gpt-6-astra-尝鲜" },
        { id: "gpt-7-future" },
        { id: "gpt-7-future" },
        { id: "unknown-protocol" },
        { id: "gpt-7/invalid" },
      ],
    }),
  );
  const discover = createBaiduModelDiscovery({ fetcher });
  const [first, second] = await Promise.all([discover(input), discover(input)]);
  expect(first).toEqual(second);
  expect(first.models.map((model) => model.id)).toEqual(["gpt-6-astra-尝鲜", "gpt-7-future"]);
  expect(first.models[0]).toMatchObject({
    transportApi: "openai-responses",
    transportModelId: "gpt-6-astra-尝鲜",
    baseUrl: "https://gateway.test/v1",
  });
  await discover(input);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual([
    "https://gateway.test/v1/models",
    expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer test-key" } }),
  ]);
  await discover({ ...input, apiKey: "different-key" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("refreshes after TTL and retains last successful models on failure without leaking response bodies", async () => {
  let now = 0;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [{ id: "gpt-7-test" }] }))
    .mockResolvedValueOnce(new Response("secret error detail", { status: 401 }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: "gpt-8-test" }] }));
  const discover = createBaiduModelDiscovery({ fetcher, now: () => now, ttlMs: 100 });
  await discover(input);
  now = 101;
  const fallback = await discover(input);
  expect(fallback.models[0]?.id).toBe("gpt-7-test");
  expect(fallback.diagnostic).toContain("using cached or bundled models");
  expect(JSON.stringify(fallback)).not.toContain("secret");
  now += 30_001;
  const fresh = await discover(input);
  expect(fresh.models[0]?.id).toBe("gpt-8-test");
  expect(fresh.diagnostic).toBeUndefined();
});

test("catalog discovery retains curated metadata, exposes new IDs to execution, and needs credentials", async () => {
  const registry = new SparkProviderRegistry();
  registerBaiduOneApiProvider(registry);
  const provider = registry.getProvider("baidu-oneapi")!;
  provider.discoverModels = createBaiduModelDiscovery({
    fetcher: vi.fn(async () =>
      Response.json({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-7-test" }] }),
    ),
  });
  await registry.discoverModels(() => undefined);
  expect(registry.listModelsFor("baidu-oneapi").some((model) => model.id === "gpt-7-test")).toBe(
    false,
  );
  await registry.discoverModels(() => input.apiKey);
  expect(registry.buildModel("baidu-oneapi", "gpt-5.6-sol").contextWindow).toBe(384_000);
  expect(registry.buildModel("baidu-oneapi", "gpt-7-test").id).toBe("gpt-7-test");
  expect(registry.buildModel("baidu-oneapi", "gpt-6-astra").id).toBe("gpt-6-astra-尝鲜");
});
