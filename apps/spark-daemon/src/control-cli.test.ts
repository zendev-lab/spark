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
