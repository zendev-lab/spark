import { describe, expect, it } from "vitest";

import {
  createSparkDaemonCordisDispose,
  createSparkDaemonCordisRoot,
  mountSparkDaemonStorePlugin,
  openSparkDaemonCordisContext,
  sparkDaemonStoresFromContext,
  type SparkDaemonStoreServices,
} from "./cordis-root.ts";

function fakeStores(): SparkDaemonStoreServices {
  return {
    sparkInvocations: { kind: "invocations" },
    sparkLoops: { kind: "loops" },
    sparkChannelDeliveries: { kind: "channelDeliveries" },
    sparkChannelReplyDeliveries: { kind: "channelReplyDeliveries" },
    sparkExecutionAttempts: { kind: "executionAttempts" },
    sparkSessionMail: { kind: "sessionMail" },
    sparkHumanWaits: { kind: "humanWaits" },
    sparkSessionCompletions: { kind: "sessionCompletions" },
    sparkInvocationRegistry: { kind: "invocationRegistry" },
  } as unknown as SparkDaemonStoreServices;
}

describe("spark daemon Cordis root", () => {
  it("resolves mounted stores from the root context", async () => {
    const stores = fakeStores();
    const root = await createSparkDaemonCordisRoot(stores);
    try {
      expect(root.ctx.get("sparkInvocations")).toBe(stores.sparkInvocations);
      expect(root.ctx.get("sparkLoops")).toBe(stores.sparkLoops);
      expect(root.ctx.get("sparkChannelDeliveries")).toBe(stores.sparkChannelDeliveries);
      expect(sparkDaemonStoresFromContext(root.ctx).sparkHumanWaits).toBe(stores.sparkHumanWaits);
    } finally {
      await root.dispose();
    }
  });

  it("disposes the fiber only once and unregisters stores", async () => {
    const stores = fakeStores();
    const root = await createSparkDaemonCordisRoot(stores);
    await root.dispose();
    await root.dispose();
    expect(root.ctx.get("sparkInvocations")).toBeUndefined();
    expect(() => sparkDaemonStoresFromContext(root.ctx)).toThrow(
      /missing service sparkInvocations/,
    );
  });

  it("disposes the fiber when store mounting fails", async () => {
    const stores = fakeStores();
    const throwing = new Proxy(stores, {
      get(target, prop, receiver) {
        if (prop === "sparkLoops") throw new Error("store plugin failed");
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(createSparkDaemonCordisRoot(throwing)).rejects.toThrow("store plugin failed");
    const ctx = openSparkDaemonCordisContext();
    const dispose = createSparkDaemonCordisDispose(ctx);
    await expect(mountSparkDaemonStorePlugin(ctx, throwing)).rejects.toThrow("store plugin failed");
    await dispose();
    expect(ctx.get("sparkInvocations")).toBeUndefined();
    expect(ctx.get("sparkLoops")).toBeUndefined();
  });
});
