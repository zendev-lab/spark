import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { SparkPaths } from "@zendev-lab/spark-system";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("./local-rpc/client.js", () => ({ localRpcRequest: rpc }));

import { runSparkDaemonControlCommand } from "./control-cli.ts";
import type { CliIo } from "./cli-shared.ts";

const paths = {} as SparkPaths;

beforeEach(() => {
  rpc.mockReset();
});

it("owns model selection in spark-daemon", async () => {
  const snapshot = {
    providers: [
      {
        providerName: "provider-a",
        auth: { kind: "api_key", configured: true },
        models: [
          {
            model: { providerName: "provider-a", modelId: "ready" },
            available: true,
          },
        ],
      },
    ],
    defaultModel: { providerName: "provider-a", modelId: "ready" },
  };
  rpc.mockResolvedValue(snapshot);
  const capture = outputCapture();

  await expect(
    runSparkDaemonControlCommand(
      paths,
      "model",
      ["set", "provider-a/ready", "--default", "--json"],
      capture.io,
    ),
  ).resolves.toBe(0);

  expect(rpc).toHaveBeenNthCalledWith(1, paths, "model.default.set", {
    model: { providerName: "provider-a", modelId: "ready" },
  });
  expect(rpc).toHaveBeenNthCalledWith(2, paths, "model.catalog", {});
  expect(JSON.parse(capture.stdout())).toMatchObject({
    defaultModel: { providerName: "provider-a", modelId: "ready" },
  });
});

it("maps run status onto the daemon invocation resource", async () => {
  rpc.mockResolvedValue({ invocationId: "inv_demo", status: "running", eventCursor: 0 });
  const capture = outputCapture();

  await expect(
    runSparkDaemonControlCommand(paths, "run", ["show", "inv_demo", "--json"], capture.io),
  ).resolves.toBe(0);

  expect(rpc).toHaveBeenCalledWith(paths, "turn.status", { invocationId: "inv_demo" });
  expect(JSON.parse(capture.stdout())).toMatchObject({
    invocationId: "inv_demo",
    status: "running",
  });
});

function outputCapture(): { io: CliIo; stdout: () => string } {
  let stdout = "";
  return {
    io: {
      stdout: {
        write(chunk) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: { write: () => true },
    },
    stdout: () => stdout,
  };
}

it("prints a readable session list by default and JSON on demand", async () => {
  const page = {
    sessions: [
      {
        sessionId: "sess_demo",
        activity: "idle",
        lifecycle: "open",
        placement: "active",
        name: "Demo Session",
        updatedAt: "2026-08-17T02:43:55.000Z",
      },
    ],
    hasMore: false,
  };
  rpc.mockResolvedValue(page);
  const text = outputCapture();

  await expect(runSparkDaemonControlCommand(paths, "session", ["list"], text.io)).resolves.toBe(0);

  expect(rpc).toHaveBeenCalledWith(paths, "session.list", {});
  expect(text.stdout()).toContain("sess_demo");
  expect(text.stdout()).toContain("Demo Session");
  expect(text.stdout()).toContain("1 session(s)");
  expect(text.stdout()).not.toMatch(/^\s*[{[]/);

  const json = outputCapture();
  await expect(
    runSparkDaemonControlCommand(paths, "session", ["list", "--json"], json.io),
  ).resolves.toBe(0);
  expect(JSON.parse(json.stdout())).toEqual(page);
});

it("prints a readable session detail by default", async () => {
  rpc.mockResolvedValue({
    session: {
      sessionId: "sess_detail",
      name: "Detail Session",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      lifecycle: "open",
      placement: "active",
      activity: "running",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      purpose: "interactive",
      createdAt: "2026-08-17T02:00:00.000Z",
      updatedAt: "2026-08-17T02:43:55.000Z",
    },
  });
  const capture = outputCapture();

  await expect(
    runSparkDaemonControlCommand(paths, "session", ["show", "sess_detail"], capture.io),
  ).resolves.toBe(0);

  const output = capture.stdout();
  expect(output).toContain("session: sess_detail");
  expect(output).toContain("role: role:builtin-executor");
  expect(output).toContain("activity: running");
  expect(output).not.toMatch(/^\s*[{[]/);
});

it("prints a readable inbox by default", async () => {
  rpc.mockResolvedValue({
    messages: [
      {
        id: "msg_1",
        fromSessionId: "sess_peer",
        kind: "notification",
        intent: "status",
        subject: "Run finished",
        createdAt: "2026-08-17T02:43:55.000Z",
        readAt: null,
        ackedAt: null,
      },
    ],
  });
  const capture = outputCapture();

  await expect(
    runSparkDaemonControlCommand(paths, "session", ["inbox", "--session", "sess_demo"], capture.io),
  ).resolves.toBe(0);

  const output = capture.stdout();
  expect(output).toContain("msg_1");
  expect(output).toContain("Run finished");
  expect(output).toContain("1 message(s)");
  expect(output).not.toMatch(/^\s*[{[]/);
});

it("prints a readable invocation list by default and JSON on demand", async () => {
  const page = {
    invocations: [
      {
        invocationId: "inv_demo",
        sessionId: "sess_demo",
        status: "running",
        attemptCount: 1,
        updatedAt: "2026-08-17T02:43:55.000Z",
      },
    ],
    total: 1,
    limit: 20,
    offset: 0,
    observedAt: "2026-08-17T02:44:00.000Z",
  };
  rpc.mockResolvedValue(page);
  const text = outputCapture();

  await expect(runSparkDaemonControlCommand(paths, "invocation", ["list"], text.io)).resolves.toBe(
    0,
  );

  expect(text.stdout()).toContain("inv_demo");
  expect(text.stdout()).toContain("running");
  expect(text.stdout()).toContain("showing 1\u20131 of 1");
  expect(text.stdout()).not.toMatch(/^\s*[{[]/);

  const json = outputCapture();
  await expect(
    runSparkDaemonControlCommand(paths, "invocation", ["list", "--json"], json.io),
  ).resolves.toBe(0);
  expect(JSON.parse(json.stdout())).toEqual(page);
});

it("prints a readable turn status for run show by default", async () => {
  rpc.mockResolvedValue({
    invocationId: "inv_demo",
    sessionId: "sess_demo",
    status: "failed",
    error: { code: "model_error", message: "provider unavailable" },
    eventCursor: 12,
    createdAt: "2026-08-17T02:00:00.000Z",
    updatedAt: "2026-08-17T02:43:55.000Z",
  });
  const capture = outputCapture();

  await expect(
    runSparkDaemonControlCommand(paths, "run", ["show", "inv_demo"], capture.io),
  ).resolves.toBe(0);

  const output = capture.stdout();
  expect(output).toContain("invocation: inv_demo");
  expect(output).toContain("status: failed");
  expect(output).toContain("error: model_error: provider unavailable");
  expect(output).not.toMatch(/^\s*[{[]/);
});

it("prints the assistant text for invocation result by default", async () => {
  rpc.mockResolvedValue({
    invocationId: "inv_demo",
    status: "succeeded",
    assistantText: "Done. The fix is one line.",
    finishedAt: "2026-08-17T02:43:55.000Z",
  });
  const capture = outputCapture();

  await expect(
    runSparkDaemonControlCommand(paths, "invocation", ["result", "inv_demo"], capture.io),
  ).resolves.toBe(0);

  const output = capture.stdout();
  expect(output).toContain("status: succeeded");
  expect(output).toContain("Done. The fix is one line.");
  expect(output).not.toMatch(/^\s*[{[]/);
});

it("prints a readable channel status by default", async () => {
  rpc.mockResolvedValue({
    snapshot: {
      configured: true,
      ingressEnabled: true,
      state: "running",
      adapters: [{ id: "qqbot-main", type: "qqbot", running: true, state: "connected" }],
      routes: [{}],
      lastReloadedAt: "2026-08-17T02:43:55.000Z",
    },
  });
  const capture = outputCapture();

  await expect(
    runSparkDaemonControlCommand(paths, "channel", ["status"], capture.io),
  ).resolves.toBe(0);

  const output = capture.stdout();
  expect(output).toContain("daemon channels: configured yes, ingress on, state running");
  expect(output).toContain("qqbot-main (qqbot): running — connected");
  expect(output).toContain("routes: 1");
  expect(output).not.toMatch(/^\s*[{[]/);
});

it("configures daemon-global Channels from an explicit JSON file", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-channel-cli-configure-"));
  const configPath = join(root, "channels.json");
  const config = {
    adapters: {
      feishu: { type: "feishu", app_id: "cli_app", app_secret: "private" },
    },
    routes: {},
    ingress: { enabled: true, on_unbound: "create" },
  };
  try {
    await writeFile(configPath, JSON.stringify(config));
    rpc.mockResolvedValue({
      plane: "daemon",
      resource: "channel",
      configured: true,
      ingressEnabled: true,
      state: "running",
      adapters: [],
      routes: [],
    });
    const capture = outputCapture();

    await expect(
      runSparkDaemonControlCommand(
        paths,
        "channel",
        ["configure", "--file", configPath, "--json"],
        capture.io,
      ),
    ).resolves.toBe(0);

    expect(rpc).toHaveBeenCalledWith(paths, "channel.configure", { config });
    expect(JSON.parse(capture.stdout())).toMatchObject({
      plane: "daemon",
      resource: "channel",
      configured: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
