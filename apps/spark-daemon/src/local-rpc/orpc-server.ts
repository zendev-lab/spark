/** oRPC MessagePort listener beside the temporary legacy NDJSON socket. */
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { RPCHandler } from "@orpc/server/message-port";
import type { SparkPaths } from "@zendev-lab/spark-platform-node";
import { createSocketMessagePort } from "@zendev-lab/spark-platform-node/socket-message-port";
import { createLocalRpcOrpcRouter, type CreateLocalRpcOrpcRouterOptions } from "./orpc-router.ts";
import type { LocalRpcHandlerOptions } from "./types.ts";

export function localRpcOrpcSocketPath(paths: SparkPaths): string {
  return join(paths.runtimeDir, "daemon-orpc.sock");
}

export interface LocalRpcOrpcServer {
  socketPath: string;
  close(): Promise<void>;
}

export async function startLocalRpcOrpcServer(options: {
  paths: SparkPaths;
  db: DatabaseSync;
  forceCloseTimeoutMs?: number;
  onStop?: () => void | Promise<void>;
  handlerOptions?: LocalRpcHandlerOptions;
  onRequestStart?: (request: Promise<unknown>) => void;
}): Promise<LocalRpcOrpcServer> {
  const socketPath = localRpcOrpcSocketPath(options.paths);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });

  const sockets = new Set<Socket>();
  const inFlightRequests = new Set<Promise<unknown>>();
  let closePromise: Promise<void> | undefined;
  let closing = false;
  const trackRequest = (request: Promise<unknown>) => {
    inFlightRequests.add(request);
    options.onRequestStart?.(request);
    void request.then(
      () => inFlightRequests.delete(request),
      () => inFlightRequests.delete(request),
    );
  };
  const routerInput: CreateLocalRpcOrpcRouterOptions = {
    paths: options.paths,
    db: options.db,
    ...(options.onStop ? { onStop: options.onStop } : {}),
    ...(options.handlerOptions ? { options: options.handlerOptions } : {}),
    isAcceptingRequests: () => !closing,
    onRequestStart: trackRequest,
  };
  const router = createLocalRpcOrpcRouter(routerInput);
  const handler = new RPCHandler(router);

  const server: Server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const port = createSocketMessagePort(socket);
    handler.upgrade(port);
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

  return {
    socketPath,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      const transportClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          rmSync(socketPath, { force: true });
          if (error) reject(error);
          else resolve();
        });
      });
      for (const socket of sockets) socket.pause();
      const forceClose = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, options.forceCloseTimeoutMs ?? 5_000);
      forceClose.unref();
      const requestsSettled = Promise.allSettled([...inFlightRequests]).then(() => {
        for (const socket of sockets) socket.end();
      });
      closePromise = Promise.allSettled([transportClosed, requestsSettled])
        .then(([transport]) => {
          if (transport.status === "rejected") throw transport.reason;
        })
        .finally(() => clearTimeout(forceClose));
      return closePromise;
    },
  };
}
