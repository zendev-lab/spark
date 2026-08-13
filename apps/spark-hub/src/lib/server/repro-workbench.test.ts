import { createWorkspaceWithLease } from "@zendev-lab/spark-hub-coordination/projection-services";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-hub-db";
import { parseSparkSessionView, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { describe, expect, it, vi } from "vitest";

import { controlReproWorkbenchForHub, loadProjectedReproWorkbench } from "./repro-workbench.ts";
import { workspaceSessionRecord } from "../../../../../test/support/session-fixtures.ts";

type FixtureBinding = {
  artifactRef: `artifact:${string}`;
  revision: number;
  lifecycle: "live";
  loopId: string;
  generation: number;
};

describe("trusted Repro Workbench projection", () => {
  it("loads only the Artifact revision bound by the current daemon Session snapshot", () => {
    const fixture = setup();
    try {
      expect(loadProjectedReproWorkbench(fixture.db, fixture.sessionId)).toMatchObject({
        status: "ready",
        binding: fixture.binding,
        artifactId: "art_workbench",
      });
      fixture.db
        .prepare("UPDATE artifacts SET content_ref_json = ? WHERE id = 'art_workbench'")
        .run(
          JSON.stringify({
            artifactRef: fixture.binding.artifactRef,
            mediaType: "application/vnd.a2ui+json",
            revision: 2,
            inlineText: fixture.content,
          }),
        );
      expect(loadProjectedReproWorkbench(fixture.db, fixture.sessionId)).toEqual({
        status: "pending",
        binding: fixture.binding,
      });
    } finally {
      fixture.db.close();
    }
  });

  it("rejects a stale generation before dispatching remote Loop control", async () => {
    const fixture = setup();
    const client = {
      controlWorkbench: vi.fn(),
      snapshot: vi.fn(),
    };
    try {
      const action = workbenchAction(fixture.binding);
      action.action.context.generation += 1;
      await expect(
        controlReproWorkbenchForHub(
          { db: fixture.db, sessionId: fixture.sessionId, action },
          client,
        ),
      ).rejects.toMatchObject({ code: "workbench_stale" });
      expect(client.controlWorkbench).not.toHaveBeenCalled();
    } finally {
      fixture.db.close();
    }
  });

  it("forwards the exact official action envelope and refreshes the Session projection", async () => {
    const fixture = setup();
    const result = {
      loop: {
        loopId: fixture.binding.loopId,
        ownerSessionId: fixture.sessionId,
        status: "paused" as const,
        continuity: "session" as const,
        generation: 4,
        binding: { reproId: "repro-1" },
        policy: {},
        counters: {},
        attempt: 0,
      },
      observedAt: "2026-08-04T00:00:01.000Z",
    };
    const client = {
      controlWorkbench: vi.fn().mockResolvedValue(result),
      snapshot: vi.fn().mockResolvedValue({ snapshot: {}, history: {} }),
    };
    const action = workbenchAction(fixture.binding);
    try {
      await expect(
        controlReproWorkbenchForHub(
          { db: fixture.db, sessionId: fixture.sessionId, action },
          client,
        ),
      ).resolves.toEqual(result);
      expect(client.controlWorkbench).toHaveBeenCalledWith(fixture.sessionId, action);
      expect(client.snapshot).toHaveBeenCalledWith(fixture.sessionId, { timeoutMs: 5_000 });
    } finally {
      fixture.db.close();
    }
  });
});

function setup() {
  const db = openMemoryDatabase();
  migrate(db);
  const now = "2026-08-04T00:00:00.000Z";
  const runtimeId = "rt_workbench";
  const runtimeBindingId = "rtwb_workbench";
  const sessionId = "sess_workbench";
  const binding = {
    artifactRef: "artifact:repro-workbench" as const,
    revision: 3,
    lifecycle: "live" as const,
    loopId: "loop-repro",
    generation: 3,
  };
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
       created_at, updated_at)
     VALUES (?, 'workbench-test', 'Workbench owner', 'online', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, runtimeProtocolVersion, now, now);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
       diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'workbench', 'Workbench', 'available', '{}', '{}', ?, ?)`,
  ).run(runtimeBindingId, runtimeId, now, now);
  const workspace = createWorkspaceWithLease(db, {
    slug: "workbench",
    name: "Workbench",
    runtimeWorkspaceBindingId: runtimeBindingId,
    createdAt: now,
  });
  const session = workspaceSessionRecord({
    sessionId,
    workspaceId: workspace.id,
    name: "Repro",
    activity: "idle",
    createdAt: now,
    updatedAt: now,
  });
  const snapshot = parseSparkSessionView({
    sessionId,
    status: "idle",
    messages: [],
    tools: [],
    runs: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    work: {
      primary: { loopId: binding.loopId },
      repro: {
        reproId: "repro-1",
        status: "active",
        contractStatus: "frozen",
        objective: "Reproduce the target",
        successCriteria: ["alignment"],
        evidenceRequired: ["receipt"],
        stage: { name: "alignment", title: "Alignment", index: 3, total: 5, phase: "implement" },
        plan: { revision: 1, completedSteps: 3, totalSteps: 5 },
        stopGuard: { decision: "continue", stagnationCount: 0, limit: 3 },
        workbench: binding,
        updatedAt: now,
      },
    },
  });
  db.prepare(
    `INSERT INTO runtime_session_projections
      (runtime_id, session_id, scope, workspace_id, runtime_workspace_binding_id,
       lifecycle, placement, activity, lifetime, owner_kind,
       record_json, snapshot_json, projected_at)
     VALUES (?, ?, 'workspace', ?, ?, 'open', 'active', 'idle', 'scoped', 'session', ?, ?, ?)`,
  ).run(
    runtimeId,
    sessionId,
    workspace.id,
    runtimeBindingId,
    JSON.stringify(session),
    JSON.stringify(snapshot),
    now,
  );
  const content = workbenchContent(binding);
  db.prepare(
    `INSERT INTO artifacts
      (id, workspace_id, project_id, scope, kind, title, format, source,
       runtime_workspace_binding_id, hash, size_bytes, content_ref_json, provenance_json,
       created_at, updated_at)
     VALUES ('art_workbench', ?, NULL, 'workspace', 'document', 'Repro Workbench', 'text',
       'runtime', ?, 'hash', ?, ?, ?, ?, ?)`,
  ).run(
    workspace.id,
    runtimeBindingId,
    Buffer.byteLength(content),
    JSON.stringify({
      artifactRef: binding.artifactRef,
      mediaType: "application/vnd.a2ui+json",
      revision: binding.revision,
      inlineText: content,
    }),
    JSON.stringify({ artifactRef: binding.artifactRef }),
    now,
    now,
  );
  return { db, sessionId, binding, content };
}

function workbenchContent(binding: FixtureBinding): string {
  return JSON.stringify({
    messages: [
      {
        version: "v0.9.1",
        createSurface: {
          surfaceId: "spark-repro-repro-1",
          catalogId: "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
        },
      },
      {
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "spark-repro-repro-1",
          components: [{ id: "root", component: "Text", text: "Workbench" }],
        },
      },
      {
        version: "v0.9.1",
        updateDataModel: {
          surfaceId: "spark-repro-repro-1",
          path: "/",
          value: {
            schema: "spark.repro.workbench/v1",
            reproId: "repro-1",
            ...binding,
          },
        },
      },
    ],
  });
}

function workbenchAction(binding: FixtureBinding) {
  return {
    version: "v0.9.1" as const,
    action: {
      name: "spark.loop.control" as const,
      surfaceId: "spark-repro-repro-1",
      sourceComponentId: "control-pause",
      timestamp: "2026-08-04T00:00:00.000Z",
      context: {
        actionId: "pause" as const,
        artifactRef: binding.artifactRef,
        revision: binding.revision,
        loopId: binding.loopId,
        generation: binding.generation,
        idempotencyKey: "workbench-pause-3",
      },
    },
  };
}
