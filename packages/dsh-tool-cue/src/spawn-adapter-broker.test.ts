import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";

import type { SandboxProvider } from "@deepseek-ai/dsh-sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startSpawnAdapterBroker, type SpawnAdapterBroker } from "./spawn-adapter-broker.ts";

const roots: string[] = [];
const brokers: SpawnAdapterBroker[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map(async (broker) => broker.close()));
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(confine: SandboxProvider["confine"]): Promise<SpawnAdapterBroker> {
  const root = await mkdtemp(join("/tmp", "dca-"));
  roots.push(root);
  const broker = await startSpawnAdapterBroker({
    sandbox: { confine } as SandboxProvider,
    policy: { mode: "read-only", workspaceRoot: "/workspace" },
    runtimeDir: join(root, "cue", "adapters"),
  });
  brokers.push(broker);
  return broker;
}

async function call(broker: SpawnAdapterBroker, request: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(request), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(broker.handle.endpoint);
    let response = Buffer.alloc(0);
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
    });
    socket.once("end", () => {
      const length = response.readUInt32BE(0);
      resolve(
        JSON.parse(response.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>,
      );
    });
    socket.end(Buffer.concat([header, body]));
  });
}

function prepare(broker: SpawnAdapterBroker, segmentIndex = 0) {
  return call(broker, {
    type: "prepare",
    token: broker.handle.token,
    execution_id: 7,
    step_id: { execution: 7, index: 1 },
    segment_index: segmentIndex,
    argv: ["printf", "hello"],
    cwd: "/workspace",
  });
}

function settle(
  broker: SpawnAdapterBroker,
  diagnosticTail: string,
  result: Record<string, unknown> = { type: "exited", code: 1 },
) {
  return call(broker, {
    type: "settle",
    token: broker.handle.token,
    execution_id: 7,
    step_id: { execution: 7, index: 1 },
    segment_index: 0,
    result,
    diagnostic_tail: diagnosticTail,
    diagnostic_truncated: false,
  });
}

describe("DSH Cue spawn adapter broker", () => {
  it("confines every prepared segment once and records backend-specific denial facts", async () => {
    const confine = vi.fn(() => ({
      argv: ["sandbox-runner", "--", "printf", "hello"],
      enforcement: "full" as const,
      denialSignatures: ["operation not permitted"],
      runnerFailureRules: [],
    }));
    const broker = await fixture(confine);

    await expect(prepare(broker)).resolves.toEqual({
      type: "prepared",
      argv: ["sandbox-runner", "--", "printf", "hello"],
    });
    await expect(prepare(broker)).resolves.toEqual({
      type: "rejected",
      message: "spawn segment was prepared more than once",
    });
    await expect(settle(broker, "write: Operation not permitted")).resolves.toEqual({
      type: "settled",
    });

    expect(confine).toHaveBeenCalledTimes(1);
    expect(broker.facts()).toEqual([
      expect.objectContaining({
        executionId: 7,
        segmentIndex: 0,
        mode: "read-only",
        enforcement: "full",
        denied: true,
        runnerFailure: false,
      }),
    ]);
  });

  it("classifies runner failure before denial and fails settlement closed", async () => {
    const broker = await fixture(() => ({
      argv: ["sandbox-runner", "--", "true"],
      enforcement: "partial",
      denialSignatures: ["denied"],
      runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ["runner failed"] }],
    }));
    await prepare(broker);

    await expect(
      settle(broker, "runner failed: denied", { type: "exited", code: 125 }),
    ).resolves.toEqual({
      type: "infrastructure_failure",
      message: "sandbox runner failed before the command executed",
    });
    expect(broker.facts()[0]).toMatchObject({
      enforcement: "partial",
      runnerFailure: true,
      denied: false,
    });
  });

  it("rejects invalid tokens without invoking the sandbox provider", async () => {
    const confine = vi.fn(() => {
      throw new Error("must not run");
    });
    const broker = await fixture(confine);
    const response = await call(broker, {
      type: "prepare",
      token: "wrong",
      execution_id: 7,
      step_id: { execution: 7, index: 1 },
      segment_index: 0,
      argv: ["true"],
      cwd: "/workspace",
    });

    expect(response).toEqual({ type: "rejected", message: "invalid adapter token" });
    expect(confine).not.toHaveBeenCalled();
  });

  it("rejects unknown request fields before invoking the sandbox provider", async () => {
    const confine = vi.fn(() => {
      throw new Error("must not run");
    });
    const broker = await fixture(confine);
    const response = await call(broker, {
      type: "prepare",
      token: broker.handle.token,
      execution_id: 7,
      step_id: { execution: 7, index: 1 },
      segment_index: 0,
      argv: ["true"],
      cwd: "/workspace",
      policy: "danger-full-access",
    });

    expect(response).toEqual({
      type: "infrastructure_failure",
      message: "unknown spawn adapter field: policy",
    });
    expect(confine).not.toHaveBeenCalled();
  });

  it("refuses a symlinked Cue adapter parent", async () => {
    const root = await mkdtemp(join("/tmp", "dca-link-"));
    roots.push(root);
    const redirected = join(root, "redirected");
    await mkdir(redirected, { mode: 0o700 });
    await symlink(redirected, join(root, "cue"));

    await expect(
      startSpawnAdapterBroker({
        sandbox: { confine: vi.fn() } as unknown as SandboxProvider,
        policy: { mode: "read-only", workspaceRoot: "/workspace" },
        runtimeDir: join(root, "cue", "adapters"),
      }),
    ).rejects.toThrow("Cue adapter parent is not a directory");
  });
});
