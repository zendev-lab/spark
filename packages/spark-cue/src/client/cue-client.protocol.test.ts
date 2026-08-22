import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CueClient, CueError, CueTransportError } from "../index.ts";
import type { ExecutionInfo, ExecutionPlan, ExecutionSpec } from "../wire/types.ts";

type Frame = Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

function encode(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function send(socket: Socket, id: number, ok: unknown): void {
  socket.write(encode({ type: "response", id, payload: { Ok: ok } }));
}

function requestPayload(message: Frame): Record<string, unknown> {
  assert.equal(message.type, "request");
  assert.equal(typeof message.id, "number");
  assert.ok(message.payload && typeof message.payload === "object");
  return message.payload as Record<string, unknown>;
}

function pipeline(command = ["true"]): ExecutionPlan {
  return {
    kind: "pipeline",
    pipeline: { segments: [{ command, pipe_to_next: null }] },
  };
}

function spec(plan: ExecutionPlan = pipeline()): ExecutionSpec {
  return { plan, launch_context: {}, source: { name: "<test>" } };
}

function execution(
  state: ExecutionInfo["state"] = { status: "succeeded" },
  executionSpec = spec(),
): ExecutionInfo {
  return {
    id: 1,
    state,
    steps: [
      {
        id: { execution: 1, index: 1 },
        state:
          state.status === "running"
            ? { status: "running" }
            : state.status === "succeeded"
              ? { status: "succeeded" }
              : { status: "queued" },
        pipeline: "true",
      },
    ],
    spec: executionSpec,
  };
}

async function startServer(
  handler: (message: Frame, socket: Socket) => void,
  options: { protocolVersion?: number; capabilities?: string[] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "spark-cue-v3-"));
  const socketPath = join(root, "cued.sock");
  const sockets = new Set<Socket>();
  const requests: Frame[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < length + 4) break;
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Frame;
        buffer = buffer.subarray(length + 4);
        requests.push(message);
        const payload = requestPayload(message);
        if ("Handshake" in payload) {
          send(socket, message.id as number, { Ack: {} });
        } else if ("Ping" in payload) {
          send(socket, message.id as number, {
            Pong: {
              version: "0.2.0",
              protocol_version: options.protocolVersion ?? 3,
              capabilities: options.capabilities ?? [
                "execution-v3",
                "session-handshake-required",
                "operation-idempotency",
              ],
              instance_id: "00000000-0000-4000-8000-000000000001",
              generation_id: "generation-1",
              ready: true,
            },
          });
        } else {
          handler(message, socket);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  cleanups.push(close);
  return { socketPath, requests, close };
}

class SynchronousStream extends EventEmitter {
  write(frame: Buffer): boolean {
    const length = frame.readUInt32BE(0);
    const message = JSON.parse(frame.subarray(4, length + 4).toString("utf8")) as Frame;
    const payload = requestPayload(message);
    const ok = "ListExecutions" in payload ? { ExecutionList: [] } : { Ack: {} };
    this.emit("data", encode({ type: "response", id: message.id, payload: { Ok: ok } }));
    return true;
  }
  destroy(): void {
    this.emit("close");
  }
}

describe("Cue IPC v3 client", () => {
  it("registers a pending response before a synchronous stream write", async () => {
    const client = new CueClient(new SynchronousStream());
    await expect(client.listExecutions()).resolves.toEqual([]);
    expect(CueClient.__pendingRequestCountForTests(client)).toBe(0);
    client.close();
  });

  it("handshakes with protocol v3 before checking daemon capabilities", async () => {
    const server = await startServer(() => undefined);
    const client = await CueClient.connect(server.socketPath, {
      sessionId: "typed-session",
      cwd: "/workspace",
      env: { SAFE: "1" },
    });
    expect(server.requests.map((request) => Object.keys(requestPayload(request))[0])).toEqual([
      "Handshake",
      "Ping",
    ]);
    expect(requestPayload(server.requests[0]!).Handshake).toMatchObject({
      protocol_version: 3,
      session_id: "typed-session",
      cwd: "/workspace",
      env: { SAFE: "1" },
    });
    client.close();
  });

  it("hard-rejects a v2 daemon during initialization", async () => {
    const server = await startServer(() => undefined, { protocolVersion: 2 });
    await expect(CueClient.connect(server.socketPath)).rejects.toMatchObject({
      code: "UNSUPPORTED_PROTOCOL",
    });
  });

  it("submits typed plans with per-segment env and an opaque spawn adapter", async () => {
    let submitted: ExecutionSpec | undefined;
    const server = await startServer((message, socket) => {
      const payload = requestPayload(message);
      if ("SubmitExecution" in payload) {
        submitted = (payload.SubmitExecution as { spec: ExecutionSpec }).spec;
        const durable = structuredClone(submitted);
        delete durable.launch_context.spawn_adapter;
        send(socket, message.id as number, {
          ExecutionCreated: { execution: execution({ status: "succeeded" }, durable) },
        });
      } else if ("ReadExecutionOutput" in payload) {
        send(socket, message.id as number, {
          ExecutionOutput: {
            id: 1,
            steps: [
              {
                id: { execution: 1, index: 1 },
                stdout: { data: "ok\n", truncated: false, encoding: "utf8" },
                stderr: { data: "", truncated: false, encoding: "utf8" },
                stderr_pty_merged: false,
              },
            ],
          },
        });
      }
    });
    const client = await CueClient.connect(server.socketPath);
    const result = await client.runExecution("A=one printf ok |> B=two cat", {
      spawnAdapter: { endpoint: "/tmp/cue/adapters/dsh.sock", token: "opaque" },
    });

    expect(submitted?.launch_context.spawn_adapter).toEqual({
      endpoint: "/tmp/cue/adapters/dsh.sock",
      token: "opaque",
    });
    expect(submitted?.plan).toMatchObject({
      kind: "pipeline",
      pipeline: {
        segments: [
          { env: { A: "one" }, command: ["printf", "ok"], pipe_to_next: "Stdout" },
          { env: { B: "two" }, command: ["cat"], pipe_to_next: null },
        ],
      },
    });
    expect(result).toMatchObject({ executionId: "E1", status: "succeeded", stdout: "ok\n" });
    client.close();
  });

  it("cancels the execution when a foreground call is aborted", async () => {
    const controller = new AbortController();
    const server = await startServer((message, socket) => {
      const payload = requestPayload(message);
      if ("SubmitExecution" in payload) {
        send(socket, message.id as number, {
          ExecutionCreated: { execution: execution({ status: "running" }) },
        });
        controller.abort(new Error("stop"));
      } else if ("CancelExecution" in payload) {
        send(socket, message.id as number, { Ack: {} });
      }
    });
    const client = await CueClient.connect(server.socketPath);
    await expect(
      client.runExecution("sleep 10", { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(
      server.requests.some(
        (request) =>
          JSON.stringify(requestPayload(request)) ===
          JSON.stringify({ CancelExecution: { id: 1, mode: "graceful" } }),
      ),
    ).toBe(true);
    client.close();
  });

  it("compiles a .cue file into one fail-fast execution instead of RunScript", async () => {
    let submitted: ExecutionSpec | undefined;
    const server = await startServer((message, socket) => {
      const payload = requestPayload(message);
      if ("SubmitExecution" in payload) {
        submitted = (payload.SubmitExecution as { spec: ExecutionSpec }).spec;
        send(socket, message.id as number, {
          ExecutionCreated: { execution: execution({ status: "succeeded" }, submitted) },
        });
      } else if ("ReadExecutionOutput" in payload) {
        send(socket, message.id as number, { ExecutionOutput: { id: 1, steps: [] } });
      }
    });
    const client = await CueClient.connect(server.socketPath);
    const result = await client.runScript({ path: "build.cue", input: "A=1 first\nsecond" });
    expect(submitted?.plan.kind).toBe("on_success");
    expect(result).toMatchObject({ executionId: "E1", status: "done" });
    expect(server.requests.some((request) => "RunScript" in requestPayload(request))).toBe(false);
    client.close();
  });

  it("preserves cancelled script executions as cancelled", async () => {
    const server = await startServer((message, socket) => {
      const payload = requestPayload(message);
      if ("SubmitExecution" in payload) {
        send(socket, message.id as number, {
          ExecutionCreated: { execution: execution({ status: "cancelled", reason: "forced" }) },
        });
      } else if ("GetExecution" in payload) {
        send(socket, message.id as number, {
          ExecutionInfo: execution({ status: "cancelled", reason: "forced" }),
        });
      } else if ("ReadExecutionOutput" in payload) {
        send(socket, message.id as number, { ExecutionOutput: { id: 1, steps: [] } });
      }
    });
    const client = await CueClient.connect(server.socketPath);

    const result = await client.runScript({ path: "build.cue", input: "true" });
    expect(result).toMatchObject({
      executionId: "E1",
      status: "cancelled",
      cancelReason: "forced",
    });
    expect(result).not.toHaveProperty("items");
    client.close();
  });

  it("uses typed schedule IDs and templates", async () => {
    const server = await startServer((message, socket) => {
      const payload = requestPayload(message);
      if ("CreateSchedule" in payload) {
        const create = payload.CreateSchedule as { schedule: unknown; execution: ExecutionSpec };
        send(socket, message.id as number, {
          ScheduleCreated: {
            schedule: {
              id: 9,
              schedule: create.schedule,
              execution: create.execution,
              status: "scheduled",
            },
          },
        });
      } else if ("ListSchedules" in payload) {
        send(socket, message.id as number, { ScheduleList: [] });
      }
    });
    const client = await CueClient.connect(server.socketPath);
    await expect(client.addSchedule("every 5m", "true")).resolves.toBe("T9");
    await expect(client.listScheduleSummaries()).resolves.toEqual([]);
    client.close();
  });

  it("closes on unknown fields in typed projections", async () => {
    const server = await startServer((message, socket) => {
      if ("ListExecutions" in requestPayload(message)) {
        send(socket, message.id as number, {
          ExecutionList: [{ ...execution(), inferred_status: "done" }],
        });
      }
    });
    const client = await CueClient.connect(server.socketPath);
    await expect(client.listExecutions()).rejects.toBeInstanceOf(CueTransportError);
    await client.closed;
    expect(client.isClosed).toBe(true);
  });

  it("preserves typed daemon errors", async () => {
    const server = await startServer((message, socket) => {
      socket.write(
        encode({
          type: "response",
          id: message.id,
          payload: { Err: { code: "NOT_FOUND", message: "E404 not found" } },
        }),
      );
    });
    const client = await CueClient.connect(server.socketPath);
    await expect(client.getExecution("E404")).resolves.toBeNull();
    await expect(client.cancelExecution("E404")).rejects.toEqual(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    client.close();
  });
});
