import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sparkLocalRpcOrpcLiveMethods,
  type SparkLocalRpcInput,
  type SparkLocalRpcOrpcClient,
  type SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import { requestSparkDaemon, SparkDaemonRpcError } from "./daemon-client.js";
import {
  createSparkDaemonOrpcClient,
  invokeSparkDaemonOrpcLiveMethod,
  sparkDaemonOrpcInvokerMethods,
} from "./daemon-local-rpc-orpc.js";

describe("Spark daemon oRPC socket client", () => {
  it("has one statically checked invoker for every contracted method", () => {
    expect([...sparkDaemonOrpcInvokerMethods].sort()).toEqual(
      [...sparkLocalRpcOrpcLiveMethods].sort(),
    );
  });

  it("preserves method-specific input and output types through the generic invoker", () => {
    type SessionGetInvocation = typeof invokeSparkDaemonOrpcLiveMethod<"session.get">;
    type RetentionApplyInvocation =
      typeof invokeSparkDaemonOrpcLiveMethod<"invocation.retention.apply">;

    expectTypeOf<Parameters<SessionGetInvocation>[2]>().toEqualTypeOf<
      SparkLocalRpcInput<"session.get">
    >();
    expectTypeOf<ReturnType<SessionGetInvocation>>().toEqualTypeOf<
      Promise<SparkLocalRpcOutput<"session.get">>
    >();
    expectTypeOf<Parameters<RetentionApplyInvocation>[2]>().toEqualTypeOf<
      SparkLocalRpcInput<"invocation.retention.apply">
    >();
    expectTypeOf<ReturnType<RetentionApplyInvocation>>().toEqualTypeOf<
      Promise<SparkLocalRpcOutput<"invocation.retention.apply">>
    >();
    expectTypeOf<{}>().not.toMatchTypeOf<SparkLocalRpcInput<"session.get">>();
    expectTypeOf<{
      before: string;
      invocationLimit: number;
      eventLimit: number;
    }>().not.toMatchTypeOf<SparkLocalRpcInput<"invocation.retention.apply">>();

    const compileContractCalls = (client: SparkLocalRpcOrpcClient) => {
      void invokeSparkDaemonOrpcLiveMethod(client, "session.get", {
        sessionId: "session-1",
      });
      void invokeSparkDaemonOrpcLiveMethod(client, "invocation.retention.apply", {
        before: "2026-07-14T00:00:00.000Z",
        invocationLimit: 10,
        eventLimit: 100,
        confirm: true,
      });
    };
    expectTypeOf(compileContractCalls).toBeFunction();
  });

  it("invokes the exact contract path without dynamic client traversal", async () => {
    const fixture = await rawOrpcFixture((_line, socket) => socket.end());
    const handle = await createSparkDaemonOrpcClient({
      socketPath: fixture.socketPath,
    });

    try {
      const result = invokeSparkDaemonOrpcLiveMethod(handle.client, "daemon.status", {}).catch(
        (error: unknown) => error,
      );
      const frame = JSON.parse(await within(fixture.requestLine)) as {
        data: string;
      };
      const request = JSON.parse(frame.data) as unknown;

      expect(request).toMatchObject({
        p: {
          u: "/daemon/status",
          b: { json: {} },
        },
      });
      await expect(within(result)).resolves.toBeInstanceOf(Error);
    } finally {
      handle.close();
      await fixture.close();
    }
  });

  it("sends retention apply through its exact confirmed contract path", async () => {
    const fixture = await rawOrpcFixture((_line, socket) => socket.end());
    const handle = await createSparkDaemonOrpcClient({ socketPath: fixture.socketPath });

    try {
      const result = invokeSparkDaemonOrpcLiveMethod(handle.client, "invocation.retention.apply", {
        before: "2026-07-14T00:00:00.000Z",
        invocationLimit: 10,
        eventLimit: 100,
        confirm: true,
      }).catch((error: unknown) => error);
      const frame = JSON.parse(await within(fixture.requestLine)) as { data: string };
      const request = JSON.parse(frame.data) as unknown;

      expect(request).toMatchObject({
        p: {
          u: "/invocation/retention/apply",
          b: {
            json: {
              before: "2026-07-14T00:00:00.000Z",
              invocationLimit: 10,
              eventLimit: 100,
              confirm: true,
            },
          },
        },
      });
      await expect(within(result)).resolves.toBeInstanceOf(Error);
    } finally {
      handle.close();
      await fixture.close();
    }
  });

  it("sends session.bind through the path reserved by the oRPC client proxy", async () => {
    const fixture = await rawOrpcFixture((_line, socket) => socket.end());
    const handle = await createSparkDaemonOrpcClient({ socketPath: fixture.socketPath });

    try {
      const result = invokeSparkDaemonOrpcLiveMethod(handle.client, "session.bind", {
        sessionId: "session-1",
        externalKey: "qqbot:c2c:session-1",
      }).catch((error: unknown) => error);
      const frame = JSON.parse(await within(fixture.requestLine)) as { data: string };
      const request = JSON.parse(frame.data) as unknown;

      expect(request).toMatchObject({
        p: {
          u: "/session/bind",
          b: {
            json: {
              sessionId: "session-1",
              externalKey: "qqbot:c2c:session-1",
            },
          },
        },
      });
      await expect(within(result)).resolves.toBeInstanceOf(Error);
    } finally {
      handle.close();
      await fixture.close();
    }
  });

  it("settles an invocation when an oversized response frame closes the port", async () => {
    const fixture = await rawOrpcFixture((_line, socket) => {
      socket.write("x".repeat(128));
    });

    try {
      const result = requestSparkDaemon(
        "daemon.status",
        {},
        {
          orpcSocketPath: fixture.socketPath,
          legacySocketPath: `${fixture.socketPath}.must-not-open`,
          responseTimeoutMs: 500,
          maxResponseBytes: 64,
        },
      ).catch((error: unknown) => error);
      await within(fixture.requestLine);
      await expect(within(result)).resolves.toBeInstanceOf(SparkDaemonRpcError);
    } finally {
      await fixture.close();
    }
  });
});

interface RawOrpcFixture {
  socketPath: string;
  requestLine: Promise<string>;
  close(): Promise<void>;
}

async function rawOrpcFixture(
  onRequest: (line: string, socket: Socket) => void,
): Promise<RawOrpcFixture> {
  const directory = mkdtempSync(join(tmpdir(), "spark-daemon-orpc-client-"));
  const socketPath = join(directory, "daemon-orpc.sock");
  const sockets = new Set<Socket>();
  let resolveRequest!: (line: string) => void;
  const requestLine = new Promise<string>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      socket.removeAllListeners("data");
      resolveRequest(line);
      onRequest(line, socket);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");

  return {
    socketPath,
    requestLine,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Test operation did not settle within ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
