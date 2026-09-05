import { Buffer } from "node:buffer";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import { createSparkDaemonUplinkControl } from "./daemon.js";
import { startSparkDaemon } from "./daemon-start.ts";
import { upsertSparkDaemonServerProfile } from "./server-profiles.js";
import { openSparkDaemonDatabase } from "./store/schema.js";
import { registerWorkspace } from "./store/workspaces.js";

interface CapturedRuntimeFrame {
  type: string;
  runtimeId?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  payload?: {
    runtimeId?: string;
    reasonCode?: string;
    workspaceBindings?: Array<{ bindingId: string }>;
  };
}

interface TestHub {
  serverUrl: string;
  webSocketUrl: string;
  frames: CapturedRuntimeFrame[];
  authorizationHeaders: Array<string | undefined>;
  hello: ReturnType<typeof deferred<CapturedRuntimeFrame>>;
  heartbeat: ReturnType<typeof deferred<CapturedRuntimeFrame>>;
  commandReject: ReturnType<typeof deferred<CapturedRuntimeFrame>>;
  socket(): WebSocket;
  close(): Promise<void>;
}

describe("Spark daemon multi-Hub uplinks", () => {
  it("connects each server profile independently and keeps the other uplink alive", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-multi-uplink-"));
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "daemon.toml"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    const shutdown = new AbortController();
    const hubA = await startTestHub();
    const hubB = await startTestHub();
    let running: Promise<void> | undefined;

    try {
      const workspacePathA = join(root, "workspace-a");
      const workspacePathB = join(root, "workspace-b");
      mkdirSync(workspacePathA, { recursive: true });
      mkdirSync(workspacePathB, { recursive: true });

      const workspaceA = registerWorkspace(db, {
        serverUrl: hubA.serverUrl,
        serverWorkspaceId: "ws_11111111111141111111111111111111",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        localWorkspaceKey: "workspace-a",
        displayName: "Workspace A",
        localPath: workspacePathA,
      });
      const workspaceB = registerWorkspace(db, {
        serverUrl: hubB.serverUrl,
        serverWorkspaceId: "ws_22222222222242222222222222222222",
        serverBindingId: "rtwb_22222222222242222222222222222222",
        localWorkspaceKey: "workspace-b",
        displayName: "Workspace B",
        localPath: workspacePathB,
      });

      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: hubA.serverUrl,
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeToken: "runtime-token-a",
        webSocketUrl: hubA.webSocketUrl,
      });
      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: hubB.serverUrl,
        runtimeId: "rt_22222222222242222222222222222222",
        runtimeToken: "runtime-token-b",
        webSocketUrl: hubB.webSocketUrl,
      });

      running = startSparkDaemon({
        paths,
        sparkHome: join(root, "spark-home"),
        db,
        config: {
          installationId: "install-multi-uplink-test",
          displayName: "Multi-uplink test daemon",
          // A process may have started from a legacy tuple before this origin
          // was re-registered. The persisted per-server profile must win.
          serverUrl: hubA.serverUrl,
          runtimeId: "rt_99999999999949999999999999999999",
          runtimeToken: "stale-runtime-token-a",
          webSocketUrl: hubA.webSocketUrl,
        },
        signal: shutdown.signal,
        runScheduler: false,
        serverReconnectDelayMs: 60_000,
      });

      const [helloA, helloB] = await Promise.all([hubA.hello.promise, hubB.hello.promise]);
      await Promise.all([hubA.heartbeat.promise, hubB.heartbeat.promise]);

      expect(helloA.payload).toMatchObject({
        runtimeId: "rt_11111111111141111111111111111111",
        workspaceBindings: [{ bindingId: workspaceA.id }],
      });
      expect(helloA.payload?.workspaceBindings).toHaveLength(1);
      expect(helloB.payload).toMatchObject({
        runtimeId: "rt_22222222222242222222222222222222",
        workspaceBindings: [{ bindingId: workspaceB.id }],
      });
      expect(helloB.payload?.workspaceBindings).toHaveLength(1);
      expect(hubA.authorizationHeaders).toEqual(["Bearer runtime-token-a"]);
      expect(hubB.authorizationHeaders).toEqual(["Bearer runtime-token-b"]);

      const socketA = hubA.socket();
      const socketB = hubB.socket();
      const socketAClosed = once(socketA, "close");
      socketA.terminate();
      await socketAClosed;
      expect(socketB.readyState).toBe(WebSocket.OPEN);

      socketB.send(
        JSON.stringify({
          protocolVersion: runtimeProtocolVersion,
          messageId: createId("msg"),
          type: "server.command",
          sentAt: new Date().toISOString(),
          runtimeId: "rt_22222222222242222222222222222222",
          workspaceBindingId: workspaceB.id,
          workspaceId: "ws_99999999999949999999999999999999",
          projectId: "proj_22222222222242222222222222222222",
          commandId: createId("cmd"),
          payload: {
            kind: "task.start.request",
            title: "Probe surviving uplink",
            payload: { prompt: "This route mismatch must not execute." },
          },
        }),
      );

      await expect(hubB.commandReject.promise).resolves.toMatchObject({
        type: "runtime.command.reject",
        runtimeId: "rt_22222222222242222222222222222222",
        workspaceBindingId: workspaceB.id,
        payload: { reasonCode: "WORKSPACE_ROUTE_MISMATCH" },
      });
      expect(hubB.socket()).toBe(socketB);
      expect(socketB.readyState).toBe(WebSocket.OPEN);
    } finally {
      shutdown.abort();
      await running?.catch(() => undefined);
      await Promise.all([hubA.close(), hubB.close()]);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconfigures only the targeted Hub after its workspace routes change", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-targeted-uplink-reconfigure-"));
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "daemon.toml"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    const shutdown = new AbortController();
    const uplinkControl = createSparkDaemonUplinkControl();
    const hubA = await startTestHub();
    const hubB = await startTestHub();
    let running: Promise<void> | undefined;

    try {
      const workspacePathA1 = join(root, "workspace-a-1");
      const workspacePathA2 = join(root, "workspace-a-2");
      const workspacePathB = join(root, "workspace-b");
      mkdirSync(workspacePathA1, { recursive: true });
      mkdirSync(workspacePathA2, { recursive: true });
      mkdirSync(workspacePathB, { recursive: true });

      const workspaceA1 = registerWorkspace(db, {
        serverUrl: hubA.serverUrl,
        serverWorkspaceId: "ws_11111111111141111111111111111111",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        localWorkspaceKey: "workspace-a-1",
        displayName: "Workspace A1",
        localPath: workspacePathA1,
      });
      const workspaceB = registerWorkspace(db, {
        serverUrl: hubB.serverUrl,
        serverWorkspaceId: "ws_22222222222242222222222222222222",
        serverBindingId: "rtwb_22222222222242222222222222222222",
        localWorkspaceKey: "workspace-b",
        displayName: "Workspace B",
        localPath: workspacePathB,
      });

      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: hubA.serverUrl,
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeToken: "runtime-token-a",
        webSocketUrl: hubA.webSocketUrl,
      });
      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: hubB.serverUrl,
        runtimeId: "rt_22222222222242222222222222222222",
        runtimeToken: "runtime-token-b",
        webSocketUrl: hubB.webSocketUrl,
      });

      running = startSparkDaemon({
        paths,
        sparkHome: join(root, "spark-home"),
        db,
        config: {
          installationId: "install-targeted-uplink-reconfigure-test",
          displayName: "Targeted uplink reconfigure test daemon",
        },
        signal: shutdown.signal,
        uplinkControl,
        runScheduler: false,
        serverReconnectDelayMs: 60_000,
      });

      await Promise.all([hubA.hello.promise, hubB.hello.promise]);
      await Promise.all([hubA.heartbeat.promise, hubB.heartbeat.promise]);

      const socketABefore = hubA.socket();
      const socketBBefore = hubB.socket();
      expect(hubA.authorizationHeaders).toHaveLength(1);
      expect(hubB.authorizationHeaders).toHaveLength(1);

      const workspaceA2 = registerWorkspace(db, {
        serverUrl: hubA.serverUrl,
        serverWorkspaceId: "ws_33333333333343333333333333333333",
        serverBindingId: "rtwb_33333333333343333333333333333333",
        localWorkspaceKey: "workspace-a-2",
        displayName: "Workspace A2",
        localPath: workspacePathA2,
      });
      uplinkControl.requestReconfigure(hubA.serverUrl);

      await waitUntil(() => hubA.authorizationHeaders.length === 2);
      await waitUntil(() => runtimeHelloFrames(hubA).length === 2);

      const reconfiguredHelloA = runtimeHelloFrames(hubA).at(-1);
      expect(
        reconfiguredHelloA?.payload?.workspaceBindings?.map(({ bindingId }) => bindingId),
      ).toEqual(expect.arrayContaining([workspaceA1.id, workspaceA2.id]));
      expect(reconfiguredHelloA?.payload?.workspaceBindings).toHaveLength(2);
      expect(hubA.socket()).not.toBe(socketABefore);
      expect(hubA.socket().readyState).toBe(WebSocket.OPEN);

      expect(hubB.authorizationHeaders).toHaveLength(1);
      expect(runtimeHelloFrames(hubB)).toHaveLength(1);
      expect(hubB.socket()).toBe(socketBBefore);
      expect(socketBBefore.readyState).toBe(WebSocket.OPEN);

      socketBBefore.send(
        JSON.stringify({
          protocolVersion: runtimeProtocolVersion,
          messageId: createId("msg"),
          type: "server.command",
          sentAt: new Date().toISOString(),
          runtimeId: "rt_22222222222242222222222222222222",
          workspaceBindingId: workspaceB.id,
          workspaceId: "ws_99999999999949999999999999999999",
          projectId: "proj_22222222222242222222222222222222",
          commandId: createId("cmd"),
          payload: {
            kind: "task.start.request",
            title: "Probe unaffected uplink",
            payload: { prompt: "This route mismatch must not execute." },
          },
        }),
      );

      await expect(hubB.commandReject.promise).resolves.toMatchObject({
        type: "runtime.command.reject",
        runtimeId: "rt_22222222222242222222222222222222",
        workspaceBindingId: workspaceB.id,
        payload: { reasonCode: "WORKSPACE_ROUTE_MISMATCH" },
      });
      expect(hubB.authorizationHeaders).toHaveLength(1);
      expect(hubB.socket()).toBe(socketBBefore);
      expect(socketBBefore.readyState).toBe(WebSocket.OPEN);
    } finally {
      shutdown.abort();
      await running?.catch(() => undefined);
      await Promise.all([hubA.close(), hubB.close()]);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function runtimeHelloFrames(hub: TestHub): CapturedRuntimeFrame[] {
  return hub.frames.filter((frame) => frame.type === "runtime.hello");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startTestHub(): Promise<TestHub> {
  const server = new WebSocketServer({ port: 0 });
  const frames: CapturedRuntimeFrame[] = [];
  const authorizationHeaders: Array<string | undefined> = [];
  const hello = deferred<CapturedRuntimeFrame>();
  const heartbeat = deferred<CapturedRuntimeFrame>();
  const commandReject = deferred<CapturedRuntimeFrame>();
  let connectedSocket: WebSocket | undefined;

  server.on("connection", (socket, request) => {
    connectedSocket = socket;
    authorizationHeaders.push(request.headers.authorization);
    socket.on("message", (data: RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as CapturedRuntimeFrame;
      frames.push(frame);
      if (frame.type === "runtime.hello") {
        socket.send(
          JSON.stringify({
            protocolVersion: runtimeProtocolVersion,
            messageId: createId("msg"),
            type: "server.hello_ack",
            sentAt: new Date().toISOString(),
            payload: {
              runtimeSessionId: createId("rtsn"),
              acceptedFeatures: ["ws-control-v1"],
              heartbeatIntervalMs: 15_000,
              serverTime: new Date().toISOString(),
            },
          }),
        );
        hello.resolve(frame);
      } else if (frame.type === "runtime.heartbeat") {
        heartbeat.resolve(frame);
      } else if (frame.type === "runtime.command.reject") {
        commandReject.resolve(frame);
      }
    });
  });

  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected test Hub to listen on a TCP port");
  }
  const port = (address as AddressInfo).port;

  return {
    serverUrl: `http://127.0.0.1:${port}/`,
    webSocketUrl: `ws://127.0.0.1:${port}/runtime`,
    frames,
    authorizationHeaders,
    hello,
    heartbeat,
    commandReject,
    socket() {
      if (!connectedSocket) {
        throw new Error("test Hub has no active runtime connection");
      }
      return connectedSocket;
    },
    async close() {
      for (const client of server.clients) {
        client.terminate();
      }
      if (server.address() === null) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return "";
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
