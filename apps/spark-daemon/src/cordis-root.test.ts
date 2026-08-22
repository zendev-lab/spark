import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import { SESSION_FORMAT_VERSION, SessionId } from "@deepseek-ai/dsh-session";
import { FakeChannelTransport, parseChannelsConfig } from "@zendev-lab/dsh-channels";
import { cueSkillsRoot } from "@zendev-lab/cue";
import { SparkHostRuntime } from "@zendev-lab/spark-host";
import {
  CURRENT_SPARK_SESSION_VERSION,
  SPARK_DSH_SESSION_FORMAT_VERSION,
  SparkSessionStore,
} from "@zendev-lab/spark-session/transcript";
import type { Model } from "@zendev-lab/spark-llm";
import { SparkAgentLoop, type SparkRunOutcome, type SparkTurnLlm } from "@zendev-lab/spark-turn";

import {
  createSparkDaemonCordisDispose,
  createSparkDaemonHeadlessCordisRoot,
  createSparkDaemonCordisRoot,
  mountSparkDaemonStorePlugin,
  openSparkDaemonCordisContext,
  resolveCueSkillRoot,
  sparkDaemonStoresFromContext,
  type SparkDaemonStoreServices,
} from "./cordis-root.ts";
import { createDaemonChannelIngressRuntime } from "./channels/global-ingress-runtime.ts";
import { loadSparkProductAgentPlugins } from "./product/host/product-composition.ts";

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

async function cueSkillRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spark-daemon-skills-"));
  roots.push(root);
  const skillDir = join(root, "cue");
  await mkdir(skillDir);
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: cue",
      "description: Use Cue for command execution.",
      "---",
      "",
      "# cue",
      "",
      "Use cue-shell.",
      "",
    ].join("\n"),
  );
  return root;
}

describe("spark daemon Cordis root", () => {
  it("resolves the Cue Skill from the exact package dependency", () => {
    expect(resolveCueSkillRoot()).toBe(cueSkillsRoot);
  });

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
      expect(root.ctx.skills).toBeDefined();
      expect(root.ctx.tools.get("skill")).toMatchObject({
        sparkPolicy: {
          effect: "read",
          approval: "none",
          reconcile: "none",
        },
      });
      expect(root.ctx.agents).toBeDefined();
      expect(root.ctx.agentLoop).toBeDefined();
      expect(root.ctx.subagents).toBeDefined();
      expect(root.ctx.subagents.list()).toEqual([]);
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
    expect(root.ctx.get("skills")).toBeUndefined();
    expect(root.ctx.get("agents")).toBeUndefined();
    expect(root.ctx.get("agentLoop")).toBeUndefined();
    expect(root.ctx.get("subagents")).toBeUndefined();
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
    expect(root.ctx.skills).toBeDefined();
    expect(root.ctx.agents).toBeDefined();
    expect(root.ctx.agentLoop).toBeDefined();
    expect(root.ctx.get("sessionPersistence")).toBeUndefined();
    expect(root.ctx.get("sparkInvocations")).toBeUndefined();

    await root.dispose();
    expect(root.ctx.get("agentLoop")).toBeUndefined();
  });

  it("mounts the verified Cue Skill through the daemon-owned DSH provider", async () => {
    const skillRoot = await cueSkillRoot();
    const cwd = await sessionsRoot();
    const root = await createSparkDaemonHeadlessCordisRoot({
      dshHome: await sessionsRoot(),
      cueSkillRoot: skillRoot,
    });
    try {
      await expect(root.ctx.skills.list({ cwd })).resolves.toMatchObject([
        { name: "cue", provider: "spark-daemon", source: "bundled" },
      ]);
      await expect(root.ctx.skills.get("cue", { cwd })).resolves.toMatchObject({
        name: "cue",
        provider: "spark-daemon",
        content: expect.stringContaining("Use cue-shell."),
      });
    } finally {
      await root.dispose();
    }
  });

  it("fails closed when an explicit Cue Skill root is missing", async () => {
    const missing = join(await sessionsRoot(), "missing-skills");
    await expect(
      createSparkDaemonHeadlessCordisRoot({
        dshHome: await sessionsRoot(),
        cueSkillRoot: missing,
      }),
    ).rejects.toThrow(/could not find the package-owned cue Skill/);
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

  it("persists native DSH schedule create, list, and delete changes", async () => {
    const storageRoot = await sessionsRoot();
    const root = await createSparkDaemonCordisRoot(fakeStores(), {
      sessionsRoot: storageRoot,
    });
    const sessionId = SessionId("sess_schedule");
    const handle = await root.ctx.agents.create({
      sessionId,
      agentOptions: { provider: "schedule-test", model: "schedule-test" },
      meta: { cwd: join(storageRoot, "workspace") },
      setup(agentCtx) {
        agentCtx.agent?.session.append("spark/meta", {
          timestamp: "2026-08-21T00:00:00.000Z",
          sparkVersion: CURRENT_SPARK_SESSION_VERSION,
        });
      },
    });
    const signal = new AbortController().signal;
    try {
      const created = await root.ctx.tools.execute({
        callId: CallId("schedule-create"),
        name: "schedule_create",
        arguments: { prompt: "Review native schedule", after_seconds: 3_600 },
        agent: handle.agent,
        signal,
      });
      expect(created).toMatchObject({
        isError: false,
        value: {
          id: "schedule-1",
          kind: "after",
          prompt: "Review native schedule",
          afterSeconds: 3_600,
          state: "scheduled",
          deliveryMode: "session-local",
        },
      });

      const listed = await root.ctx.tools.execute({
        callId: CallId("schedule-list"),
        name: "schedule_list",
        arguments: {},
        agent: handle.agent,
        signal,
      });
      expect(listed).toMatchObject({
        isError: false,
        value: [expect.objectContaining({ id: "schedule-1", kind: "after" })],
      });

      const deleted = await root.ctx.tools.execute({
        callId: CallId("schedule-delete"),
        name: "schedule_delete",
        arguments: { id: "schedule-1" },
        agent: handle.agent,
        signal,
      });
      expect(deleted).toMatchObject({
        isError: false,
        value: { id: "schedule-1", deleted: true },
      });

      const inspection = await root.ctx.sessionPersistence.inspect(sessionId);
      expect(
        inspection.events
          .filter((event) => event.type === "schedule/change")
          .map((event) =>
            event.data && typeof event.data === "object" && "operation" in event.data
              ? event.data.operation
              : undefined,
          ),
      ).toEqual(["create", "delete"]);
    } finally {
      await handle.dispose();
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
    let nativeToolNames: string[] = [];
    const persistedReservationsAtModelStart: string[] = [];
    const llm: SparkTurnLlm = {
      async *stream(options) {
        calls += 1;
        nativeToolNames = options.tools?.map((tool) => tool.name) ?? [];
        const persisted = (await readFile(seed.path, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type?: string; data?: unknown })
          .filter((event) => event.type === "spark/invocation")
          .at(-1)?.data as { invocationId?: string; attemptEpoch?: number } | undefined;
        persistedReservationsAtModelStart.push(
          `${persisted?.invocationId}:${persisted?.attemptEpoch}`,
        );
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
    const observed: Array<{ invocationId: string; sessionId: string; epoch: number }> = [];
    let scheduleCreatePolicy: unknown;
    let scheduleCreateAdmission: unknown;
    const runInvocation = async (
      invocationId: string,
      prompt: string,
      epoch = 1,
      daemonGeneration = 1,
    ): Promise<SparkRunOutcome> => {
      const host = new SparkHostRuntime({
        cwd,
        invocationId,
        invocationAttempt: {
          epoch,
          daemonGeneration,
          correlationId: `attempt:${invocationId}:${daemonGeneration}`,
        },
      });
      vi.spyOn(host, "isDshToolDispatchAllowed").mockImplementation((name, policy) => {
        if (name === "schedule_create") scheduleCreateAdmission = policy;
        return true;
      });
      const loop = new SparkAgentLoop({
        host,
        llm,
        dshContext: root.ctx,
        getModel: () => model,
        streamIdleTimeoutMs: 0,
        agentPlugins: [
          ...loadSparkProductAgentPlugins(),
          {
            name: "capture-spark-invocation",
            inject: ["sparkInvocation"],
            apply(ctx: Context) {
              observed.push({
                invocationId: ctx.sparkInvocation.invocationId,
                sessionId: ctx.sparkInvocation.sessionId,
                epoch: ctx.sparkInvocation.attempt.epoch,
              });
            },
          },
        ],
      });
      loop.onEvent((event) => {
        if (event.type !== "prompt_manifest") return;
        scheduleCreatePolicy = event.manifest.tools.find((tool) => tool.name === "schedule_create");
      });
      loop.setViewSessionId(seed.header.id);
      loop.setDshSessionMetadata({
        timestamp: seed.header.timestamp,
        sparkVersion: seed.header.version ?? CURRENT_SPARK_SESSION_VERSION,
      });
      return await loop.submitWithOutcome(prompt);
    };

    try {
      await runInvocation("inv_shared_1", "first prompt");
      expect(root.ctx.agents.list()).toEqual([]);
      expect(observed).toEqual([
        { invocationId: "inv_shared_1", sessionId: seed.header.id, epoch: 1 },
      ]);
      expect(nativeToolNames).toEqual(
        expect.arrayContaining(["schedule_create", "schedule_list", "schedule_delete"]),
      );
      expect(scheduleCreatePolicy).toMatchObject({
        name: "schedule_create",
        effect: "control",
        executionMode: "sequential",
        approval: "required",
      });
      expect(scheduleCreateAdmission).toMatchObject({
        effect: "control",
        executionMode: "sequential",
        approval: "required",
        reconcile: "tool_owner",
      });
      const first = await store.load(seed.path);
      const firstMessages = first.entries.filter((entry) => entry.type === "message");
      // The first native turn persists DSH Skill and sandbox-policy context beside user/model messages.
      expect(firstMessages).toHaveLength(4);
      expect(firstMessages.filter((entry) => entry.message.role !== "user")).toHaveLength(1);

      await runInvocation("inv_shared_2", "second prompt");
      expect(root.ctx.agents.list()).toEqual([]);
      const second = await store.load(seed.path);
      const secondMessages = second.entries.filter((entry) => entry.type === "message");
      // Unchanged Skill and sandbox-policy context are not republished on the second turn.
      expect(secondMessages).toHaveLength(6);
      expect(secondMessages.filter((entry) => entry.message.role !== "user")).toHaveLength(2);
      expect(JSON.stringify(second.entries)).toContain("native reply 2");
      const beforeDuplicateEvents = (await readFile(seed.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; data?: unknown });
      const beforeDuplicate = beforeDuplicateEvents.filter(
        (event) => event.type === "spark/invocation",
      );
      expect(beforeDuplicate).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ invocationId: "inv_shared_1", attemptEpoch: 1 }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({ invocationId: "inv_shared_2", attemptEpoch: 1 }),
        }),
      ]);

      await expect(runInvocation("inv_shared_2", "duplicate attempt")).resolves.toMatchObject({
        status: "failed",
        errorCode: "SPARK_INVOCATION_TURN_ALREADY_RESERVED",
      });
      await expect(
        runInvocation("inv_shared_2", "same attempt after owner transfer", 1, 2),
      ).resolves.toMatchObject({
        status: "failed",
        errorCode: "SPARK_INVOCATION_TURN_ALREADY_RESERVED",
      });
      expect(calls).toBe(2);
      const afterDuplicateEvents = (await readFile(seed.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string });
      expect(afterDuplicateEvents.filter((event) => event.type === "turn/start")).toHaveLength(
        beforeDuplicateEvents.filter((event) => event.type === "turn/start").length,
      );

      await runInvocation("inv_shared_2", "replacement attempt", 2);
      expect(calls).toBe(3);
      const invocationEvents = (await readFile(seed.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; ignorable?: boolean; data?: unknown })
        .filter((event) => event.type === "spark/invocation");
      expect(invocationEvents).toHaveLength(3);
      expect(invocationEvents.every((event) => event.ignorable === true)).toBe(true);
      expect(persistedReservationsAtModelStart).toEqual([
        "inv_shared_1:1",
        "inv_shared_2:1",
        "inv_shared_2:2",
      ]);
    } finally {
      await root.dispose();
    }
  });

  it("registers Role-bound spawn/fork providers when a host is provided", async () => {
    const created: string[] = [];
    const root = await createSparkDaemonCordisRoot(fakeStores(), {
      sessionsRoot: await sessionsRoot(),
      subagentHost: {
        async createChild(input) {
          created.push(input.roleRef);
          return {
            sessionId: "sess_child",
            roleRef: input.roleRef,
            mode: input.mode,
          };
        },
        async send(input) {
          return { sessionId: input.sessionId, invocationId: "inv_child" };
        },
      },
    });
    try {
      expect(root.ctx.subagents.list()).toEqual(["spawn", "fork"]);
      const spawn = root.ctx.subagents.getProvider("spawn");
      expect(spawn?.inheritsParentContext).toBe(false);
      const run = await spawn!.start({
        parent: { session: { id: "sess_admin" } },
        persona: "executor",
      } as never);
      expect(String(run.id)).toBe("sess_child");
      expect(created).toEqual(["role:builtin-executor"]);
    } finally {
      await root.dispose();
    }
  });
});
