import { describe, expect, it } from "vitest";

import type { SparkWebDaemonInvoker } from "./rpc.ts";
import { loadSparkWebDashboard } from "./dashboard.ts";

describe("Spark Web daemon dashboard", () => {
  it("loads daemon Sessions and Invocations without requiring a Workspace", async () => {
    const calls: string[] = [];
    const invoke = (async (method: string, input: Record<string, unknown>) => {
      calls.push(method);
      switch (method) {
        case "workspace.list":
          return { workspaces: [], observedAt: "2026-08-23T00:00:00.000Z" };
        case "session.list":
          return input.cursor
            ? []
            : [
                {
                  sessionId: "daemon-session",
                  scope: { kind: "daemon" },
                  lineage: { kind: "root" },
                },
              ];
        case "invocation.list":
          return {
            invocations: [
              {
                invocationId: "inv_Daemon1",
                sessionId: "daemon-session",
                status: "running",
                attemptCount: 1,
                retryable: false,
                eventCursor: 2,
                createdAt: "2026-08-23T00:00:00.000Z",
                updatedAt: "2026-08-23T00:00:01.000Z",
              },
            ],
            total: 1,
            limit: 100,
            offset: 0,
            observedAt: "2026-08-23T00:00:01.000Z",
          };
        case "human.interaction.list":
          return { waits: [] };
        default:
          throw new Error(`unexpected RPC ${method}`);
      }
    }) as SparkWebDaemonInvoker;

    const dashboard = await loadSparkWebDashboard(invoke);

    expect(dashboard.workspaces).toEqual([]);
    expect(dashboard.sessions.map((session) => session.sessionId)).toEqual(["daemon-session"]);
    expect(dashboard.invocations.map((invocation) => invocation.invocationId)).toEqual([
      "inv_Daemon1",
    ]);
    expect(calls).not.toContain("artifact.list");
  });

  it("aggregates bounded Artifact catalogs as Workspace context", async () => {
    const invoke = (async (method: string, input: Record<string, unknown>) => {
      switch (method) {
        case "workspace.list":
          return {
            workspaces: [
              { id: "ws-a", displayName: "A", localPath: "/a", status: "active" },
              { id: "ws-b", displayName: "B", localPath: "/b", status: "active" },
            ],
            observedAt: "2026-08-23T00:00:00.000Z",
          };
        case "session.list":
          return [];
        case "invocation.list":
          return {
            invocations: [],
            total: 0,
            limit: 100,
            offset: 0,
            observedAt: "2026-08-23T00:00:00.000Z",
          };
        case "human.interaction.list":
          return { waits: [] };
        case "artifact.list": {
          const workspaceId = String(input.workspaceId);
          return {
            workspaceId,
            total: workspaceId === "ws-a" ? 3 : 1,
            artifacts: [artifact(`${workspaceId}-report`, workspaceId === "ws-a" ? "01" : "02")],
          };
        }
        default:
          throw new Error(`unexpected RPC ${method}`);
      }
    }) as SparkWebDaemonInvoker;

    const dashboard = await loadSparkWebDashboard(invoke);

    expect(dashboard.artifactTotal).toBe(4);
    expect(dashboard.artifacts.map((entry) => entry.workspaceId)).toEqual(["ws-b", "ws-a"]);
    expect(dashboard.artifactUnavailableWorkspaceIds).toEqual([]);
  });

  it("keeps Session and Invocation discovery available when one Artifact owner fails", async () => {
    const invoke = (async (method: string) => {
      if (method === "workspace.list") {
        return {
          workspaces: [{ id: "ws-broken", displayName: "Broken", localPath: "/broken" }],
          observedAt: "2026-08-23T00:00:00.000Z",
        };
      }
      if (method === "session.list") return [];
      if (method === "invocation.list") {
        return {
          invocations: [],
          total: 0,
          limit: 100,
          offset: 0,
          observedAt: "2026-08-23T00:00:00.000Z",
        };
      }
      if (method === "human.interaction.list") return { waits: [] };
      if (method === "artifact.list") throw new Error("corrupt Artifact store");
      throw new Error(`unexpected RPC ${method}`);
    }) as SparkWebDaemonInvoker;

    const dashboard = await loadSparkWebDashboard(invoke);

    expect(dashboard.sessions).toEqual([]);
    expect(dashboard.invocations).toEqual([]);
    expect(dashboard.artifactUnavailableWorkspaceIds).toEqual(["ws-broken"]);
  });
});

function artifact(id: string, second: string) {
  return {
    ref: `artifact:${id}`,
    kind: "document",
    title: id,
    format: "markdown",
    mediaType: "text/markdown",
    sizeBytes: 1,
    hash: "a".repeat(64),
    createdAt: `2026-08-23T00:00:${second}.000Z`,
    updatedAt: `2026-08-23T00:00:${second}.000Z`,
  };
}
