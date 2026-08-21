import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { SESSION_FORMAT_VERSION, SessionId } from "@deepseek-ai/dsh-session";
import { FakeChannelTransport, parseChannelsConfig } from "@zendev-lab/dsh-channels";
import { SparkHostRuntime } from "@zendev-lab/spark-host";
import {
  CURRENT_SPARK_SESSION_VERSION,
  SPARK_DSH_SESSION_FORMAT_VERSION,
  SparkSessionStore,
} from "@zendev-lab/spark-host/session-store";
import type { Model } from "@zendev-lab/spark-llm";
import { SparkAgentLoop, type SparkTurnLlm } from "@zendev-lab/spark-turn";

import {
  createSparkDaemonCordisDispose,
  createSparkDaemonHeadlessCordisRoot,
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

  it("mounts an ephemeral DSH runtime for an isolated headless worker", async () => {
    const root = await createSparkDaemonHeadlessCordisRoot({ dshHome: await sessionsRoot() });
    expect(root.ctx.sessions).toBeDefined();
    expect(root.ctx.attachments).toBeDefined();
    expect(root.ctx.llm).toBeDefined();
    expect(root.ctx.systemPrompt).toBeDefined();
    expect(root.ctx.tools).toBeDefined();
    expect(root.ctx.agents).toBeDefined();
    expect(root.ctx.agentLoop).toBeDefined();
    expect(root.ctx.get("sessionPersistence")).toBeUndefined();
    expect(root.ctx.get("sparkInvocations")).toBeUndefined();

    await root.dispose();
    expect(root.ctx.get("agentLoop")).toBeUndefined();
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
      expect(loaded.events.some((event) => String(event.type) === "spark/message-meta")).toBe(true);
    } finally {
      await root.dispose();
    }
  });

  it("resumes invocation-owned Agents on the shared root and projects native events", async () => {
    const home = await sessionsRoot();
    const cwd = join(home, "workspace");
    const store = new SparkSessionStore({ cwd, sparkHome: join(home, "spark-home") });
    const seed = store.createCanonicalSession({
      id: "sess_shared_agent",
      timestamp: "2026-08-20T00:00:00.000Z",
    });
    const root = await createSparkDaemonCordisRoot(fakeStores(), {
      sessionsRoot: store.sessionsRoot,
    });
    let calls = 0;
    const llm: SparkTurnLlm = {
      async *stream() {
        calls += 1;
        const text = `native reply ${calls}`;
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    };
    const model: Model<string> = {
      id: "shared-agent-model",
      name: "Shared Agent Model",
      api: "openai-completions",
      provider: "shared-agent",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    };
    const host = new SparkHostRuntime({ cwd });
    let executionSessionId: string | undefined;
    const loop = new SparkAgentLoop({
      host,
      llm,
      dshContext: root.ctx,
      getModel: () => model,
      streamIdleTimeoutMs: 0,
      agentPlugins: [
        {
          name: "capture-spark-execution",
          inject: ["sparkExecution"],
          apply(ctx: Context) {
            executionSessionId = ctx.sparkExecution.sessionId;
          },
        },
      ],
    });
    loop.setViewSessionId(seed.header.id);
    loop.setDshSessionMetadata({
      timestamp: seed.header.timestamp,
      sparkVersion: seed.header.version ?? CURRENT_SPARK_SESSION_VERSION,
    });

    try {
      await loop.submit("first prompt");
      expect(root.ctx.agents.list()).toEqual([]);
      expect(executionSessionId).toBe(seed.header.id);
      const first = await store.load(seed.path);
      expect(first.entries.filter((entry) => entry.type === "message")).toHaveLength(2);

      await loop.submit("second prompt");
      expect(root.ctx.agents.list()).toEqual([]);
      const second = await store.load(seed.path);
      expect(second.entries.filter((entry) => entry.type === "message")).toHaveLength(4);
      expect(JSON.stringify(second.entries)).toContain("native reply 2");
    } finally {
      await root.dispose();
    }
  });
});
