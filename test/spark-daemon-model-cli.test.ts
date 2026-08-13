import assert from "node:assert/strict";
import { test } from "vitest";

import {
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
  type SparkDaemonClientOptions,
} from "../apps/spark-tui/src/cli/daemon.ts";
import type { SparkModelControlSnapshot } from "@zendev-lab/spark-protocol";
import { workspaceSessionRecord } from "./support/session-fixtures.ts";

const snapshot: SparkModelControlSnapshot = {
  providers: [
    {
      providerName: "provider-a",
      label: "Provider A",
      auth: {
        providerName: "provider-a",
        kind: "api_key",
        configured: true,
        source: "stored",
      },
      models: [
        {
          model: {
            providerName: "provider-a",
            modelId: "ready",
            providerLabel: "Provider A",
            modelLabel: "Ready",
          },
          reasoning: true,
          input: ["text"],
          available: true,
        },
        {
          model: {
            providerName: "provider-a",
            modelId: "locked",
            providerLabel: "Provider A",
            modelLabel: "Locked",
          },
          reasoning: false,
          input: ["text"],
          available: false,
          unavailableReason: "Configure Provider A before selecting this model.",
        },
      ],
    },
  ],
  defaultModel: { providerName: "provider-a", modelId: "ready" },
  diagnostics: [],
};

function fakeClient(
  requests: Array<{ method: string; params: unknown }>,
): SparkDaemonClientOptions {
  return {
    controlRequest: async (method, params) => {
      requests.push({ method, params });
      if (method === "session.model.set") {
        return workspaceSessionRecord({
          sessionId: "sess_demo",
          workspaceId: "ws_demo",
          supervisorSessionId: "sess_administrator",
          model: (params as { model: NonNullable<SparkModelControlSnapshot["defaultModel"]> })
            .model,
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
        });
      }
      return snapshot;
    },
  };
}

test("daemon model CLI requires explicit set scope and delegates auth to the daemon owner", () => {
  assert.throws(
    () => parseSparkDaemonCliArgs(["model", "set", "provider-a/ready"]),
    /requires exactly one/u,
  );
  assert.throws(
    () => parseSparkDaemonCliArgs(["model", "list", "--unexpected"]),
    /unknown spark daemon model option/u,
  );
  assert.throws(
    () => parseSparkDaemonCliArgs(["model", "set", "provider-a/ready", "--default=yes"]),
    /does not accept a value/u,
  );
  assert.throws(
    () =>
      parseSparkDaemonCliArgs([
        "model",
        "set",
        "provider-a/ready",
        "--session",
        "sess_demo",
        "--default",
      ]),
    /requires exactly one/u,
  );
  assert.deepEqual(parseSparkDaemonCliArgs(["auth", "import", "pi", "--json"]), {
    action: "service",
    argv: ["auth", "import", "pi", "--json"],
  });
});

test("daemon model list hides unavailable entries unless --all is set", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  let visible = "";
  await runSparkDaemonCliCommand(
    parseSparkDaemonCliArgs(["model", "list"]),
    { write: (value) => ((visible += value), true) },
    fakeClient(requests),
  );
  assert.match(visible, /provider-a\/ready/u);
  assert.doesNotMatch(visible, /provider-a\/locked/u);

  let all = "";
  await runSparkDaemonCliCommand(
    parseSparkDaemonCliArgs(["model", "list", "--all"]),
    { write: (value) => ((all += value), true) },
    fakeClient(requests),
  );
  assert.match(all, /provider-a\/locked  unavailable/u);
});

test("daemon model status and set use the canonical model RPCs", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  let output = "";
  await runSparkDaemonCliCommand(
    parseSparkDaemonCliArgs(["model", "set", "provider-a/ready", "--session", "sess_demo"]),
    { write: (value) => ((output += value), true) },
    fakeClient(requests),
  );
  assert.deepEqual(requests, [
    {
      method: "session.model.set",
      params: {
        sessionId: "sess_demo",
        model: { providerName: "provider-a", modelId: "ready" },
      },
    },
    { method: "model.catalog", params: { sessionId: "sess_demo" } },
  ]);
  assert.match(output, /provider-a\/ready/u);
});
