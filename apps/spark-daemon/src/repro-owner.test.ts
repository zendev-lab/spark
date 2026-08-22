import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultArtifactStore,
  defaultEvidenceStore,
  type EvidenceRef,
} from "@zendev-lab/spark-artifacts";
import { openMemoryDatabase } from "@zendev-lab/spark-hub-db";
import { currentSparkReproCheckpoint } from "@zendev-lab/spark-repro";
import { registerSparkReproRoles } from "./product/policy/spark-repro-roles.ts";
import { gitCommand } from "@zendev-lab/spark-system";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import type { SparkDaemonModelControl } from "./model-control.ts";
import { SparkReproOwner } from "./repro-owner.ts";
import { projectDaemonSparkReproV10 } from "./repro-projection.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import { SparkReproV10Store } from "./store/repro-v10.ts";
import { registerWorkspace } from "./store/workspaces.ts";
import { gitEnvironmentWithoutRepository, gitRepositoryArguments } from "./test-support/git.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon-owned Repro v10", () => {
  it("runs five checkpoints through three stable child Sessions from a non-Git multi-repo root", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-repro-owner-"));
    roots.push(root);
    for (const name of ["model", "framework"]) {
      const repository = join(root, "repos", name);
      await mkdir(repository, { recursive: true });
      execFileSync(gitCommand(), [...gitRepositoryArguments(repository), "init", "--quiet"], {
        cwd: repository,
        env: gitEnvironmentWithoutRepository(),
      });
    }
    await expect(access(join(root, ".git"))).rejects.toThrow();

    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const workspace = registerWorkspace(db, { localPath: root, displayName: "Multi repo" });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".registry"), {
      resolveWorkspaceCwd: () => root,
    });
    const ownerSession = await sessionRegistry.ensureWorkspaceAdministrator(workspace.id);
    const submitTurn = vi.fn(async () => ({ invocationId: `inv_${submitTurn.mock.calls.length}` }));
    let failProjection = false;
    registerSparkReproRoles();
    const owner = new SparkReproOwner({
      db,
      workspace,
      sessionRegistry,
      modelControl: testModelControl(),
      submitTurn,
      onProjectionNeeded: async (repro) => {
        if (failProjection) {
          failProjection = false;
          throw new Error("simulated projection crash");
        }
        await projectDaemonSparkReproV10({ db, workspace, repro });
      },
    });

    try {
      let repro = (
        await owner.start({
          ownerSessionId: ownerSession.sessionId,
          objective: "Compare model and framework behavior across both repositories",
        })
      ).repro;
      expect(submitTurn).toHaveBeenCalledTimes(1);
      expect(
        (await owner.start({ ownerSessionId: ownerSession.sessionId, objective: repro.objective }))
          .changed,
      ).toBe(false);
      expect(submitTurn).toHaveBeenCalledTimes(1);

      const children = await sessionRegistry.list({
        parentSessionId: ownerSession.sessionId,
        includeArchived: false,
      });
      const laneSessionIds = new Set(Object.values(repro.lanes).map((lane) => lane.sessionId));
      expect(children.filter((session) => laneSessionIds.has(session.sessionId))).toHaveLength(3);

      for (let index = 0; index < 5; index += 1) {
        const checkpoint = currentSparkReproCheckpoint(repro)!;
        const runRef = checkpoint.runRef!;
        const proofRef = `evidence:repro-proof-${index}` as EvidenceRef;
        const carrierRef = `evidence:repro-result-${index}` as EvidenceRef;
        const provenance = {
          producer: "task" as const,
          taskRef: checkpoint.taskRef,
          runRef,
        };
        await defaultEvidenceStore(root).put({
          ref: proofRef,
          kind: "record",
          title: `${checkpoint.kind} proof`,
          format: "json",
          body: { passed: true, checkpoint: checkpoint.kind },
          provenance,
        });
        await defaultEvidenceStore(root).put({
          ref: carrierRef,
          kind: "record",
          title: `${checkpoint.kind} result`,
          format: "json",
          body: {
            schema: "spark.repro.lane-result/v2",
            kind: "checkpoint_result",
            reproId: repro.reproId,
            checkpointId: checkpoint.checkpointId,
            ...(checkpoint.sourceCheckpointId
              ? { sourceCheckpointId: checkpoint.sourceCheckpointId }
              : {}),
            ...(checkpoint.parentCheckpointId
              ? { parentCheckpointId: checkpoint.parentCheckpointId }
              : {}),
            sessionId: checkpoint.sessionId,
            taskRef: checkpoint.taskRef,
            runRef,
            lane: checkpoint.lane,
            checkpoint: checkpoint.kind,
            summary: `${checkpoint.kind} accepted`,
            evidenceRefs: [proofRef],
            ...(checkpoint.kind === "formalize"
              ? { formalizedRevision: "revision:formalized" }
              : {}),
          },
          provenance,
        });
        const update = await defaultTaskGraphStore(root).update(
          (graph) => {
            const run = graph.runs(repro.projectRef).find((candidate) => candidate.ref === runRef)!;
            graph.attachOutputEvidence(checkpoint.taskRef, carrierRef);
            graph.attachOutputEvidence(checkpoint.taskRef, proofRef);
            graph.setTaskStatus(checkpoint.taskRef, "done");
            if (index === 0) return run;
            return graph.recordRun({
              ...run,
              status: "succeeded",
              outputEvidenceRefs: [carrierRef, proofRef],
              finishedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          },
          { createIfMissing: false },
        );
        if (index === 0) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          failProjection = true;
        }
        repro =
          index === 0
            ? (await owner.reconcile(repro.reproId)).repro
            : await owner.ingestTerminalTaskRun(update.result);
        if (index === 0) {
          const reproStore = new SparkReproV10Store(db);
          expect(reproStore.projection(repro.reproId)?.stateUpdatedAt).not.toBe(repro.updatedAt);
          expect(reproStore.listRecoverable().map((candidate) => candidate.reproId)).toContain(
            repro.reproId,
          );
          expect((await owner.reconcile(repro.reproId)).changed).toBe(false);
          expect(reproStore.projection(repro.reproId)?.stateUpdatedAt).toBe(repro.updatedAt);
        }
      }

      expect(repro).toMatchObject({
        status: "complete",
        formalizedRevision: "revision:formalized",
      });
      expect(repro.receipts).toHaveLength(5);
      expect(submitTurn).toHaveBeenCalledTimes(5);
      const graph = await defaultTaskGraphStore(root).load();
      expect(graph?.runs(repro.projectRef)).toHaveLength(5);
      expect((await owner.reconcile(repro.reproId)).changed).toBe(false);
      const projection = new SparkReproV10Store(db).projection(repro.reproId);
      expect(projection?.stateUpdatedAt).toBe(repro.updatedAt);
      await expect(
        defaultArtifactStore(root).get(projection!.reportArtifactRef),
      ).resolves.toMatchObject({
        body: { kind: "document", mediaType: "text/markdown", management: { lifecycle: "sealed" } },
      });
      await expect(
        defaultArtifactStore(root).get(projection!.workbenchArtifactRef),
      ).resolves.toMatchObject({
        body: {
          kind: "document",
          mediaType: "application/vnd.a2ui+json",
          management: { lifecycle: "sealed" },
        },
      });
    } finally {
      db.close();
    }
  });
});

function testModelControl(): SparkDaemonModelControl {
  const model = { providerName: "test-provider", modelId: "test-model" };
  return {
    effectiveModel: async () => model,
    effectiveThinkingLevel: async () => "high",
    prepareModel: async () => undefined,
  } as unknown as SparkDaemonModelControl;
}
