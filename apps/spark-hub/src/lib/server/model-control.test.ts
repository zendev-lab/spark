import { describe, expect, it } from "vitest";
import {
  loadModelControlForHub,
  loadProjectedModelControlForHub,
  modelValue,
  parseModelValue,
  setSessionModelForHub,
  startProviderOAuthForHub,
  testModelForHub,
  type HubModelControlClient,
} from "./model-control";
import { workspaceSessionRecord } from "../../../../../test/support/session-fixtures.ts";

const model = { providerName: "baidu-oneapi", modelId: "ernie-4.5" };

describe("Hub model control adapter", () => {
  it("parses daemon catalog and session model responses", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client: HubModelControlClient = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "session.model.set") {
          return workspaceSessionRecord({
            sessionId: "sess_demo",
            workspaceId: "ws_demo",
            supervisorSessionId: "sess_administrator",
            model,
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:01:00.000Z",
          });
        }
        return {
          providers: [],
          defaultModel: model,
          session: { sessionId: "sess_demo", model },
        };
      },
    };

    const state = await loadModelControlForHub("sess_demo", client);
    const session = await setSessionModelForHub("sess_demo", model, client);

    expect(state.available).toBe(true);
    expect(state.snapshot.session?.model).toEqual(model);
    expect(session.model).toEqual(model);
    expect(calls).toEqual([
      { method: "model.catalog", params: { sessionId: "sess_demo" } },
      { method: "session.model.set", params: { sessionId: "sess_demo", model } },
    ]);
  });

  it("parses only the non-sensitive OAuth projection", async () => {
    const flow = await startProviderOAuthForHub(
      "openai-codex",
      {},
      {
        request: async () => ({
          id: "flow_1",
          providerName: "openai-codex",
          status: "pending",
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          progress: [],
          accessToken: "must-not-survive",
        }),
      },
    );

    expect(flow).not.toHaveProperty("accessToken");
  });

  it("uses one canonical provider/model form value", () => {
    expect(parseModelValue("baidu-oneapi/ernie-4.5")).toEqual(model);
    expect(modelValue(model)).toBe("baidu-oneapi/ernie-4.5");
    expect(() => parseModelValue("ernie-4.5")).toThrow(/provider\/model/u);
  });

  it("soft-fails catalog loads instead of throwing through the session page", async () => {
    const state = await loadModelControlForHub("sess_demo", {
      request: async () => {
        throw new Error("catalog unavailable");
      },
    });

    expect(state).toEqual({
      available: false,
      snapshot: { providers: [], diagnostics: [] },
      error: "catalog unavailable",
    });
  });

  it("routes the root catalog through the active workspace lease and reads cache offline", async () => {
    const calls: unknown[] = [];
    const client: HubModelControlClient = {
      request: async (_method, params) => {
        calls.push(params);
        return { providers: [], diagnostics: [] };
      },
      projectedCatalog: (params) => {
        calls.push(params);
        return { providers: [], diagnostics: [], defaultModel: model };
      },
    };

    await expect(
      loadModelControlForHub({ workspaceId: "ws_active" }, client),
    ).resolves.toMatchObject({ available: true });
    await expect(
      loadProjectedModelControlForHub({ workspaceId: "ws_active" }, client),
    ).resolves.toMatchObject({ available: true, snapshot: { defaultModel: model } });
    expect(calls).toEqual([{ workspaceId: "ws_active" }, { workspaceId: "ws_active" }]);
  });

  it("routes quick tests through the selected workspace and parses stable results", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const result = await testModelForHub(
      model,
      { workspaceId: "ws_active" },
      {
        request: async (method, params) => {
          calls.push({ method, params });
          return {
            status: "reachable",
            model,
            latencyMs: 42,
            checkedAt: "2026-08-09T00:00:00.000Z",
          };
        },
      },
    );

    expect(result).toMatchObject({ status: "reachable", latencyMs: 42 });
    expect(calls).toEqual([
      {
        method: "model.connectivity.test",
        params: { workspaceId: "ws_active", model },
      },
    ]);
  });
});
