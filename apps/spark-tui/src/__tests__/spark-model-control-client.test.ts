import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createSparkDaemonModelAuthClient,
  daemonSnapshotToCatalogState,
  daemonSnapshotToPickerState,
  resolveDaemonModelSelection,
} from "../cli/model-control.ts";
import { handleSparkNativeModelCommand } from "../cli.ts";
import type { SparkModelControlSnapshot } from "@zendev-lab/spark-protocol";
import type { SparkDaemonModelAuthClient } from "../cli/model-control.ts";
import type { SparkCliHostServices } from "../host/index.ts";

const snapshot: SparkModelControlSnapshot = {
  defaultModel: { providerName: "provider-a", modelId: "model-a" },
  diagnostics: [],
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
            modelId: "model-a",
            modelLabel: "Model A",
          },
          reasoning: true,
          input: ["text"],
          available: true,
          contextWindow: 32_000,
        },
        {
          model: { providerName: "provider-a", modelId: "model-locked" },
          reasoning: false,
          input: ["text"],
          available: false,
          unavailableReason: "Login required",
        },
      ],
    },
    {
      providerName: "provider-b",
      label: "Provider B",
      auth: { providerName: "provider-b", kind: "none", configured: true },
      models: [
        {
          model: { providerName: "provider-b", modelId: "model-a" },
          reasoning: false,
          input: ["text"],
          available: true,
        },
      ],
    },
  ],
};

test("daemon model picker displays unavailable models without making them selectable active", () => {
  const state = daemonSnapshotToPickerState(snapshot);

  assert.deepEqual(
    state.items.map((item) => item.value),
    ["provider-a/model-a", "provider-a/model-locked", "provider-b/model-a"],
  );
  assert.equal(state.activeModelId, "provider-a/model-a");
  assert.equal(state.items[0]?.active, true);
  assert.deepEqual(
    state.items.find((item) => item.modelId === "model-locked"),
    {
      value: "provider-a/model-locked",
      providerName: "provider-a",
      providerLabel: "Provider A",
      modelId: "model-locked",
      modelLabel: "model-locked",
      description: "Login required",
      active: false,
      available: false,
      unavailableReason: "Login required",
      loginCommand: "/login provider-a",
      reasoning: false,
    },
  );
});

test("daemon model picker exposes only the resolved scoped models", () => {
  const scoped = daemonSnapshotToPickerState({
    ...snapshot,
    enabledModels: [{ providerName: "provider-b", modelId: "model-a" }],
  });
  assert.deepEqual(
    scoped.items.map((item) => item.value),
    ["provider-b/model-a"],
  );
  assert.equal(scoped.activeModelId, undefined);

  const empty = daemonSnapshotToPickerState({ ...snapshot, enabledModels: [] });
  assert.deepEqual(empty.items, []);

  const catalog = daemonSnapshotToCatalogState({
    ...snapshot,
    enabledModels: [{ providerName: "provider-b", modelId: "model-a" }],
  });
  assert.deepEqual(
    catalog.items.map((item) => [item.value, item.enabled]),
    [
      ["provider-a/model-a", false],
      ["provider-a/model-locked", false],
      ["provider-b/model-a", true],
    ],
  );
});

test("daemon model picker prefers the persisted session model over the global default", () => {
  const state = daemonSnapshotToPickerState({
    ...snapshot,
    session: {
      sessionId: "sess_model",
      model: { providerName: "provider-b", modelId: "model-a" },
    },
  });

  assert.equal(state.activeModelId, "provider-b/model-a");
  assert.equal(state.items[0]?.active, false);
  assert.equal(state.items[2]?.active, true);
});

test("daemon model picker does not present an unavailable configured default as active", () => {
  const state = daemonSnapshotToPickerState({
    ...snapshot,
    defaultModel: { providerName: "provider-a", modelId: "model-locked" },
  });

  assert.equal(state.active, undefined);
  assert.equal(state.activeModelId, undefined);
  assert.equal(state.items.find((item) => item.modelId === "model-locked")?.active, false);
});

test("daemon model resolution requires provider when a model id is ambiguous", () => {
  assert.deepEqual(resolveDaemonModelSelection(snapshot, "provider-b/model-a"), {
    providerName: "provider-b",
    modelId: "model-a",
  });
  assert.throws(() => resolveDaemonModelSelection(snapshot, "model-a"), /Ambiguous Spark model/u);
});

test("bound daemon model control keeps session and global model RPCs distinct", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const lifecycle: string[] = [];
  let ensureCalls = 0;
  const client = createSparkDaemonModelAuthClient(
    {
      daemonStatus: async () => ({
        observedAt: "2026-07-13T00:00:00.000Z",
        servers: [],
        invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      }),
      controlRequest: async (method, params) => {
        lifecycle.push(method);
        calls.push({ method, params });
        if (method === "session.model.set") {
          return {
            sessionId: "sess_model",
            scope: { kind: "workspace", workspaceId: "ws_model" },
            lifecycle: "open",
            placement: "active",
            activity: "idle",
            lifetime: "scoped",
            roleBinding: { kind: "none" },
            incarnation: 1,
            lineage: {
              kind: "child",
              parentSessionId: "administrator:ws_model",
              origin: { kind: "session" },
            },
            visibility: "public",
            retention: "retain",
            purpose: "interactive",
            bindings: [],
            model: { providerName: "provider-b", modelId: "model-a" },
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:01:00.000Z",
          };
        }
        return snapshot;
      },
    },
    {
      sessionId: "sess_model",
      ensureSession: async () => {
        ensureCalls += 1;
        lifecycle.push("ensure-session");
      },
    },
  );

  await client.snapshot();
  await client.setSessionModel({ providerName: "provider-b", modelId: "model-a" });
  await client.setDefaultModel({ providerName: "provider-a", modelId: "model-a" });

  assert.equal(ensureCalls, 1);
  assert.deepEqual(lifecycle, [
    "ensure-session",
    "model.catalog",
    "session.model.set",
    "model.default.set",
  ]);
  assert.deepEqual(calls, [
    { method: "model.catalog", params: { sessionId: "sess_model" } },
    {
      method: "session.model.set",
      params: {
        sessionId: "sess_model",
        model: { providerName: "provider-b", modelId: "model-a" },
      },
    },
    {
      method: "model.default.set",
      params: { model: { providerName: "provider-a", modelId: "model-a" } },
    },
  ]);
});

test("daemon-backed model picker cancel is a pure no-op", async () => {
  let setCalls = 0;
  const services = {
    modelSelector: { pick: async () => undefined },
    providerRegistry: { setActive: () => assert.fail("cancel must not update local selection") },
  } as unknown as SparkCliHostServices;
  const modelControl = {
    snapshot: async () => snapshot,
    setSessionModel: async () => {
      setCalls += 1;
      throw new Error("cancel must not mutate daemon state");
    },
  } as unknown as SparkDaemonModelAuthClient;

  assert.deepEqual(await handleSparkNativeModelCommand(services, "", modelControl), {
    providerName: "provider-a",
    modelId: "model-a",
  });
  assert.equal(setCalls, 0);
});
