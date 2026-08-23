import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import {
  FakeChannelTransport,
  channelAdapterAccountIdentity,
  parseChannelsConfig,
  type ChannelTransport,
} from "@zendev-lab/dsh-channel-transports";
import { parseSparkSessionState, type SparkSessionState } from "@zendev-lab/spark-protocol";
import { channelConfigPath, resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_INGRESS_FAILURE_REPLY,
  channelIngressIdempotencyKey,
  createChannelIngressController,
  enrichInboundMessageReferenceFromSession,
  findChannelMessagePreviewById,
  loadDaemonChannelsConfig,
  type ChannelIngressAssignment,
  type ChannelIngressRejectedReply,
} from "./ingress.ts";
import { createDaemonChannelIngressRuntime } from "./global-ingress-runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function channelSession(input?: {
  sessionId?: string;
  adapter?: "feishu" | "infoflow" | "qqbot";
  externalKey?: string;
  account?: string;
}): SparkSessionState {
  const adapter = input?.adapter ?? "infoflow";
  const externalKey = input?.externalKey ?? "infoflow:user:user-1";
  return parseSparkSessionState({
    sessionId: input?.sessionId ?? "sess_channel_1",
    scope: { kind: "daemon", daemonId: "installation-test" },
    lifecycle: "open",
    placement: "active",
    roleBinding: { kind: "none" },
    lineage: { kind: "root" },
    incarnation: 1,
    visibility: "public",
    retention: "retain",
    purpose: "channel",
    cwd: `/tmp/channels/${input?.sessionId ?? "sess_channel_1"}/workspace`,
    bindings: [
      {
        kind: "channel",
        adapter,
        adapterAccountIdentity: input?.account ?? `account:${adapter}:test`,
        externalKey,
      },
    ],
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
}

describe("daemon Channel ingress", () => {
  it("settles text asks before Session resolution and ordinary admission", async () => {
    const transport = new FakeChannelTransport();
    const onAssignment = vi.fn(async () => undefined);
    const resolveChannelSession = vi.fn(async () => channelSession());
    const onTextAskReply = vi.fn(async () => "settled" as const);
    const controller = createChannelIngressController({
      sparkHome: "/unused",
      config: parseChannelsConfig({
        adapters: { infoflow: { type: "infoflow", app_key: "app" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: { onAssignment, onTextAskReply },
      sessionRegistry: { resolveChannelSession },
      createTransport: () => transport,
    });

    await controller.start();
    transport.emitInbound({
      user_id: "alice",
      text: "1",
      chat_type: "private",
      message_id: "msg_text_ask",
    });
    await controller.stop();

    expect(onTextAskReply).toHaveBeenCalledWith({
      recipient: "alice",
      message: expect.objectContaining({ adapter: "infoflow", senderId: "alice", text: "1" }),
    });
    expect(resolveChannelSession).not.toHaveBeenCalled();
    expect(onAssignment).not.toHaveBeenCalled();
  });

  it("resolves a daemon Channel Session and admits an assignment without Workspace routing", async () => {
    const account = channelAdapterAccountIdentity({ type: "feishu", app_id: "app-1" });
    const session = channelSession({
      sessionId: "sess_feishu",
      adapter: "feishu",
      externalKey: "feishu:chat:oc_demo",
      account,
    });
    const resolveChannelSession = vi.fn(async () => session);
    const recordTurnQueued = vi.fn(async () => session);
    const assignments: ChannelIngressAssignment[] = [];
    const transport = new FakeChannelTransport();
    const controller = createChannelIngressController({
      sparkHome: "/unused",
      config: parseChannelsConfig({
        adapters: { work: { type: "feishu", app_id: "app-1" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: { onAssignment: async (assignment) => void assignments.push(assignment) },
      sessionRegistry: { resolveChannelSession, recordTurnQueued },
      createTransport: () => transport,
    });

    await controller.start();
    transport.emitInbound({ chat_id: "oc_demo", text: "ship it", message_id: "m1" });
    await vi.waitFor(() => expect(assignments).toHaveLength(1));
    await controller.stop();

    expect(resolveChannelSession).toHaveBeenCalledWith({
      externalKey: "feishu:chat:oc_demo",
      adapterId: "work",
      adapterAccountIdentity: account,
      allowLegacyAccountClaim: true,
      onUnbound: "create",
      name: "channel feishu:chat:oc_demo",
    });
    expect(assignments[0]).toMatchObject({
      sessionId: "sess_feishu",
      goal: "ship it",
      assignment: { target: { sessionId: "sess_feishu" } },
      externalKey: "feishu:chat:oc_demo",
      adapterAccountIdentity: account,
      channelReply: { adapter: "feishu", adapterId: "work", recipient: "oc_demo" },
    });
    expect(assignments[0]?.assignment.target).not.toHaveProperty("workspaceId");
    expect(recordTurnQueued).toHaveBeenCalledWith("sess_feishu");
  });

  it("persists a stable failure reply intent instead of sending inline", async () => {
    const rejected: ChannelIngressRejectedReply[] = [];
    const transport = new FakeChannelTransport();
    const controller = createChannelIngressController({
      sparkHome: "/unused",
      config: parseChannelsConfig({
        adapters: { qq: { type: "qqbot", app_id: "app", client_secret: "secret" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: {
        onAssignment: async () => {
          throw new Error("provider unavailable");
        },
        onRejectedReply: async (input) => void rejected.push(input),
      },
      sessionRegistry: {
        resolveChannelSession: async () =>
          channelSession({ adapter: "qqbot", externalKey: "qqbot:c2c:user-1" }),
      },
      createTransport: () => transport,
    });

    await controller.start();
    transport.emitInbound({
      event_type: "C2C_MESSAGE_CREATE",
      d: { id: "qm1", content: "hello", author: { user_openid: "user-1" } },
    });
    await vi.waitFor(() => expect(rejected).toHaveLength(1));
    await controller.stop();

    expect(rejected[0]).toMatchObject({
      text: CHANNEL_INGRESS_FAILURE_REPLY,
      externalKey: "qqbot:c2c:user-1",
      adapterId: "qq",
      deliveryIdentity: expect.stringMatching(/^channel-ingress-failure:/u),
    });
    expect(transport.sent).toEqual([]);
  });

  it("uses account identity in durable ingress keys", () => {
    const base: ChannelIngressAssignment = {
      sessionId: "sess_a",
      goal: "hello",
      assignment: {
        goal: "hello",
        target: { sessionId: "sess_a" },
        constraints: [],
        evidence: [],
        source: { kind: "channel", channel: "qqbot", externalRef: "message-1" },
      },
      source: { kind: "channel", channel: "qqbot", externalRef: "message-1" },
      externalKey: "qqbot:c2c:user-1",
      adapterAccountIdentity: "account-a",
      channelReply: {
        adapter: "qqbot",
        adapterId: "qq-a",
        externalKey: "qqbot:c2c:user-1",
        recipient: "c2c:user-1",
      },
    };
    expect(channelIngressIdempotencyKey({ ...base, sessionId: "sess_b" })).toBe(
      channelIngressIdempotencyKey(base),
    );
    expect(channelIngressIdempotencyKey({ ...base, adapterAccountIdentity: "account-b" })).not.toBe(
      channelIngressIdempotencyKey(base),
    );
  });

  it("drains an already-received handler before stopping the transport", async () => {
    const finish = deferred<void>();
    const transport = new FakeChannelTransport();
    const controller = createChannelIngressController({
      sparkHome: "/unused",
      config: parseChannelsConfig({
        adapters: { info: { type: "infoflow", app_key: "app" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: { onAssignment: async () => await finish.promise },
      sessionRegistry: { resolveChannelSession: async () => channelSession() },
      createTransport: () => transport,
    });
    await controller.start();
    transport.emitInbound({ user_id: "user-1", text: "wait", message_id: "m1" });
    await vi.waitFor(() => expect(transport.isRunning).toBe(true));

    let stopped = false;
    const stopping = controller.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish.resolve(undefined);
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("daemon-global Channel runtime", () => {
  it("stores one private global config and rolls back a failed replacement generation", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-global-channels-"));
    roots.push(sparkHome);
    const stable = new FakeChannelTransport();
    const ctx = new Context();
    let failReplacement = false;
    const runtime = createDaemonChannelIngressRuntime({
      sparkHome,
      ctx,
      hooks: { onAssignment: async () => undefined },
      sessionRegistry: { resolveChannelSession: async () => channelSession() },
      createTransport: () => {
        if (!failReplacement) return stable;
        return {
          start: async () => {
            throw new Error("replacement failed");
          },
          stop: async () => undefined,
          send: async () => undefined,
        } satisfies ChannelTransport;
      },
    });
    const config = parseChannelsConfig({
      adapters: { info: { type: "infoflow", app_key: "app" } },
      routes: {},
      ingress: { enabled: true, on_unbound: "create" },
    });

    await runtime.configure(config);
    const path = channelConfigPath(resolveSparkPaths({ app: "daemon", sparkHome }));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(runtime.status()).toMatchObject({ plane: "daemon", state: "running" });
    expect(ctx.channels.generationNumber).toBe(1);

    failReplacement = true;
    await expect(runtime.configure(config)).rejects.toThrow("replacement failed");
    expect(stable.isRunning).toBe(true);
    expect(runtime.status()).toMatchObject({ state: "degraded" });
    expect(ctx.channels.generationNumber).toBe(1);
    await runtime.stop();
    expect(ctx.get("channels")).toBeUndefined();
    await ctx.fiber.dispose();
  });

  it("drains accepted ingress before the Cordis transport fiber closes", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-global-channel-drain-"));
    roots.push(sparkHome);
    const transport = new FakeChannelTransport();
    const assignment = deferred<void>();
    const onAssignment = vi.fn(async () => await assignment.promise);
    const ctx = new Context();
    const runtime = createDaemonChannelIngressRuntime({
      sparkHome,
      ctx,
      hooks: { onAssignment },
      sessionRegistry: { resolveChannelSession: async () => channelSession() },
      createTransport: () => transport,
    });
    await runtime.configure(
      parseChannelsConfig({
        adapters: { info: { type: "infoflow", app_key: "app" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
    );
    transport.emitInbound({ user_id: "user-1", text: "wait", message_id: "m-drain" });
    await vi.waitFor(() => expect(onAssignment).toHaveBeenCalledOnce());

    runtime.beginDrain?.();
    let drained = false;
    const draining = runtime.drain?.().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(transport.isRunning).toBe(true);
    assignment.resolve(undefined);
    await draining;
    expect(transport.isRunning).toBe(true);
    await runtime.close?.();
    expect(transport.isRunning).toBe(false);
    await ctx.fiber.dispose();
  });

  it("loads an absent daemon-global config as null", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-global-channels-empty-"));
    roots.push(sparkHome);
    await expect(loadDaemonChannelsConfig(sparkHome)).resolves.toMatchObject({ config: null });
  });
});

describe("Channel quote enrichment", () => {
  it("finds prior channel message text by platform message id", () => {
    expect(
      findChannelMessagePreviewById(
        [
          {
            version: 4,
            id: "1",
            role: "assistant",
            text: "收到",
            status: "done",
            createdAt: "2026-01-01T00:00:01.000Z",
            metadata: { channel: { messageId: "m-bot" } },
          },
        ],
        "m-bot",
      ),
    ).toBe("收到");
  });

  it("keeps a reference intact when its private transcript is unavailable", async () => {
    const session = channelSession({ sessionId: "sess_quote" });
    const enriched = await enrichInboundMessageReferenceFromSession({
      message: {
        adapter: "qqbot",
        externalKey: "qqbot:c2c:u1",
        text: "继续",
        messageId: "m-new",
        messageReference: { messageId: "m-bot", source: "unknown" },
      },
      session,
      sparkHome: "/tmp/spark-quote-enrich",
      getSession: async () => session,
    });
    expect(enriched.messageReference).toEqual({ messageId: "m-bot", source: "unknown" });
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
