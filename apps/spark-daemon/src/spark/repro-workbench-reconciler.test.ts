import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import { setSessionGoal } from "@zendev-lab/spark-loop";
import { buildSparkReproWorkSummary } from "@zendev-lab/spark-repro/work-summary";
import { sparkReproWorkbenchArtifactRef } from "@zendev-lab/spark-repro/workbench";
import { describe, expect, it } from "vitest";

import { SparkInvocationStore } from "../store/invocations.ts";
import { SparkLoopStore } from "../store/loops.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { WorkbenchArtifactBindingStore } from "../store/workbench-artifact-bindings.ts";
import { reconcileReproWorkbenchArtifacts } from "./repro-workbench-reconciler.ts";

describe("Repro Workbench Artifact reconciliation", () => {
  it("persists a stable live binding, typed stage checkpoint, and terminal seal", async () => {
    const workspaceCwd = await mkdtemp(join(tmpdir(), "spark-repro-workbench-"));
    const cwd = join(workspaceCwd, "packages", "demo");
    await mkdir(join(workspaceCwd, "outputs"), { recursive: true });
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));
    loops.start({
      loopId: "loop-1",
      ownerSessionId: "session-1",
      cwd,
      workspaceId: "workspace-1",
      prompt: "continue repro",
      binding: {
        goalId: "goal-1",
        workflowRunId: "workflow-run:repro-1",
        workflowSelector: "builtin:repro",
        reproId: "repro-1",
      },
    });
    await setSessionGoal(
      workspaceCwd,
      { sessionId: "session-1" },
      {
        goalId: "goal-1",
        objective: "Align model",
        source: "explicit",
        workflowSelector: "builtin:repro",
        contract: {
          status: "frozen",
          successCriteria: ["formal parity"],
          evidenceRequired: ["formal evidence"],
        },
      },
    );
    const work = reproWorkSummary("repro-1", "Align model");
    await writeFile(
      join(workspaceCwd, "outputs", "spark-summary.json"),
      `${JSON.stringify({ format: "spark-repro-summary/v1", work }, null, 2)}\n`,
      "utf8",
    );
    const bindings = new WorkbenchArtifactBindingStore(db);
    const rejected = await reconcileReproWorkbenchArtifacts({
      loopStore: loops,
      bindings,
      resolveWorkspaceCwd: (workspaceId) =>
        workspaceId === "workspace-1" ? workspaceCwd : undefined,
      async validateFormalEvidence() {
        throw new Error("formal receipt authority unavailable");
      },
    });
    expect(rejected).toMatchObject({ examined: 1, projected: 0, checkpointed: 0 });
    expect(rejected.errors).toEqual([
      { loopId: "loop-1", message: "formal receipt authority unavailable" },
    ]);

    const reconcile = () =>
      reconcileReproWorkbenchArtifacts({
        loopStore: loops,
        bindings,
        resolveWorkspaceCwd: (workspaceId) =>
          workspaceId === "workspace-1" ? workspaceCwd : undefined,
      });
    const first = await reconcile();
    expect(first).toMatchObject({ examined: 1, projected: 1, checkpointed: 1, sealed: 0 });
    const binding = bindings.getByLoop("loop-1")!;
    expect(binding).toMatchObject({ revision: 1, lifecycle: "live", lastStage: "contract" });
    expect(() =>
      bindings.ensure({
        ownerSessionId: "session-1",
        goalId: "goal-1",
        workflowRunId: "workflow-run:other",
        loopId: "loop-1",
        reproId: "other-repro",
        generation: 1,
      }),
    ).toThrow("WORKBENCH_BINDING_IDENTITY_CONFLICT");
    expect(bindings.listCheckpoints(binding.bindingId)).toHaveLength(1);
    expect(
      await defaultArtifactStore(workspaceCwd).get(sparkReproWorkbenchArtifactRef("repro-1")),
    ).toMatchObject({
      kind: "document",
      body: { revision: 1, management: { authority: "daemon", lifecycle: "live" } },
    });

    expect(await reconcile()).toMatchObject({
      projected: 0,
      checkpointed: 0,
    });

    db.prepare(
      `UPDATE loop_wakeups
       SET status = 'completed', generation = generation + 1, due_at = NULL,
           cycle_step = NULL, updated_at = ?
       WHERE loop_id = ?`,
    ).run("2026-08-04T01:00:00.000Z", "loop-1");
    const sealed = await reconcile();
    expect(sealed).toMatchObject({ projected: 1, sealed: 1 });
    expect(bindings.getByLoop("loop-1")).toMatchObject({ revision: 2, lifecycle: "sealed" });
    expect(
      await defaultArtifactStore(workspaceCwd).get(sparkReproWorkbenchArtifactRef("repro-1")),
    ).toMatchObject({ body: { revision: 2, management: { lifecycle: "sealed" } } });
    db.close();
  });

  it("scopes logical checkpoint ids to each Workbench binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-repro-checkpoint-scope-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));
    for (const index of [1, 2]) {
      const cwd = join(root, `repro-${index}`);
      const sessionId = `session-${index}`;
      const reproId = `repro-${index}`;
      await mkdir(join(cwd, "outputs"), { recursive: true });
      loops.start({
        loopId: `loop-${index}`,
        ownerSessionId: sessionId,
        cwd,
        prompt: "continue repro",
        binding: {
          goalId: `goal-${index}`,
          workflowRunId: `workflow-run:${reproId}`,
          workflowSelector: "builtin:repro",
          reproId,
        },
      });
      await setSessionGoal(
        cwd,
        { sessionId },
        {
          goalId: `goal-${index}`,
          objective: `Align model ${index}`,
          source: "explicit",
          workflowSelector: "builtin:repro",
          contract: {
            status: "frozen",
            successCriteria: ["formal parity"],
            evidenceRequired: ["formal evidence"],
          },
        },
      );
      const work = reproWorkSummary(reproId, `Align model ${index}`);
      await writeFile(
        join(cwd, "outputs", "spark-summary.json"),
        `${JSON.stringify({ format: "spark-repro-summary/v1", work }, null, 2)}\n`,
        "utf8",
      );
    }
    const bindings = new WorkbenchArtifactBindingStore(db);

    await expect(
      reconcileReproWorkbenchArtifacts({ loopStore: loops, bindings }),
    ).resolves.toMatchObject({ examined: 2, projected: 2, checkpointed: 2, errors: [] });
    const first = bindings.getByLoop("loop-1")!;
    const second = bindings.getByLoop("loop-2")!;
    expect(bindings.listCheckpoints(first.bindingId)).toMatchObject([
      { checkpointId: "stage:contract" },
    ]);
    expect(bindings.listCheckpoints(second.bindingId)).toMatchObject([
      { checkpointId: "stage:contract" },
    ]);
    db.close();
  });
});

function reproWorkSummary(reproId: string, title: string) {
  return buildSparkReproWorkSummary({
    reproId,
    title,
    stage: "contract",
    target: {
      model: "minimum_complete",
      requiredSteps: 1,
      referenceStrategies: [],
      validationTopology: { dp: 1, tp: 1, pp: 1, ep: 1, cp: 1, sp: false },
    },
    profile: {
      id: "single",
      model: "minimum_complete",
      compute: "forward",
      steps: { completed: 0, target: 1 },
      topology: { dp: 1, tp: 1, pp: 1, ep: 1, cp: 1, sp: false },
    },
    gates: ["contract", "reference", "target", "alignment", "delivery"].map((stage, index) => ({
      id: `gate-${stage}`,
      title: `${stage} gate`,
      stage: stage as "contract" | "reference" | "target" | "alignment" | "delivery",
      evidenceClass: "formal" as const,
      status: "open" as const,
      weight: index + 1,
      evidenceRefs: [],
      profile: {
        id: `profile-${stage}`,
        model: "minimum_complete" as const,
        compute: "forward" as const,
        steps: { completed: 0, target: 1 },
        topology: { dp: 1, tp: 1, pp: 1, ep: 1, cp: 1, sp: false },
      },
    })),
    reportArtifactRef: "artifact:report",
  });
}
