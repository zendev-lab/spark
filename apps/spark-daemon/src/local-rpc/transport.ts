import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig } from "../config.ts";
import { createDaemonChannelDeliveryOutbox } from "../channels/delivery-outbox.ts";
import type { DaemonChannelIngressRuntime } from "../channels/ingress.ts";
import type {
  SparkDaemonHumanInteractionResponder,
  SparkDaemonLifecycleSnapshot,
} from "../core/index.ts";
import type { SparkDaemonHumanWaitRegistry } from "../core/human-waits.ts";
import type { SparkDaemonLeaseTransferBroker } from "../core/lease-transfer.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import type { SessionNotificationDeliveryQueue } from "../session-notification-delivery.ts";
import { createDaemonSessionRegistry, type DaemonSessionRegistry } from "../session-registry.ts";
import { resolveSessionCwdForWorkspaceId } from "../session-cwd.ts";
import { SparkChannelDeliveryStore } from "../store/channel-deliveries.ts";
import { resolveWorkspaceLocalPath } from "../store/workspaces.js";
import { handleLocalRpcLine } from "./dispatch.ts";
import { startLocalRpcOrpcServer, type LocalRpcOrpcServer } from "./orpc-server.ts";
import {
  localRpcSocketPath,
  type LocalDaemonRestartResult,
  type LocalRpcHandlerOptions,
  type LocalRpcMailStore,
  type LocalRpcResponse,
  type LocalRpcServer,
  type SparkDaemonLocalEventBus,
} from "./types.ts";

const DEFAULT_LEGACY_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export async function startLocalRpcServer(options: {
  paths: SparkPaths;
  sparkHome: string;
  db: DatabaseSync;
  forceCloseTimeoutMs?: number;
  legacyMaxRequestBytes?: number;
  onStop?: () => void | Promise<void>;
  onStopRequested?: () => void;
  onRestart?: () => LocalDaemonRestartResult | Promise<LocalDaemonRestartResult>;
  onUplinkReconfigure?: (serverUrl?: string) => void;
  getLifecycle?: () => SparkDaemonLifecycleSnapshot;
  getBuildFingerprint?: () => string;
  isReady?: () => boolean;
  eventBus?: SparkDaemonLocalEventBus;
  channelIngress?: DaemonChannelIngressRuntime;
  sessionRegistry?: DaemonSessionRegistry;
  modelControl?: SparkDaemonModelControl;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  respondHumanInteraction?: SparkDaemonHumanInteractionResponder;
  leaseTransfers?: SparkDaemonLeaseTransferBroker;
  onHumanRequestOutboxReady?: () => void;
  onInvocationQueued?: () => void;
  getRuntimeIdForServer?: (serverUrl: string) => string | undefined;
  mailStore?: LocalRpcMailStore;
}): Promise<LocalRpcServer> {
  const legacyMaxRequestBytes = options.legacyMaxRequestBytes ?? DEFAULT_LEGACY_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(legacyMaxRequestBytes) || legacyMaxRequestBytes < 1) {
    throw new RangeError("legacyMaxRequestBytes must be a positive safe integer.");
  }
  const socketPath = localRpcSocketPath(options.paths);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const sockets = new Map<Socket, { pending: number; closeWhenIdle: boolean }>();
  // Transport shutdown may time out, but handlers still own daemon resources
  // until they settle. Keep that lifetime independent from socket lifetime.
  const inFlightRequests = new Set<Promise<unknown>>();
  let closePromise: Promise<void> | undefined;
  let closing = false;
  const trackRequest = (request: Promise<unknown>) => {
    inFlightRequests.add(request);
    void request.then(
      () => inFlightRequests.delete(request),
      () => inFlightRequests.delete(request),
    );
  };

  const config = readSparkDaemonConfig(options.paths);
  const sessionRegistry =
    options.sessionRegistry ??
    createDaemonSessionRegistry(options.sparkHome, {
      daemonId: config.installationId,
      resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(options.db, workspaceId),
      resolveSessionCwd: (input) => resolveSessionCwdForWorkspaceId(options.db, input),
    });
  const mailStore =
    options.mailStore ?? new SparkSessionMailStore({ sparkHome: options.sparkHome });
  const notificationDeliveryStore = new SparkChannelDeliveryStore(options.db);
  const notificationDeliveryQueue = {
    store: notificationDeliveryStore,
    outbox: createDaemonChannelDeliveryOutbox(notificationDeliveryStore),
  } satisfies SessionNotificationDeliveryQueue;
  const handlerOptions: LocalRpcHandlerOptions = {
    sessionRegistry,
    mailStore,
    notificationDeliveryQueue,
    ...(options.eventBus ? { eventBus: options.eventBus } : {}),
    ...(options.channelIngress ? { channelIngress: options.channelIngress } : {}),
    ...(options.modelControl ? { modelControl: options.modelControl } : {}),
    ...(options.humanWaits ? { humanWaits: options.humanWaits } : {}),
    ...(options.respondHumanInteraction
      ? { respondHumanInteraction: options.respondHumanInteraction }
      : {}),
    ...(options.leaseTransfers ? { leaseTransfers: options.leaseTransfers } : {}),
    ...(options.onHumanRequestOutboxReady
      ? { onHumanRequestOutboxReady: options.onHumanRequestOutboxReady }
      : {}),
    ...(options.onInvocationQueued ? { onInvocationQueued: options.onInvocationQueued } : {}),
    ...(options.getRuntimeIdForServer
      ? { getRuntimeIdForServer: options.getRuntimeIdForServer }
      : {}),
    ...(options.onStopRequested ? { onStopRequested: options.onStopRequested } : {}),
    ...(options.onRestart ? { onRestart: options.onRestart } : {}),
    ...(options.onUplinkReconfigure ? { onUplinkReconfigure: options.onUplinkReconfigure } : {}),
    ...(options.getLifecycle ? { getLifecycle: options.getLifecycle } : {}),
    ...(options.getBuildFingerprint ? { getBuildFingerprint: options.getBuildFingerprint } : {}),
    ...(options.isReady ? { isReady: options.isReady } : {}),
  };
  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    const state = { pending: 0, closeWhenIdle: false };
    sockets.set(socket, state);
    socket.once("close", () => sockets.delete(socket));
    handleLocalRpcSocket(
      socket,
      options.paths,
      options.db,
      options.onStop,
      options.eventBus,
      handlerOptions,
      {
        onRequestStart: (request) => {
          state.pending += 1;
          trackRequest(request);
        },
        onRequestSettled: () => {
          state.pending -= 1;
          if (state.closeWhenIdle && state.pending === 0) socket.end();
        },
      },
      legacyMaxRequestBytes,
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  let orpcServer: LocalRpcOrpcServer | undefined;
  try {
    orpcServer = await startLocalRpcOrpcServer({
      paths: options.paths,
      db: options.db,
      ...(options.forceCloseTimeoutMs === undefined
        ? {}
        : { forceCloseTimeoutMs: options.forceCloseTimeoutMs }),
      ...(options.onStop ? { onStop: options.onStop } : {}),
      handlerOptions,
      onRequestStart: trackRequest,
    });
  } catch (error) {
    // oRPC is additive; legacy local-rpc must still start if the parallel socket fails.
    console.error("[spark-daemon] failed to start local-rpc oRPC socket", error);
  }

  return {
    socketPath,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      const transportClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          rmSync(socketPath, { force: true });
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      for (const [socket, state] of sockets) {
        state.closeWhenIdle = true;
        // Freeze request admission before snapshotting in-flight work below.
        socket.pause();
        if (state.pending === 0) socket.end();
      }
      const forceClose = setTimeout(() => {
        for (const socket of sockets.keys()) socket.destroy();
      }, options.forceCloseTimeoutMs ?? 5_000);
      forceClose.unref();
      const orpcClosed = orpcServer?.close() ?? Promise.resolve();
      const requestsSettled = Promise.allSettled([...inFlightRequests]);
      closePromise = Promise.allSettled([transportClosed, requestsSettled, orpcClosed])
        .then(([transport]) => {
          if (transport.status === "rejected") throw transport.reason;
        })
        .finally(() => clearTimeout(forceClose));
      return closePromise;
    },
  };
}

function handleLocalRpcSocket(
  socket: Socket,
  paths: SparkPaths,
  db: DatabaseSync,
  onStop: (() => void | Promise<void>) | undefined,
  eventBus: SparkDaemonLocalEventBus | undefined,
  handlerOptions: LocalRpcHandlerOptions,
  lifecycle: { onRequestStart(request: Promise<void>): void; onRequestSettled(): void },
  maxRequestBytes: number,
): void {
  let buffer = Buffer.alloc(0);
  socket.on("error", () => {
    // Clients may time out or disconnect before a long-running request writes
    // its response. Treat broken local RPC pipes as per-client failures rather
    // than daemon-fatal uncaught Socket errors.
  });
  socket.on("data", (chunk) => {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    buffer = Buffer.concat([buffer, incoming]);
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      if (newline > maxRequestBytes) {
        buffer = Buffer.alloc(0);
        socket.destroy();
        return;
      }
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      const request = handleLocalRpcLine(line, paths, db, onStop, handlerOptions).then(
        async (response) => {
          await writeLocalRpcResponse(socket, response);
        },
      );
      lifecycle.onRequestStart(request);
      void request.then(
        () => lifecycle.onRequestSettled(),
        () => lifecycle.onRequestSettled(),
      );
      newline = buffer.indexOf(0x0a);
    }
    if (buffer.length > maxRequestBytes) {
      buffer = Buffer.alloc(0);
      socket.destroy();
    }
  });
}

function writeLocalRpcResponse(socket: Socket, response: LocalRpcResponse): Promise<void> {
  if (socket.destroyed || !socket.writable) return Promise.resolve();
  return new Promise<void>((resolve) => {
    socket.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) socket.destroy();
      resolve();
    });
  });
}
