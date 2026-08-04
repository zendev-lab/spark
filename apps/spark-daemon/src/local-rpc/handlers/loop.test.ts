import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import type { SparkWorkbenchActionRequest } from "@zendev-lab/spark-protocol/a2ui";
import { describe, expect, it } from "vitest";

import type { LocalRpcDispatchContext } from "./context.ts";
import { SparkInvocationStore } from "../../store/invocations.ts";
import { SparkLoopStore } from "../../store/loops.ts";
import { migrateSparkDaemonDatabase } from "../../store/schema.ts";
import { WorkbenchArtifactBindingStore } from "../../store/workbench-artifact-bindings.ts";
import { registerWorkspace } from "../../store/workspaces.ts";
import { handleLoopRequest } from "./loop.ts";

describe("trusted Workbench Loop control", () => {
  it("applies an idempotent action and rejects stale, unbound, or tampered Artifacts", async () => {
    const workspaceCwd = await mkdtemp(join(tmpdir(), "spark-workbench-action-"));
    const cwd = join(workspaceCwd, "packages", "demo");
    await mkdir(cwd, { recursive: true });
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const workspace = registerWorkspace(db, { localPath: workspaceCwd });
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));
    const started = loops.start({
      loopId: "loop-1",
      ownerSessionId: "session-1",
      cwd,
      workspaceId: workspace.id,
      prompt: "continue",
      binding: {
        goalId: "goal-1",
        workflowRunId: "workflow-run:repro-1",
        workflowSelector: "builtin:repro",
        reproId: "repro-1",
      },
    });
    const bindings = new WorkbenchArtifactBindingStore(db);
    const binding = bindings.ensure({
      ownerSessionId: started.ownerSessionId,
      goalId: started.binding.goalId!,
      workflowRunId: started.binding.workflowRunId!,
      loopId: started.loopId,
      reproId: started.binding.reproId!,
      generation: started.generation,
    });
    const artifact = await defaultArtifactStore(workspaceCwd).putManagedDocument({
      ref: binding.artifactRef,
      bindingId: binding.bindingId,
      title: "Workbench",
      mediaType: "application/vnd.a2ui+json",
      content: '{"messages":[]}',
      expectedRevision: null,
    });
    bindings.recordProjection({
      bindingId: binding.bindingId,
      expectedRevision: 0,
      revision: 1,
      artifactHash: artifact.artifact.hash!,
      projectionDigest: "projection-1",
      generation: started.generation,
      stage: "contract",
      sealed: false,
    });
    const context = { db, options: {} } as unknown as LocalRpcDispatchContext;
    const pause = actionRequest({
      artifactRef: binding.artifactRef,
      revision: 1,
      loopId: started.loopId,
      generation: started.generation,
      actionId: "pause",
      idempotencyKey: "pause-1",
    });

    db.exec(`CREATE TRIGGER fail_workbench_receipt
      BEFORE INSERT ON workbench_action_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END`);
    await expect(
      handleLoopRequest(context, { method: "loop.control", params: pause }),
    ).rejects.toThrow("receipt write failed");
    expect(loops.require(started.loopId)).toMatchObject({ status: "scheduled", generation: 1 });
    db.exec("DROP TRIGGER fail_workbench_receipt");

    const applied = await handleLoopRequest(context, { method: "loop.control", params: pause });
    expect(applied).toMatchObject({ loop: { status: "paused", generation: 2 } });
    await expect(
      handleLoopRequest(context, { method: "loop.control", params: pause }),
    ).resolves.toEqual(applied);

    await expect(
      handleLoopRequest(context, {
        method: "loop.control",
        params: actionRequest({
          ...pause.action.context,
          idempotencyKey: "pause-stale",
        }),
      }),
    ).rejects.toMatchObject({ code: "workbench_action_stale" });

    await expect(
      handleLoopRequest(context, {
        method: "loop.control",
        params: actionRequest({
          ...pause.action.context,
          artifactRef: "artifact:ordinary-agent-a2ui",
          idempotencyKey: "ordinary",
        }),
      }),
    ).rejects.toMatchObject({ code: "workbench_binding_not_found" });

    const refreshedBinding = bindings.getByLoop(started.loopId)!;
    db.prepare(
      `UPDATE workbench_artifact_bindings SET generation = ?, updated_at = ? WHERE binding_id = ?`,
    ).run(2, "2026-08-04T01:00:00.000Z", refreshedBinding.bindingId);
    await defaultArtifactStore(workspaceCwd).put({
      ref: refreshedBinding.artifactRef,
      kind: "document",
      title: "Forged Workbench",
      body: {
        ...artifact.artifact.body,
        content: '{"messages":[{"forged":true}]}',
        revision: 2,
      },
    });
    await expect(
      handleLoopRequest(context, {
        method: "loop.control",
        params: actionRequest({
          artifactRef: refreshedBinding.artifactRef,
          revision: 1,
          loopId: started.loopId,
          generation: 2,
          actionId: "resume",
          idempotencyKey: "tampered",
        }),
      }),
    ).rejects.toMatchObject({ code: "workbench_action_untrusted" });
    db.close();
  });
});

function actionRequest(
  context: SparkWorkbenchActionRequest["action"]["context"],
): SparkWorkbenchActionRequest {
  return {
    version: "v0.9.1",
    action: {
      name: "spark.loop.control",
      surfaceId: "spark-repro-repro-1",
      sourceComponentId: `control-${context.actionId}`,
      timestamp: "2026-08-04T00:00:00.000Z",
      context,
    },
  };
}
