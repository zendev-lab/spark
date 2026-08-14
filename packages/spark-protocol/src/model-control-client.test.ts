import { describe, expect, it } from "vitest";
import {
  createSparkModelControlClient,
  parseSparkModelValue,
  sparkModelValue,
} from "./model-control-client.ts";

describe("spark model control client", () => {
  it("routes catalog and session setters through one method table", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createSparkModelControlClient(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "session.model.set") {
          return {
            sessionId: "sess_demo",
            scope: { kind: "workspace", workspaceId: "ws_demo" },
            lifecycle: "open",
            placement: "active",
            lifetime: "scoped",
            activity: "idle",
            roleBinding: { kind: "none" },
            owner: { kind: "session", supervisorSessionId: "sess_admin_ws_demo" },
            incarnation: 1,
            stateBinding: { kind: "session", ref: "sess_admin_ws_demo" },
            visibility: "public",
            retention: "retain",
            purpose: "interactive",
            bindings: [],
            model: { providerName: "openai", modelId: "gpt" },
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:01:00.000Z",
          };
        }
        if (method === "provider.auth.import.pi") {
          return {
            source: "pi",
            sourcePath: "~/.pi/agent/auth.json",
            imported: [{ provider: "openai-codex", type: "oauth" }],
            overwritten: [],
            skipped: [],
            totals: { imported: 1, overwritten: 0, skipped: 0 },
          };
        }
        return {
          providers: [],
          defaultModel: { providerName: "openai", modelId: "gpt" },
          session: {
            sessionId: "sess_demo",
            model: { providerName: "openai", modelId: "gpt" },
          },
        };
      },
      { sessionId: "sess_demo" },
    );

    const snapshot = await client.snapshot();
    const session = await client.setSessionModel({ providerName: "openai", modelId: "gpt" });
    const enabled = await client.setEnabledModels([{ providerName: "openai", modelId: "gpt" }]);
    const imported = await client.importPiAuth({
      sourcePath: "/tmp/pi/auth.json",
      overwrite: true,
    });

    expect(snapshot.session?.model).toEqual({ providerName: "openai", modelId: "gpt" });
    expect(session.model).toEqual({ providerName: "openai", modelId: "gpt" });
    expect(enabled.defaultModel).toEqual({ providerName: "openai", modelId: "gpt" });
    expect(imported.totals.imported).toBe(1);
    expect(calls).toEqual([
      { method: "model.catalog", params: { sessionId: "sess_demo" } },
      {
        method: "session.model.set",
        params: { sessionId: "sess_demo", model: { providerName: "openai", modelId: "gpt" } },
      },
      {
        method: "model.enabled.set",
        params: { models: [{ providerName: "openai", modelId: "gpt" }] },
      },
      {
        method: "provider.auth.import.pi",
        params: { sourcePath: "/tmp/pi/auth.json", overwrite: true },
      },
    ]);
  });

  it("parses provider/model values", () => {
    expect(parseSparkModelValue("openai/gpt-5")).toEqual({
      providerName: "openai",
      modelId: "gpt-5",
    });
    expect(sparkModelValue({ providerName: "openai", modelId: "gpt-5" })).toBe("openai/gpt-5");
  });
});
