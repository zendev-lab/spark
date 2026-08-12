import { DatabaseSync } from "node:sqlite";

import { parseSparkSessionState } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";

import type { DaemonSessionRegistry } from "./session-registry.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import {
  ensureWorkspaceAdministratorSession,
  getWorkspaceAdministratorProvisioning,
} from "./workspace-administrator-session.ts";

describe("Workspace Administrator provisioning", () => {
  it("persists retryable failures and preserves the retry count after reconciliation", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    let attempts = 0;
    const registry = {
      ensureWorkspaceAdministrator: async () => {
        attempts += 1;
        if (attempts <= 2) throw new Error(`registry unavailable ${attempts}`);
        return parseSparkSessionState({
          sessionId: "sess_admin",
          scope: { kind: "workspace", workspaceId: "ws_demo" },
          lifecycle: "open",
          placement: "active",
          roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
          owner: { kind: "workspace", workspaceId: "ws_demo" },
          incarnation: 1,
          stateBinding: { kind: "session", ref: "sess_admin" },
          visibility: "public",
          retention: "audit",
          purpose: "workspace_administrator",
          closeReceipts: [],
          bindings: [],
          tags: [],
          archiveHistory: [],
          name: "Administrator",
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
        });
      },
    } as unknown as DaemonSessionRegistry;

    await expect(ensureWorkspaceAdministratorSession(db, registry, "ws_demo")).rejects.toThrow(
      /registry unavailable 1/u,
    );
    expect(getWorkspaceAdministratorProvisioning(db, "ws_demo")).toMatchObject({
      state: "failed",
      error: "registry unavailable 1",
      retryCount: 1,
    });

    await expect(ensureWorkspaceAdministratorSession(db, registry, "ws_demo")).rejects.toThrow(
      /registry unavailable 2/u,
    );
    expect(getWorkspaceAdministratorProvisioning(db, "ws_demo")).toMatchObject({
      state: "failed",
      error: "registry unavailable 2",
      retryCount: 2,
    });

    await expect(
      ensureWorkspaceAdministratorSession(db, registry, "ws_demo"),
    ).resolves.toMatchObject({ workspaceId: "ws_demo", sessionId: "sess_admin" });
    expect(getWorkspaceAdministratorProvisioning(db, "ws_demo")).toMatchObject({
      state: "active",
      retryCount: 2,
    });
    db.close();
  });
});
