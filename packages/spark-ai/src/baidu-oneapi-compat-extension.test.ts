import { expect, test } from "vitest";

import registerBaiduOneApiCompatibilityExtension from "./baidu-oneapi-compat-extension.ts";
import registerBaiduOneApiProvider from "./baidu-oneapi-provider.ts";
import { SparkProviderRegistry } from "./provider-registry.ts";

test("Pi compatibility and Spark-native adapters expose the same Baidu model catalog", () => {
  const piRegistry = new SparkProviderRegistry();
  const nativeRegistry = new SparkProviderRegistry();

  registerBaiduOneApiCompatibilityExtension(piRegistry);
  registerBaiduOneApiProvider(nativeRegistry);

  const piProvider = piRegistry.getProvider("baidu-oneapi");
  const nativeProvider = nativeRegistry.getProvider("baidu-oneapi");
  expect(piProvider).toBeDefined();
  expect(nativeProvider).toBeDefined();
  expect(piProvider?.models).toEqual(nativeProvider?.models);
  expect(piProvider?.baseUrl).toBe(nativeProvider?.baseUrl);
  expect(piProvider?.api).toBe("baidu-oneapi");
});
