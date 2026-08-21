import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_FORMAT_VERSION, SessionId } from "@deepseek-ai/dsh-session";
import { FakeChannelTransport, parseChannelsConfig } from "@zendev-lab/dsh-channels";
import {
  SPARK_DSH_SESSION_FORMAT_VERSION,
  SparkSessionStore,
} from "@zendev-lab/spark-host/session-store";

import {
  createSparkDaemonCordisDispose,
  createSparkDaemonCordisRoot,
  mountSparkDaemonStorePlugin,
  openSparkDaemonCordisContext,
  sparkDaemonStoresFromContext,
  type SparkDaemonStoreServices,
} from "./cordis-root.ts";
import { createDaemonChannelIngressRuntime } from "./channels/global-ingress-runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

async function sessionsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spark-daemon-sessions-"));
  roots.push(root);
  return root;
}

describe("spark daemon Cordis root", () => {
  it("resolves mounted stores from the root context", async () => {
    const stores = fakeStores();
    const root = await createSparkDaemonCordisRoot(stores, { sessionsRoot: await sessionsRoot() });
    try {
      expect(root.ctx.get("sparkInvocations")).toBe(stores.sparkInvocations);
      expect(root.ctx.get("sparkLoops")).toBe(stores.sparkLoops);
      expect(root.ctx.get("sparkChannelDeliveries")).toBe(stores.sparkChannelDeliveries);
      expect(sparkDaemonStoresFromContext(root.ctx).sparkHumanWaits).toBe(stores.sparkHumanWaits);
      expect(root.ctx.sessions).toBeDefined();
      expect(root.ctx.sessionPersistence).toBeDefined();
      expect(root.ctx.attachments).toBeDefined();
      expect(root.ctx.llm).toBeDefined();
      expect(root.ctx.systemPrompt).toBeDefined();
      expect(root.ctx.tools).toBeDefined();
      expect(root.ctx.agents).toBeDefined();
      expect(root.ctx.agentLoop).toBeDefined();
    } finally {
      await root.dispose();
    }
  });

  it("disposes the fiber only once and unregisters stores", async () => {
    const stores = fakeStores();
    const root = await createSparkDaemonCordisRoot(stores, { sessionsRoot: await sessionsRoot() });
    await root.dispose();
    await root.dispose();
    expect(root.ctx.get("sparkInvocations")).toBeUndefined();
    expect(root.ctx.get("llm")).toBeUndefined();
    expect(root.ctx.get("systemPrompt")).toBeUndefined();
    expect(root.ctx.get("tools")).toBeUndefined();
    expect(root.ctx.get("agents")).toBeUndefined();
    expect(root.ctx.get("agentLoop")).toBeUndefined();
    expect(() => sparkDaemonStoresFromContext(root.ctx)).toThrow(
      /missing service sparkInvocations/,
    );
  });

  it("owns the dsh-channels transport fiber mounted on the shared root", async () => {
    const ctx = openSparkDaemonCordisContext();
    const root = await createSparkDaemonCordisRoot(fakeStores(), {
      sessionsRoot: await sessionsRoot(),
      ctx,
    });
    const transport = new FakeChannelTransport();
    const runtime = createDaemonChannelIngressRuntime({
      sparkHome: await sessionsRoot(),
      ctx,
      hooks: { onAssignment: async () => undefined },
      sessionRegistry: {
        resolveChannelSession: async () => {
          throw new Error("test does not admit inbound");
        },
      },
      createTransport: () => transport,
    });
    await runtime.configure(
      parseChannelsConfig({
        adapters: { info: { type: "infoflow", app_key: "app" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
    );

    expect(root.ctx).toBe(ctx);
    expect(ctx.channels.listAdapters()).toHaveLength(1);
    expect(transport.isRunning).toBe(true);
    await root.dispose();
    expect(transport.isRunning).toBe(false);
    expect(ctx.get("channels")).toBeUndefined();
  });

  it("disposes the fiber when store mounting fails", async () => {
    const stores = fakeStores();
    const throwing = new Proxy(stores, {
      get(target, prop, receiver) {
        if (prop === "sparkLoops") throw new Error("store plugin failed");
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(
      createSparkDaemonCordisRoot(throwing, { sessionsRoot: await sessionsRoot() }),
    ).rejects.toThrow("store plugin failed");
    const ctx = openSparkDaemonCordisContext();
    const dispose = createSparkDaemonCordisDispose(ctx);
    await expect(mountSparkDaemonStorePlugin(ctx, throwing)).rejects.toThrow("store plugin failed");
    await dispose();
    expect(ctx.get("sparkInvocations")).toBeUndefined();
    expect(ctx.get("sparkLoops")).toBeUndefined();
  });

  it("loads Spark JSONL transcripts through ctx.sessionPersistence", async () => {
    expect(SPARK_DSH_SESSION_FORMAT_VERSION).toBe(SESSION_FORMAT_VERSION);
    const home = await sessionsRoot();
    const cwd = join(home, "workspace");
    const store = new SparkSessionStore({ cwd, sparkHome: join(home, "spark-home") });
    const record = store.createCanonicalSession({
      id: "sess_persist",
      timestamp: "2026-08-20T00:00:00.000Z",
    });
    store.appendMessage(record, { role: "user", content: "hello persistence" });
    await store.save(record);

    const root = await createSparkDaemonCordisRoot(fakeStores(), {
      sessionsRoot: store.sessionsRoot,
    });
    try {
      const loaded = await root.ctx.sessionPersistence.load(SessionId("sess_persist"));
      expect(loaded.meta.id).toBe("sess_persist");
      expect(loaded.meta.cwd).toBe(store.cwd);
      expect(loaded.events.some((event) => event.type === "user/message")).toBe(true);
      expect(loaded.events.some((event) => event.type === "spark/message-meta")).toBe(true);
    } finally {
      await root.dispose();
    }
  });
});
