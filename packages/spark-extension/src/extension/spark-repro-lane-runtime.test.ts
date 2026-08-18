import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultEvidenceStore,
  defaultArtifactStore,
  GitLifecycleError,
  type AskRef,
  type ArtifactRef,
  type EvidenceRef,
  type JsonValue,
} from "@zendev-lab/spark-artifacts";
import { recordCanonicalAnswerEventEvidenceReceipt } from "@zendev-lab/spark-ask";
import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
  ExtensionUi,
} from "@zendev-lab/spark-core";
import { requestSparkDaemon, SparkDaemonRemoteError } from "@zendev-lab/spark-daemon-client";
import { sparkStateCwd, type SparkSessionContext } from "@zendev-lab/spark-loop";
import { sparkEvidenceAnswerEventSchema } from "@zendev-lab/spark-protocol";
import {
  createSparkSessionRepro,
  sparkReproLaneBinding,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import { afterEach, describe, expect, it } from "vitest";

import { registerSparkReproRoles } from "./spark-repro-roles.ts";
import {
  dispatchManagedTaskSessions,
  reserveManagedTaskSessions,
} from "./spark-task-session-dispatch.ts";
import {
  launchSparkReproThreeLaneRuntime,
  reconcileSparkReproThreeLaneRuntime,
  replaySparkReproLaneResult,
  type SparkReproLaneRuntimeTopology,
} from "./spark-repro-lane-runtime.ts";

const roots: string[] = [];
const SOURCE_REVISION = "1111111111111111111111111111111111111111";
const CANDIDATE_REVISION = "2222222222222222222222222222222222222222";
const CANONICAL_REVISION = "3333333333333333333333333333333333333333";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Repro three-lane runtime launch", () => {
  it("persists enqueue intent before allocating any lane side effect", async () => {
    const fixture = await runtimeFixture();
    let attemptedCheckpoint: SparkSessionRepro | undefined;
    await expect(
      launchSparkReproThreeLaneRuntime({
        cwd: fixture.cwd,
        ctx: fixture.ctx,
        ownerSessionId: "sess_root",
        repro: fixture.repro,
        deps: {
          resolveSourceRevision: async () => SOURCE_REVISION,
          repositoryIdentity: async () => "acme/glm52",
          ensureInitialArtifacts: fixture.ensureInitialArtifacts,
          reserve: fixture.reserve,
          dispatch: fixture.dispatch,
          persist: async (repro) => {
            attemptedCheckpoint = structuredClone(repro);
            throw new Error("simulated crash while persisting enqueue intent");
          },
        },
      }),
    ).rejects.toThrow("simulated crash while persisting enqueue intent");
    expect(attemptedCheckpoint?.threeLane.workItems).toHaveLength(1);
    expect(
      (await defaultTaskGraphStore(fixture.stateCwd).load())?.tasks(fixture.projectRef),
    ).toEqual([]);
    expect(fixture.sessions).toEqual([]);

    const recovered = await launchFixture(fixture);
    expect(recovered.repro.threeLane.routes[0]?.routeId).toBe(
      attemptedCheckpoint?.threeLane.routes[0]?.routeId,
    );
    expect(fixture.sessions).toHaveLength(3);
  });

  it("opens three stable child Sessions, invokes only Implementation, and replays with zero duplicates", async () => {
    const fixture = await runtimeFixture();
    const persisted: SparkSessionRepro[] = [];
    const first = await launchSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: fixture.repro,
      deps: {
        resolveSourceRevision: async () => SOURCE_REVISION,
        repositoryIdentity: async () => "acme/glm52",
        ensureInitialArtifacts: fixture.ensureInitialArtifacts,
        reserve: fixture.reserve,
        dispatch: fixture.dispatch,
        persist: async (repro) => {
          persisted.push(structuredClone(repro));
        },
      },
    });

    expect(Object.values(first.lanes).map((lane) => lane.sessionId)).toHaveLength(3);
    expect(new Set(Object.values(first.lanes).map((lane) => lane.sessionId)).size).toBe(3);
    expect(fixture.invocations).toHaveLength(1);
    expect(fixture.invocations[0]?.prompt).toContain("lane=implementation");
    expect(fixture.invocations[0]?.prompt).toContain(`runRef=${first.lanes.implementation.runRef}`);
    const graphAfterFirst = await defaultTaskGraphStore(fixture.stateCwd).load();
    expect(graphAfterFirst?.tasks(fixture.projectRef)).toHaveLength(3);
    expect(graphAfterFirst?.runs(fixture.projectRef)).toHaveLength(3);
    expect(
      graphAfterFirst
        ?.runs(fixture.projectRef)
        .map((run) => run.status)
        .sort(),
    ).toEqual(["queued", "queued", "running"]);
    expect(persisted[0]?.threeLane.routes[0]).toMatchObject({
      action: "start_binding",
      status: "pending",
    });

    const replay = await launchSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: first.repro,
      deps: {
        resolveSourceRevision: async () => {
          throw new Error("an existing WorkItem must retain its frozen source revision");
        },
        repositoryIdentity: async () => "acme/glm52",
        ensureInitialArtifacts: fixture.ensureInitialArtifacts,
        reserve: fixture.reserve,
        dispatch: fixture.dispatch,
        persist: async (repro) => {
          persisted.push(structuredClone(repro));
        },
      },
    });
    const graphAfterReplay = await defaultTaskGraphStore(fixture.stateCwd).load();
    expect(graphAfterReplay?.tasks(fixture.projectRef)).toHaveLength(3);
    for (const task of graphAfterReplay?.tasks(fixture.projectRef) ?? []) {
      expect(task.artifactRefs).toHaveLength(1);
      expect(task.executionPolicy?.completionGate).toBe("task_evidence");
      expect(task.executionPolicy?.worktreeTarget?.primaryArtifactRef).toMatch(/^artifact:/u);
    }
    expect(graphAfterReplay?.runs(fixture.projectRef)).toHaveLength(3);
    expect(fixture.sessions).toHaveLength(3);
    expect(fixture.sessionTargets).toEqual(
      expect.arrayContaining([
        fixture.artifactRefs.implementation,
        fixture.artifactRefs.exactness,
        fixture.artifactRefs.formalize,
      ]),
    );
    expect(fixture.invocations).toHaveLength(1);
    expect(replay.lanes).toEqual(first.lanes);
  });

  it("recovers the TaskRun reservation crash window without allocating another Run", async () => {
    const fixture = await runtimeFixture();
    let checkpoint = fixture.repro;
    let failOnce = true;
    await expect(
      launchSparkReproThreeLaneRuntime({
        cwd: fixture.cwd,
        ctx: fixture.ctx,
        ownerSessionId: "sess_root",
        repro: checkpoint,
        deps: {
          resolveSourceRevision: async () => SOURCE_REVISION,
          repositoryIdentity: async () => "acme/glm52",
          ensureInitialArtifacts: fixture.ensureInitialArtifacts,
          reserve: async (input) => {
            const records = await fixture.reserve(input);
            if (failOnce) {
              failOnce = false;
              throw new Error("simulated crash after TaskRun reservation");
            }
            return records;
          },
          dispatch: fixture.dispatch,
          persist: async (repro) => {
            checkpoint = structuredClone(repro);
          },
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(
      (await defaultTaskGraphStore(fixture.stateCwd).load())?.runs(fixture.projectRef),
    ).toHaveLength(3);

    const recovered = await launchSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: checkpoint,
      deps: {
        resolveSourceRevision: async () => SOURCE_REVISION,
        repositoryIdentity: async () => "acme/glm52",
        ensureInitialArtifacts: fixture.ensureInitialArtifacts,
        reserve: fixture.reserve,
        dispatch: fixture.dispatch,
        persist: async (repro) => {
          checkpoint = structuredClone(repro);
        },
      },
    });
    expect(
      (await defaultTaskGraphStore(fixture.stateCwd).load())?.runs(fixture.projectRef),
    ).toHaveLength(3);
    expect(fixture.sessions).toHaveLength(3);
    expect(fixture.invocations).toHaveLength(1);
    expect(recovered.repro.threeLane.routes[0]?.status).toBe("acknowledged");
  });

  it("recovers after invocation acceptance without submitting the start route twice", async () => {
    const fixture = await runtimeFixture();
    let checkpoint = fixture.repro;
    let failOnce = true;
    await expect(
      launchSparkReproThreeLaneRuntime({
        cwd: fixture.cwd,
        ctx: fixture.ctx,
        ownerSessionId: "sess_root",
        repro: checkpoint,
        deps: {
          resolveSourceRevision: async () => SOURCE_REVISION,
          repositoryIdentity: async () => "acme/glm52",
          ensureInitialArtifacts: fixture.ensureInitialArtifacts,
          reserve: fixture.reserve,
          dispatch: async (input) => {
            const records = await fixture.dispatch(input);
            if (failOnce) {
              failOnce = false;
              throw new Error("simulated crash after invocation acceptance");
            }
            return records;
          },
          persist: async (repro) => {
            checkpoint = structuredClone(repro);
          },
        },
      }),
    ).rejects.toThrow("simulated crash after invocation acceptance");
    expect(checkpoint.threeLane.routes[0]).toMatchObject({
      action: "start_binding",
      status: "pending",
    });
    expect(fixture.invocations).toHaveLength(1);

    const recovered = await launchSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: checkpoint,
      deps: {
        resolveSourceRevision: async () => SOURCE_REVISION,
        repositoryIdentity: async () => "acme/glm52",
        ensureInitialArtifacts: fixture.ensureInitialArtifacts,
        reserve: fixture.reserve,
        dispatch: fixture.dispatch,
        persist: async (repro) => {
          checkpoint = structuredClone(repro);
        },
      },
    });
    expect(fixture.invocations).toHaveLength(1);
    expect(fixture.sessions).toHaveLength(3);
    expect(recovered.repro.threeLane.routes[0]?.status).toBe("acknowledged");
  });

  it("checkpoints a terminal lane Run without an accepted result and resumes its Session", async () => {
    const fixture = await runtimeFixture();
    const topology = await launchFixture(fixture);
    await defaultTaskGraphStore(fixture.stateCwd).update(
      (graph) => {
        const run = graph
          .runs(fixture.projectRef)
          .find((candidate) => candidate.ref === topology.lanes.implementation.runRef);
        if (!run) throw new Error("implementation TaskRun is missing");
        graph.recordRun({
          ...run,
          status: "cancelled",
          finishedAt: "2026-08-18T00:00:30.000Z",
        });
        const task = graph.getTask(run.taskRef);
        if (task.claim) graph.releaseTaskClaim(run.taskRef, task.claim.claimedBy);
        graph.updateTask(run.taskRef, { status: "ready" });
      },
      { createIfMissing: false },
    );

    const recovered = await reconcileSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: topology.repro,
      deps: runtimeReconcileDeps(fixture),
    });

    const implementationRuns = (await defaultTaskGraphStore(fixture.stateCwd).load())
      ?.runs(fixture.projectRef)
      .filter((run) => run.taskRef === topology.lanes.implementation.taskRef);
    expect(implementationRuns).toHaveLength(2);
    expect(
      new Set(
        implementationRuns?.map(
          (run) => run.execution?.sessionId ?? run.execution?.executionSessionId,
        ),
      ).size,
    ).toBe(1);
    expect(fixture.sessions).toHaveLength(3);
    expect(fixture.invocations).toHaveLength(2);
    expect(recovered.threeLane.routes.map((route) => route.action)).toEqual([
      "start_binding",
      "resume_binding",
    ]);
    expect(recovered.threeLane.routes.every((route) => route.status === "acknowledged")).toBe(true);
    expect(recovered.threeLane.routes[1]?.cause).toMatchObject({
      kind: "recovery",
      id: topology.lanes.implementation.runRef,
    });
  });

  it.each(["runRef", "taskRef"] as const)(
    "rejects a carrier whose declared %s does not match the terminal envelope",
    async (mismatch) => {
      const fixture = await runtimeFixture();
      const topology = await launchFixture(fixture);
      const binding = topology.repro.threeLane.bindings.find(
        (candidate) => candidate.lane === "implementation",
      );
      if (!binding?.originRouteId) throw new Error("implementation binding is missing");
      const evidenceRef = `evidence:invalid-${mismatch}` as EvidenceRef;
      const result = implementationResult(topology, {
        originRouteId: binding.originRouteId,
        bindingRevision: binding.bindingRevision,
        ...(mismatch === "runRef"
          ? { runRef: topology.lanes.exactness.runRef }
          : { taskRef: topology.lanes.exactness.taskRef }),
      });
      await putLaneEvidence(fixture, {
        evidenceRef,
        runRef: topology.lanes.implementation.runRef,
        taskRef: topology.lanes.implementation.taskRef,
        body: result,
      });
      await finishRun(fixture, topology.lanes.implementation.runRef, [evidenceRef]);

      const reconciled = await reconcileSparkReproThreeLaneRuntime({
        cwd: fixture.cwd,
        ctx: fixture.ctx,
        ownerSessionId: "sess_root",
        repro: topology.repro,
        deps: runtimeReconcileDeps(fixture),
      });

      expect(reconciled.threeLane.resultReceipts).toContainEqual(
        expect.objectContaining({
          evidenceRef,
          status: "rejected",
          reason: "invalid_provenance",
        }),
      );
      expect(fixture.invocations).toHaveLength(2);
      expect(fixture.invocations[1]?.prompt).toContain("lane=implementation");
    },
  );

  it("rejects referenced Evidence that is not attached to the same TaskRun", async () => {
    const fixture = await runtimeFixture();
    const topology = await launchFixture(fixture);
    const binding = topology.repro.threeLane.bindings.find(
      (candidate) => candidate.lane === "implementation",
    );
    if (!binding?.originRouteId) throw new Error("implementation binding is missing");
    const carrierRef = "evidence:missing-linked-carrier" as EvidenceRef;
    const validationRef = "evidence:not-attached-to-run" as EvidenceRef;
    await putLaneEvidence(fixture, {
      evidenceRef: validationRef,
      runRef: topology.lanes.implementation.runRef,
      taskRef: topology.lanes.implementation.taskRef,
      body: { check: "passed" },
    });
    await putLaneEvidence(fixture, {
      evidenceRef: carrierRef,
      runRef: topology.lanes.implementation.runRef,
      taskRef: topology.lanes.implementation.taskRef,
      body: implementationResult(topology, {
        originRouteId: binding.originRouteId,
        bindingRevision: binding.bindingRevision,
        evidenceRefs: [validationRef],
      }),
    });
    await finishRun(fixture, topology.lanes.implementation.runRef, [carrierRef]);

    const reconciled = await replaySparkReproLaneResult({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: topology.repro,
      evidenceRef: carrierRef,
      deps: runtimeReconcileDeps(fixture),
    });

    expect(reconciled.threeLane.resultReceipts).toContainEqual(
      expect.objectContaining({
        evidenceRef: carrierRef,
        status: "rejected",
        reason: "missing_evidence",
      }),
    );
  });

  it("rejects a Formalize result emitted outside the canonical integrator Session", async () => {
    const fixture = await runtimeFixture();
    const topology = await launchFixture(fixture);
    const evidenceRef = "evidence:foreign-formalize-session" as EvidenceRef;
    await putLaneEvidence(fixture, {
      evidenceRef,
      runRef: topology.lanes.formalize.runRef,
      taskRef: topology.lanes.formalize.taskRef,
      body: {
        schema: "spark.repro.lane-result/v1",
        kind: "formalized",
        reproId: topology.repro.reproId,
        workItemId: topology.workItemId,
        lane: "formalize",
        planRevision: topology.repro.plan.currentRevision,
        bindingRevision: 1,
        taskRef: topology.lanes.formalize.taskRef,
        runRef: topology.lanes.formalize.runRef,
        sourceRevision: topology.sourceRevision,
        evidenceRefs: [],
        originRouteId: "route:foreign-formalize",
        canonicalRevision: "3333333333333333333333333333333333333333",
        supersededRevisions: [],
      },
    });
    await finishRun(fixture, topology.lanes.formalize.runRef, [evidenceRef], {
      sessionId: "sess_foreign_integrator",
    });

    const reconciled = await replaySparkReproLaneResult({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: topology.repro,
      evidenceRef,
      deps: runtimeReconcileDeps(fixture),
    });

    expect(reconciled.threeLane.resultReceipts).toContainEqual(
      expect.objectContaining({ evidenceRef, status: "rejected", reason: "invalid_provenance" }),
    );
  });

  it("accepts a corrected carrier after one rejection and repeated reconcile performs zero writes", async () => {
    const fixture = await runtimeFixture();
    const topology = await launchFixture(fixture);
    const binding = topology.repro.threeLane.bindings.find(
      (candidate) => candidate.lane === "implementation",
    );
    if (!binding?.originRouteId) throw new Error("implementation binding is missing");
    const rejectedRef = "evidence:rejected-first" as EvidenceRef;
    const acceptedRef = "evidence:accepted-second" as EvidenceRef;
    await putLaneEvidence(fixture, {
      evidenceRef: rejectedRef,
      runRef: topology.lanes.implementation.runRef,
      taskRef: topology.lanes.implementation.taskRef,
      body: implementationResult(topology, {
        originRouteId: binding.originRouteId,
        bindingRevision: binding.bindingRevision,
        taskRef: topology.lanes.exactness.taskRef,
      }),
    });
    await finishRun(fixture, topology.lanes.implementation.runRef, [rejectedRef]);
    let repro = await reconcileSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: topology.repro,
      deps: runtimeReconcileDeps(fixture),
    });
    expect(repro.threeLane.resultReceipts.at(-1)).toMatchObject({
      evidenceRef: rejectedRef,
      status: "rejected",
    });

    const recoveredBinding = sparkReproLaneBinding(
      repro.threeLane,
      topology.workItemId,
      "implementation",
    );
    if (!recoveredBinding?.originRouteId) throw new Error("recovered binding is missing");
    const recoveredRun = (await defaultTaskGraphStore(fixture.stateCwd).load())
      ?.runs(fixture.projectRef)
      .filter((candidate) => candidate.taskRef === recoveredBinding.taskRef)
      .at(-1);
    if (!recoveredRun) throw new Error("recovered TaskRun is missing");
    await putLaneEvidence(fixture, {
      evidenceRef: acceptedRef,
      runRef: recoveredRun.ref,
      taskRef: topology.lanes.implementation.taskRef,
      body: implementationResult(topology, {
        originRouteId: recoveredBinding.originRouteId,
        bindingRevision: recoveredBinding.bindingRevision,
        runRef: recoveredRun.ref,
        sourceRevision: recoveredBinding.sourceRevision,
      }),
    });
    await finishRun(fixture, recoveredRun.ref, [acceptedRef]);
    let writes = 0;
    repro = await reconcileSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro,
      deps: {
        ...runtimeReconcileDeps(fixture),
        persist: async () => {
          writes += 1;
        },
      },
    });
    expect(repro.threeLane.resultReceipts.at(-1)).toMatchObject({
      evidenceRef: acceptedRef,
      status: "accepted",
    });
    expect(fixture.invocations).toHaveLength(3);
    expect(fixture.invocations[2]?.prompt).toContain("lane=exactness");
    expect(writes).toBeGreaterThan(0);

    writes = 0;
    const graphBefore = JSON.stringify(await defaultTaskGraphStore(fixture.stateCwd).load());
    const replayed = await reconcileSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro,
      deps: {
        ...runtimeReconcileDeps(fixture),
        persist: async () => {
          writes += 1;
        },
      },
    });
    expect(replayed).toBe(repro);
    expect(writes).toBe(0);
    expect(fixture.invocations).toHaveLength(3);
    expect(JSON.stringify(await defaultTaskGraphStore(fixture.stateCwd).load())).toBe(graphBefore);
  });

  it("checkpoints a rolled-back Git conflict and resumes the revision-producing lane", async () => {
    const fixture = await runtimeFixture();
    const topology = await launchFixture(fixture);
    const binding = topology.repro.threeLane.bindings.find(
      (candidate) => candidate.lane === "implementation",
    );
    if (!binding?.originRouteId) throw new Error("implementation binding is missing");
    const carrierRef = "evidence:implementation-before-conflict" as EvidenceRef;
    await putLaneEvidence(fixture, {
      evidenceRef: carrierRef,
      runRef: topology.lanes.implementation.runRef,
      taskRef: topology.lanes.implementation.taskRef,
      body: implementationResult(topology, {
        originRouteId: binding.originRouteId,
        bindingRevision: binding.bindingRevision,
      }),
    });
    await finishRun(fixture, topology.lanes.implementation.runRef, [carrierRef]);

    const reconciled = await reconcileSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: topology.repro,
      deps: {
        ...runtimeReconcileDeps(fixture),
        prepareRouteRevision: async ({ route }) => {
          if (route.action === "materialize_binding") {
            throw new GitLifecycleError(
              "materialization_conflict",
              "simulated cherry-pick conflict after clean rollback",
            );
          }
        },
      },
    });

    const failed = reconciled.threeLane.routes.find(
      (route) => route.action === "materialize_binding",
    );
    const repair = reconciled.threeLane.routes.find(
      (route) => route.action === "resume_binding" && route.cause.kind === "repair",
    );
    expect(failed?.status).toBe("acknowledged");
    expect(repair).toMatchObject({
      fromLane: "implementation",
      toLane: "implementation",
      status: "acknowledged",
      cause: { kind: "repair", id: failed?.routeId },
    });
    const repairedBinding = reconciled.threeLane.bindings.find(
      (candidate) => candidate.lane === "implementation",
    );
    expect(repairedBinding).toMatchObject({
      bindingRevision: 2,
      originRouteId: repair?.routeId,
      taskRef: topology.lanes.implementation.taskRef,
    });
    expect(fixture.invocations).toHaveLength(2);
    expect(fixture.invocations[1]?.sessionId).toBe(topology.lanes.implementation.sessionId);
    expect(fixture.invocations[1]?.prompt).toContain("repairEvidenceRef=evidence:");
    expect(fixture.invocations[1]?.prompt).toContain(`failedRouteId=${failed?.routeId}`);
    if (!repair?.cause.evidenceRef) throw new Error("repair Evidence is missing");
    const evidence = await defaultEvidenceStore(fixture.stateCwd).get(repair.cause.evidenceRef);
    expect(evidence).toMatchObject({
      format: "json",
      provenance: {
        producer: "spark",
        taskRef: topology.lanes.implementation.taskRef,
      },
      body: {
        schema: "spark.repro.git-repair/v1",
        failedRouteId: failed?.routeId,
        repairLane: "implementation",
        error: { code: "materialization_conflict" },
      },
    });
    expect(evidence.links).toContainEqual({
      from: evidence.ref,
      to: topology.lanes.implementation.taskRef,
      relation: "input",
    });
  });

  it("recovers a crash after Formalize Draft submission from the GitChange checkpoint", async () => {
    const fixture = await runtimeFixture();
    const topology = await launchFixture(fixture);
    const artifactRef = topology.lanes.formalize.artifactRef;
    await defaultArtifactStore(fixture.stateCwd).put({
      ref: artifactRef,
      kind: "git_change",
      title: "GLM-5.2 Formalize",
      format: "json",
      body: {
        schemaVersion: 2,
        kind: "git_change",
        repository: { forge: "github", repo: "acme/glm52" },
        trunk: "main",
        worktree: {
          path: join(fixture.cwd, "formalize"),
          branch: "spark/repro-glm52-formalize",
          ownership: "spark",
          status: "attached",
        },
        stack: {
          authority: "gh-stack",
          currentBranch: "spark/repro-glm52-formalize",
          entries: [
            {
              branch: "spark/repro-glm52-formalize",
              base: SOURCE_REVISION,
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
          ],
        },
        lifecycle: "local",
      },
    });
    const repro = {
      ...topology.repro,
      threeLane: {
        ...topology.repro.threeLane,
        formalize: {
          ...topology.repro.threeLane.formalize,
          formalizedTip: "3333333333333333333333333333333333333333",
        },
      },
    };
    let submitCalls = 0;
    const submitFormalizeDraft = async () => {
      submitCalls += 1;
      const store = defaultArtifactStore(fixture.stateCwd);
      const artifact = await store.get(artifactRef);
      if (artifact.kind !== "git_change" || artifact.body.kind !== "git_change") {
        throw new Error("Formalize artifact is invalid");
      }
      await store.update(artifactRef, {
        body: {
          ...artifact.body,
          lifecycle: "published",
          stack: {
            ...artifact.body.stack,
            entries: artifact.body.stack.entries.map((entry) => ({
              ...entry,
              pullRequest: {
                forge: "github",
                repo: "acme/glm52",
                number: 1,
                url: "https://example.test/acme/glm52/pull/1",
                state: "OPEN",
                title: "GLM-5.2 Formalize",
                headRef: entry.branch,
                baseRef: "main",
                draft: true,
              },
            })),
          },
        },
      });
      throw new Error("simulated crash after Draft submission");
    };

    await expect(
      reconcileSparkReproThreeLaneRuntime({
        cwd: fixture.cwd,
        ctx: fixture.ctx,
        ownerSessionId: "sess_root",
        repro,
        deps: { ...runtimeReconcileDeps(fixture), submitFormalizeDraft },
      }),
    ).rejects.toThrow("simulated crash after Draft submission");
    await expect(
      reconcileSparkReproThreeLaneRuntime({
        cwd: fixture.cwd,
        ctx: fixture.ctx,
        ownerSessionId: "sess_root",
        repro,
        deps: { ...runtimeReconcileDeps(fixture), submitFormalizeDraft },
      }),
    ).resolves.toBe(repro);
    expect(submitCalls).toBe(1);
    expect((await defaultArtifactStore(fixture.stateCwd).get(artifactRef)).body).toMatchObject({
      lifecycle: "published",
      stack: { entries: [{ pullRequest: { draft: true } }] },
    });
  });

  it("completes five ordered runs while reusing the three original lane Sessions", async () => {
    const fixture = await runtimeFixture();
    const topology = await launchFixture(fixture);
    let repro = topology.repro;
    let draftSubmissions = 0;
    const deps = {
      ...runtimeReconcileDeps(fixture),
      submitFormalizeDraft: async () => {
        draftSubmissions += 1;
        await markArtifactDraft(fixture, topology.lanes.formalize.artifactRef);
      },
    };

    repro = await recordAndReconcileLaneResult(fixture, topology, repro, "implementation", {
      kind: "implementation_candidate",
      scope: "glm52",
      candidateRevisions: [CANDIDATE_REVISION],
      dependsOnHandoffIds: [],
      doneWhen: ["Exactness validates the candidate"],
    });
    const implementationHandoffId = repro.threeLane.handoffs[0]?.handoffId;
    if (!implementationHandoffId) throw new Error("Implementation handoff is missing");

    repro = await recordAndReconcileLaneResult(fixture, topology, repro, "exactness", {
      kind: "exactness_finding",
      finding: {
        findingId: "finding:glm52-first-boundary",
        firstBadBoundary: "layers.0.attention.output",
        classification: "implementation_defect",
        disposition: "fix",
        confidence: "confirmed",
      },
      scope: "glm52 exactness",
      candidateRevisions: [CANDIDATE_REVISION],
      dependsOnHandoffIds: [implementationHandoffId],
      doneWhen: ["Formalize lands the verified correction"],
    });

    repro = await recordAndReconcileLaneResult(
      fixture,
      topology,
      repro,
      "formalize",
      {
        kind: "formalized",
        canonicalRevision: CANONICAL_REVISION,
        supersededRevisions: [CANDIDATE_REVISION],
      },
      deps,
    );
    expect(draftSubmissions).toBe(1);

    repro = await recordAndReconcileLaneResult(
      fixture,
      topology,
      repro,
      "exactness",
      {
        kind: "refresh",
        canonicalRevision: CANONICAL_REVISION,
        supersededRevisions: [CANDIDATE_REVISION],
        outcome: "refreshed",
      },
      deps,
    );
    repro = await recordAndReconcileLaneResult(
      fixture,
      topology,
      repro,
      "implementation",
      {
        kind: "refresh",
        canonicalRevision: CANONICAL_REVISION,
        supersededRevisions: [CANDIDATE_REVISION],
        outcome: "refreshed",
      },
      deps,
    );

    const graph = await defaultTaskGraphStore(fixture.stateCwd).load();
    const runs = graph?.runs(fixture.projectRef) ?? [];
    expect(runs).toHaveLength(5);
    expect(fixture.invocations).toHaveLength(5);
    expect(fixture.sessions).toHaveLength(3);
    for (const lane of ["implementation", "exactness", "formalize"] as const) {
      const laneRuns = runs.filter((run) => run.taskRef === topology.lanes[lane].taskRef);
      expect(
        new Set(
          laneRuns.map((run) => run.execution?.sessionId ?? run.execution?.executionSessionId),
        ).size,
      ).toBe(1);
    }
    expect(repro.threeLane.routes.map((route) => route.action)).toEqual([
      "start_binding",
      "materialize_binding",
      "materialize_binding",
      "refresh_binding",
      "refresh_binding",
    ]);
    expect(repro.threeLane.routes.every((route) => route.status === "acknowledged")).toBe(true);
    expect(repro.threeLane.formalize.formalizedTip).toBe(CANONICAL_REVISION);
    expect(repro.threeLane.resolutions).toHaveLength(2);
    expect(repro.threeLane.resolutions[1]?.parentResolutionId).toBe(
      repro.threeLane.resolutions[0]?.resolutionId,
    );
    expect(repro.threeLane.workItems[0]).toMatchObject({
      status: "completed",
      sourceRevision: CANONICAL_REVISION,
    });
  });

  it("resumes the original lane Session after attention, restart, and a canonical answer", async () => {
    const fixture = await runtimeFixture();
    const topology = await launchFixture(fixture);
    let repro = await recordAndReconcileLaneResult(
      fixture,
      topology,
      topology.repro,
      "implementation",
      {
        kind: "attention_request",
        decisionKey: "glm52-reference",
        question: "Which GLM-5.2 reference should be authoritative?",
        reason: "Two runnable references disagree on the attention contract.",
        expectedAnswerKind: "freeform",
      },
    );
    expect(fixture.interactions).toHaveLength(1);
    const request = fixture.interactions[0];
    if (request?.kind !== "askFlow" || !request.evidenceRequest) {
      throw new Error("Root attention request is missing its Evidence binding");
    }
    const answerEvent = sparkEvidenceAnswerEventSchema.parse({
      schema: "spark.evidence-answer-event/v1",
      answerEventId: "answer-event:glm52-reference",
      humanRequestId: `hreq_${request.requestId}`,
      interactionRequestId: request.requestId,
      humanResponseId: "hres_glm52_reference",
      provenance: "direct_user",
      binding: request.evidenceRequest,
      answers: {
        "glm52-reference": {
          questionId: "glm52-reference",
          values: ["Use the official upstream implementation."],
        },
      },
      acceptedAt: "2026-08-18T00:02:00.000Z",
    });
    const answerEvidence = await defaultEvidenceStore(fixture.stateCwd).put({
      ref: `evidence:${answerEvent.answerEventId}` as EvidenceRef,
      kind: "record",
      title: "GLM-5.2 reference answer",
      format: "json",
      body: answerEvent as unknown as JsonValue,
      provenance: { producer: "ask" },
      links: [{ to: answerEvent.binding.askRef as AskRef, relation: "answer-to" }],
    });
    await recordCanonicalAnswerEventEvidenceReceipt(fixture.stateCwd, answerEvidence, answerEvent);

    repro = await reconcileSparkReproThreeLaneRuntime({
      cwd: fixture.cwd,
      ctx: fixture.ctx,
      ownerSessionId: "sess_root",
      repro: structuredClone(repro),
      deps: runtimeReconcileDeps(fixture),
    });
    const implementationRuns = (await defaultTaskGraphStore(fixture.stateCwd).load())
      ?.runs(fixture.projectRef)
      .filter((run) => run.taskRef === topology.lanes.implementation.taskRef);
    expect(implementationRuns).toHaveLength(2);
    expect(
      new Set(
        implementationRuns?.map(
          (run) => run.execution?.sessionId ?? run.execution?.executionSessionId,
        ),
      ).size,
    ).toBe(1);
    expect(fixture.sessions).toHaveLength(3);
    expect(fixture.interactions).toHaveLength(1);
    expect(repro.threeLane.routes.map((route) => route.action)).toEqual([
      "start_binding",
      "root_attention",
      "resume_binding",
    ]);
    expect(repro.threeLane.routes.every((route) => route.status === "acknowledged")).toBe(true);
    expect(fixture.invocations.at(-1)?.prompt).toContain("lane=implementation");
    expect(fixture.invocations.at(-1)?.prompt).toContain("originRouteId=route:");
    const implementationBinding = sparkReproLaneBinding(
      repro.threeLane,
      topology.workItemId,
      "implementation",
    );
    expect(fixture.invocations.at(-1)?.prompt).toContain(
      `gitChangeRef=${implementationBinding?.gitChangeRef}`,
    );
  });
});

async function launchFixture(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
): Promise<SparkReproLaneRuntimeTopology> {
  return await launchSparkReproThreeLaneRuntime({
    cwd: fixture.cwd,
    ctx: fixture.ctx,
    ownerSessionId: "sess_root",
    repro: fixture.repro,
    deps: {
      resolveSourceRevision: async () => SOURCE_REVISION,
      repositoryIdentity: async () => "acme/glm52",
      ensureInitialArtifacts: fixture.ensureInitialArtifacts,
      reserve: fixture.reserve,
      dispatch: fixture.dispatch,
      persist: async () => {},
    },
  });
}

function runtimeReconcileDeps(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
  return {
    repositoryIdentity: async () => "acme/glm52",
    dispatch: fixture.dispatch,
    prepareRouteRevision: async () => {},
    persist: async () => {},
  };
}

function implementationResult(
  topology: SparkReproLaneRuntimeTopology,
  overrides: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return {
    schema: "spark.repro.lane-result/v1",
    kind: "implementation_candidate",
    reproId: topology.repro.reproId,
    workItemId: topology.workItemId,
    lane: "implementation",
    planRevision: topology.repro.plan.currentRevision,
    bindingRevision: 1,
    taskRef: topology.lanes.implementation.taskRef,
    runRef: topology.lanes.implementation.runRef,
    sourceRevision: topology.sourceRevision,
    evidenceRefs: [],
    originRouteId: topology.repro.threeLane.routes[0]!.routeId,
    scope: "glm52",
    candidateRevisions: [CANDIDATE_REVISION],
    dependsOnHandoffIds: [],
    doneWhen: ["Exactness validates the candidate"],
    ...overrides,
  };
}

async function recordAndReconcileLaneResult(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  topology: SparkReproLaneRuntimeTopology,
  repro: SparkSessionRepro,
  lane: "implementation" | "exactness" | "formalize",
  payload: Record<string, JsonValue>,
  deps = runtimeReconcileDeps(fixture),
): Promise<SparkSessionRepro> {
  const binding = repro.threeLane.bindings.find(
    (candidate) => candidate.workItemId === topology.workItemId && candidate.lane === lane,
  );
  if (!binding?.originRouteId) throw new Error(`${lane} binding is missing`);
  const graph = await defaultTaskGraphStore(fixture.stateCwd).load();
  const run = graph
    ?.runs(fixture.projectRef)
    .filter((candidate) => candidate.taskRef === binding.taskRef)
    .at(-1);
  if (!run) throw new Error(`${lane} TaskRun is missing`);
  const evidenceRef = `evidence:${lane}-${binding.bindingRevision}` as EvidenceRef;
  await putLaneEvidence(fixture, {
    evidenceRef,
    runRef: run.ref,
    taskRef: binding.taskRef,
    body: {
      schema: "spark.repro.lane-result/v1",
      reproId: repro.reproId,
      workItemId: topology.workItemId,
      lane,
      planRevision: repro.plan.currentRevision,
      bindingRevision: binding.bindingRevision,
      taskRef: binding.taskRef,
      runRef: run.ref,
      sourceRevision: binding.sourceRevision,
      evidenceRefs: [],
      originRouteId: binding.originRouteId,
      ...payload,
    },
  });
  await finishRun(fixture, run.ref, [evidenceRef]);
  return await reconcileSparkReproThreeLaneRuntime({
    cwd: fixture.cwd,
    ctx: fixture.ctx,
    ownerSessionId: "sess_root",
    repro,
    deps,
  });
}

async function markArtifactDraft(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  artifactRef: ArtifactRef,
): Promise<void> {
  const store = defaultArtifactStore(fixture.stateCwd);
  const artifact = await store.get(artifactRef);
  if (artifact.kind !== "git_change" || artifact.body.kind !== "git_change") {
    throw new Error(`${artifactRef} is not a GitChange`);
  }
  await store.update(artifactRef, {
    body: {
      ...artifact.body,
      lifecycle: "published",
      stack: {
        ...artifact.body.stack,
        entries: artifact.body.stack.entries.map((entry) => ({
          ...entry,
          pullRequest: {
            forge: "github",
            repo: "acme/glm52",
            number: 1,
            url: "https://example.test/acme/glm52/pull/1",
            state: "OPEN",
            title: "GLM-5.2 Formalize",
            headRef: entry.branch,
            baseRef: "main",
            draft: true,
          },
        })),
      },
    },
  });
}

async function putLaneEvidence(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  input: {
    evidenceRef: EvidenceRef;
    runRef: SparkReproLaneRuntimeTopology["lanes"]["implementation"]["runRef"];
    taskRef: SparkReproLaneRuntimeTopology["lanes"]["implementation"]["taskRef"];
    body: JsonValue;
  },
): Promise<void> {
  await defaultEvidenceStore(fixture.stateCwd).put({
    ref: input.evidenceRef,
    kind: "record",
    title: `Lane evidence ${input.evidenceRef}`,
    format: "json",
    body: input.body,
    provenance: {
      producer: "role",
      projectRef: fixture.projectRef,
      runRef: input.runRef,
      taskRef: input.taskRef,
    },
  });
}

async function finishRun(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  runRef: SparkReproLaneRuntimeTopology["lanes"]["implementation"]["runRef"],
  evidenceRefs: EvidenceRef[],
  executionPatch: { sessionId?: string } = {},
): Promise<void> {
  const graph = await defaultTaskGraphStore(fixture.stateCwd).load();
  if (!graph) throw new Error("TaskGraph is missing");
  const run = graph.runs(fixture.projectRef).find((candidate) => candidate.ref === runRef);
  if (!run) throw new Error(`TaskRun ${runRef} is missing`);
  graph.recordRun({
    ...run,
    status: "succeeded",
    finishedAt: "2026-08-18T00:01:00.000Z",
    outputEvidenceRefs: [...evidenceRefs],
    execution: run.execution ? { ...run.execution, ...executionPatch } : undefined,
  });
  graph.updateTask(run.taskRef, { status: "done", claim: undefined });
  await defaultTaskGraphStore(fixture.stateCwd).save(graph);
}

async function runtimeFixture() {
  registerSparkReproRoles();
  const cwd = await mkdtemp(join(tmpdir(), "spark-repro-lane-runtime-"));
  roots.push(cwd);
  const interactions: ExtensionInteractionRequest[] = [];
  const ctx: SparkSessionContext & { ui: ExtensionUi } = {
    sessionId: "sess_root",
    ui: {
      interaction: async (
        request: ExtensionInteractionRequest,
      ): Promise<ExtensionInteractionResponse> => {
        interactions.push(structuredClone(request));
        if (request.kind !== "askFlow") throw new Error("expected askFlow interaction");
        return {
          kind: "askFlow",
          requestId: request.requestId,
          status: "pending",
          humanRequestId: `hreq_${request.requestId}`,
          answers: {},
        };
      },
    },
  };
  const stateCwd = sparkStateCwd(cwd, ctx);
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "GLM-5.2", description: "Reproduce GLM-5.2" });
  await defaultTaskGraphStore(stateCwd).save(graph);
  const repro: SparkSessionRepro = {
    ...createSparkSessionRepro("session:sess_root", undefined, {
      objective: "Reproduce GLM-5.2",
      reproId: "glm52",
    }),
    projectRef: project.ref,
  };
  const sessionInputs = new Map<string, Record<string, unknown>>();
  const invocations: Array<{ sessionId: string; prompt: string }> = [];
  const daemonRequest = (async (method: string, value: Record<string, unknown>) => {
    if (method === "session.get") {
      const sessionId = String(value.sessionId);
      if (sessionId === "sess_root") {
        return { scope: { kind: "workspace", workspaceId: "ws_glm52" }, cwd };
      }
      const stored = sessionInputs.get(sessionId);
      if (!stored) throw new Error(`unknown Session ${sessionId}`);
      const execution = stored.taskExecution as Record<string, unknown>;
      const { ownerKind, ...owner } = execution;
      return {
        lifecycle: "open",
        placement: "active",
        scope: stored.scope,
        owner: { kind: ownerKind, ...owner },
        roleBinding: stored.roleBinding,
        cwd: stored.cwd,
        cwdArtifactRef: stored.cwdArtifactRef,
      };
    }
    if (method === "session.create") {
      const sessionId = String(value.sessionId);
      if (sessionInputs.has(sessionId)) {
        throw new SparkDaemonRemoteError("Session exists", { code: "session_exists" });
      }
      sessionInputs.set(sessionId, structuredClone(value));
      return { sessionId };
    }
    if (method === "turn.submit") {
      invocations.push({ sessionId: String(value.sessionId), prompt: String(value.prompt) });
      return {
        invocationId: `invocation-${invocations.length}`,
        status: "queued",
        acceptedAt: "2026-08-18T00:00:00.000Z",
      };
    }
    if (method === "session.close") return { closed: true };
    throw new Error(`unexpected daemon method ${method}`);
  }) as typeof requestSparkDaemon;
  const reserve: typeof reserveManagedTaskSessions = (input) =>
    reserveManagedTaskSessions({ ...input, daemonRequest });
  const dispatch: typeof dispatchManagedTaskSessions = (input) =>
    dispatchManagedTaskSessions({ ...input, daemonRequest });
  const artifactRefs = {
    implementation: "artifact:glm52-implementation" as ArtifactRef,
    exactness: "artifact:glm52-exactness" as ArtifactRef,
    formalize: "artifact:glm52-formalize" as ArtifactRef,
  };
  const ensureInitialArtifacts = async () => {
    const store = defaultArtifactStore(stateCwd);
    for (const lane of ["implementation", "exactness", "formalize"] as const) {
      const worktreePath = join(cwd, lane);
      await mkdir(worktreePath, { recursive: true });
      await store.put({
        ref: artifactRefs[lane],
        kind: "git_change",
        title: `GLM-5.2 ${lane}`,
        format: "json",
        body: {
          schemaVersion: 2,
          kind: "git_change",
          repository: { forge: "github", repo: "acme/glm52" },
          trunk: "main",
          worktree: {
            path: worktreePath,
            branch: `spark/repro-glm52-${lane}`,
            ownership: "spark",
            status: "attached",
          },
          stack: {
            authority: "gh-stack",
            currentBranch: `spark/repro-glm52-${lane}`,
            entries: [
              {
                branch: `spark/repro-glm52-${lane}`,
                base: SOURCE_REVISION,
                isCurrent: true,
                isMerged: false,
                isQueued: false,
                needsRebase: false,
              },
            ],
          },
          lifecycle: "local",
        },
      });
    }
    return artifactRefs;
  };
  return {
    cwd,
    ctx,
    stateCwd,
    repro,
    projectRef: project.ref,
    invocations,
    interactions,
    get sessions() {
      return [...sessionInputs.keys()];
    },
    get sessionTargets() {
      return [...sessionInputs.values()].map((input) => input.cwdArtifactRef);
    },
    artifactRefs,
    ensureInitialArtifacts,
    reserve,
    dispatch,
  };
}
