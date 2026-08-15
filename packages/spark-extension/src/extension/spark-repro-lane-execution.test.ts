import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactRef, EvidenceRef, ProjectRef, RunRef, TaskRef } from "@zendev-lab/spark-core";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import {
  bindSparkReproFormalizeOwnership,
  createSparkSessionRepro,
  parseSparkReproLaneResult,
  reconcileSparkReproLaneResult,
  registerSparkReproWorkItem,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

import {
  acknowledgeMaterializedSparkReproRoutes,
  assertSparkReproDriverGitAuthorization,
  materializeSparkReproRoutes,
  reconcileSparkReproLaneTopology,
  requestSparkReproRootAttention,
} from "./spark-repro-lane-execution.ts";

const roots: string[] = [];
const evidence = (id: string) => `evidence:${id}` as EvidenceRef;
const task = (id: string) => `task:${id}` as TaskRef;
const run = (id: string) => `run:${id}` as RunRef;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("Repro lane execution adapter", () => {
  it("reuses Artifact and Task owner state across route materialization retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-repro-lane-route-"));
    roots.push(root);
    const graphResult = await defaultTaskGraphStore(root).update(
      (graph) => graph.createProject({ title: "Repro", description: "Route test" }),
      { createIfMissing: true },
    );
    const project = graphResult.result;
    let repro = { ...createSparkSessionRepro("session:route"), projectRef: project.ref };
    repro = {
      ...repro,
      threeLane: registerSparkReproWorkItem(repro.threeLane, "implementation", {
        workItemId: "work:concern",
        title: "Align concern",
        scope: "component.boundary",
        planRevision: repro.plan.currentRevision,
        sourceRevision: "commit:candidate",
        status: "open",
        taskRef: task("implementation"),
        evidenceRefs: [],
        unresolvedIds: [],
      }),
    };
    const result = parseSparkReproLaneResult({
      schema: "spark.repro.lane-result/v1",
      kind: "implementation_candidate",
      reproId: repro.reproId,
      workItemId: "work:concern",
      lane: "implementation",
      planRevision: repro.plan.currentRevision,
      bindingRevision: 1,
      taskRef: task("implementation"),
      runRef: run("implementation"),
      sourceRevision: "commit:candidate",
      evidenceRefs: [],
      scope: "component.boundary",
      candidateRevisions: ["commit:candidate"],
      dependsOnHandoffIds: [],
      doneWhen: ["Classify the boundary"],
    });
    repro = {
      ...repro,
      threeLane: reconcileSparkReproLaneResult({
        state: repro.threeLane,
        reproId: repro.reproId,
        evidenceRef: evidence("candidate"),
        result,
      }).state,
    };
    let gitCalls = 0;
    const ensureGitChange = async () => {
      gitCalls += 1;
      return "artifact:exactness-candidate" as ArtifactRef;
    };

    const first = await materializeSparkReproRoutes({
      workspaceCwd: root,
      repositoryCwd: root,
      repro,
      deps: { ensureGitChange },
    });
    const retry = await materializeSparkReproRoutes({
      workspaceCwd: root,
      repositoryCwd: root,
      repro: first.repro,
      deps: { ensureGitChange },
    });

    expect(gitCalls).toBe(1);
    expect(first.taskRefs).toEqual(retry.taskRefs);
    expect(first.repro.threeLane.bindings).toMatchObject([
      { lane: "implementation", taskRef: task("implementation") },
      {
        lane: "exactness",
        bindingRevision: 1,
        gitChangeRef: "artifact:exactness-candidate",
        evidenceRefs: [evidence("candidate")],
      },
    ]);
    const graph = await defaultTaskGraphStore(root).load();
    expect(graph?.tasks(project.ref)).toHaveLength(1);
    expect(first.repro.threeLane.routes[0]?.status).toBe("pending");
    const acknowledged = acknowledgeMaterializedSparkReproRoutes(
      retry.repro,
      retry.materializedRouteIds,
    );
    expect(acknowledged.threeLane.routes[0]?.status).toBe("acknowledged");
  });

  it("recovers result, route, reservation, and invocation boundaries without duplicate owners", async () => {
    const root = await workspace("restart-boundaries");
    const project = (
      await defaultTaskGraphStore(root).update(
        (graph) => graph.createProject({ title: "Repro", description: "Recovery" }),
        { createIfMissing: true },
      )
    ).result;
    let durable: SparkSessionRepro = {
      ...createSparkSessionRepro("session:restart"),
      projectRef: project.ref,
    };
    durable = {
      ...durable,
      threeLane: registerSparkReproWorkItem(durable.threeLane, "implementation", {
        workItemId: "work:concern",
        title: "Bounded concern",
        scope: "component.boundary",
        planRevision: durable.plan.currentRevision,
        sourceRevision: "commit:candidate",
        status: "open",
        taskRef: task("implementation"),
        evidenceRefs: [],
        unresolvedIds: [],
      }),
    };
    const result = parseSparkReproLaneResult({
      schema: "spark.repro.lane-result/v1",
      kind: "implementation_candidate",
      reproId: durable.reproId,
      workItemId: "work:concern",
      lane: "implementation",
      planRevision: durable.plan.currentRevision,
      bindingRevision: 1,
      taskRef: task("implementation"),
      runRef: run("implementation"),
      sourceRevision: "commit:candidate",
      evidenceRefs: [],
      scope: "component.boundary",
      candidateRevisions: ["commit:candidate"],
      dependsOnHandoffIds: [],
      doneWhen: ["Classified"],
    });
    const record = await putLaneResult(root, "candidate", result);
    let gitCreates = 0;
    const deps = {
      ensureGitChange: async () => {
        gitCreates += 1;
        return "artifact:exactness" as ArtifactRef;
      },
    };
    const persist = async (next: SparkSessionRepro) => {
      durable = next;
    };

    const routed = await reconcileSparkReproLaneTopology({
      workspaceCwd: root,
      repositoryCwd: root,
      repro: durable,
      evidenceRefs: [record.ref],
      persist,
      dispatch: async () => [],
      deps,
    });
    durable = routed.repro;
    expect(durable.threeLane.routes[0]?.status).toBe("pending");

    const reserved = new Set<TaskRef>();
    let sessionCreates = 0;
    await expect(
      reconcileSparkReproLaneTopology({
        workspaceCwd: root,
        repositoryCwd: root,
        repro: durable,
        evidenceRefs: [record.ref],
        persist,
        dispatch: async (taskRefs) => {
          for (const taskRef of taskRefs) {
            if (!reserved.has(taskRef)) {
              reserved.add(taskRef);
              sessionCreates += 1;
            }
          }
          throw new Error("crash after reserve before invoke");
        },
        deps,
      }),
    ).rejects.toThrow("crash after reserve before invoke");

    const recovered = await reconcileSparkReproLaneTopology({
      workspaceCwd: root,
      repositoryCwd: root,
      repro: durable,
      evidenceRefs: [record.ref],
      persist,
      dispatch: async (taskRefs) =>
        taskRefs.map((taskRef) => ({ taskRef, sessionId: `session:${taskRef}` })),
      deps,
    });
    durable = recovered.repro;
    const graph = await defaultTaskGraphStore(root).load();
    expect(gitCreates).toBe(1);
    expect(sessionCreates).toBe(1);
    expect(graph?.tasks(project.ref)).toHaveLength(1);
    expect(durable.threeLane.routes[0]?.status).toBe("acknowledged");
    expect(
      durable.threeLane.bindings.filter((binding) => binding.lane === "exactness"),
    ).toHaveLength(1);
  });

  it("submits a formalized WorkItem Draft before its refresh and retries idempotently", async () => {
    const root = await workspace("formal-refresh");
    const project = (
      await defaultTaskGraphStore(root).update(
        (graph) => graph.createProject({ title: "Repro", description: "Formal refresh" }),
        { createIfMissing: true },
      )
    ).result;
    let repro = formalizedRepro(project.ref);
    const formalBinding = repro.threeLane.bindings.find((binding) => binding.lane === "formalize")!;
    const formalRoute = repro.threeLane.routes.find((route) => route.toLane === "formalize")!;
    const formalized = parseSparkReproLaneResult({
      schema: "spark.repro.lane-result/v1",
      kind: "formalized",
      reproId: repro.reproId,
      workItemId: "work:concern",
      lane: "formalize",
      planRevision: repro.plan.currentRevision,
      bindingRevision: formalBinding.bindingRevision,
      taskRef: formalBinding.taskRef,
      runRef: run("formalize"),
      sourceRevision: formalBinding.sourceRevision,
      originRouteId: formalRoute.routeId,
      evidenceRefs: [],
      canonicalRevision: "commit:canonical",
      supersededRevisions: ["commit:candidate"],
    });
    const record = await putLaneResult(root, "formalized", formalized);
    let durable: SparkSessionRepro = repro;
    const published = new Set<string>();
    let draftWrites = 0;
    let taskAttempts = 0;
    const deps = {
      ensureFormalizeDraft: async ({ route }: { route: { workItemId: string } }) => {
        if (!published.has(route.workItemId)) {
          published.add(route.workItemId);
          draftWrites += 1;
        }
      },
      ensureGitChange: async () => "artifact:exactness" as ArtifactRef,
      ensureTask: async () => {
        taskAttempts += 1;
        if (taskAttempts === 1) throw new Error("crash before refresh Task persistence");
        return task("exactness-refresh");
      },
    };
    const persist = async (next: SparkSessionRepro) => {
      durable = next;
    };

    await expect(
      reconcileSparkReproLaneTopology({
        workspaceCwd: root,
        repositoryCwd: root,
        repro,
        evidenceRefs: [record.ref],
        persist,
        dispatch: async () => [],
        deps,
      }),
    ).rejects.toThrow("crash before refresh Task persistence");
    expect(durable.threeLane.resolutions).toHaveLength(1);
    expect(durable.threeLane.routes.some((route) => route.action === "refresh_binding")).toBe(true);

    const recovered = await reconcileSparkReproLaneTopology({
      workspaceCwd: root,
      repositoryCwd: root,
      repro: durable,
      evidenceRefs: [record.ref],
      persist,
      dispatch: async (taskRefs) =>
        taskRefs.map((taskRef) => ({ taskRef, sessionId: "session:exactness" })),
      deps,
    });
    expect(draftWrites).toBe(1);
    expect(recovered.repro.threeLane.resolutions).toHaveLength(1);
    expect(
      recovered.repro.threeLane.bindings.find((binding) => binding.lane === "exactness"),
    ).toMatchObject({
      bindingRevision: 2,
      taskRef: "task:exactness-refresh",
      gitChangeRef: "artifact:exactness",
      status: "active",
    });
  });

  it("dispatches at most one canonical writer while leaving later Formalize routes pending", async () => {
    const root = await workspace("formal-writer");
    const project = (
      await defaultTaskGraphStore(root).update(
        (graph) => graph.createProject({ title: "Repro", description: "One writer" }),
        { createIfMissing: true },
      )
    ).result;
    let repro: SparkSessionRepro = {
      ...createSparkSessionRepro("session:one-writer"),
      projectRef: project.ref,
    };
    for (const id of ["one", "two"]) {
      repro = addExactnessFindingRoute(repro, id);
    }
    let dispatched: TaskRef[] = [];
    const result = await reconcileSparkReproLaneTopology({
      workspaceCwd: root,
      repositoryCwd: root,
      repro,
      evidenceRefs: [],
      persist: async () => undefined,
      dispatch: async (taskRefs) => {
        dispatched = taskRefs;
        return taskRefs.map((taskRef) => ({ taskRef, sessionId: "session:integrator" }));
      },
      deps: {
        ensureGitChange: async () => "artifact:canonical" as ArtifactRef,
        ensureTask: async ({ route }) => task(`formalize-${route.workItemId}`),
      },
    });

    expect(result.materializedRouteIds).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect(
      result.repro.threeLane.routes.filter((route) => route.status === "acknowledged"),
    ).toHaveLength(1);
    expect(
      result.repro.threeLane.routes.filter((route) => route.status === "pending"),
    ).toHaveLength(1);
    expect(result.repro.threeLane.formalize.ownership).toMatchObject({
      gitChangeRef: "artifact:canonical",
      integratorSessionId: "session:integrator",
      generation: 1,
    });
  });

  it("recovers a dispatched Formalize route and its integrator after a Repro persist crash", async () => {
    const root = await workspace("formal-dispatch-recovery");
    const project = (
      await defaultTaskGraphStore(root).update(
        (graph) => graph.createProject({ title: "Repro", description: "Dispatch recovery" }),
        { createIfMissing: true },
      )
    ).result;
    const routed = addExactnessFindingRoute(
      { ...createSparkSessionRepro("session:dispatch-recovery"), projectRef: project.ref },
      "one",
    );
    const materialized = await materializeSparkReproRoutes({
      workspaceCwd: root,
      repositoryCwd: root,
      repro: routed,
      deps: { ensureGitChange: async () => "artifact:canonical" as ArtifactRef },
    });
    const route = materialized.repro.threeLane.routes[0]!;
    const binding = materialized.repro.threeLane.bindings.find(
      (candidate) => candidate.workItemId === "work:one" && candidate.lane === "formalize",
    );
    if (!binding) throw new Error("missing Formalize binding");
    await defaultTaskGraphStore(root).update(
      (graph) =>
        graph.recordRun({
          ref: run("formalize-dispatched"),
          projectRef: project.ref,
          taskRef: binding.taskRef,
          roleRef: "role:extension-repro-precision-fixer" as never,
          ownerSessionId: "session:dispatch-recovery",
          execution: {
            ownerSessionId: "session:dispatch-recovery",
            sessionId: "session:integrator",
            executionSessionId: "session:integrator",
            sessionGoalId: "goal:formalize",
            sessionLifetime: "task_revision",
            jobId: "job:formalize",
            attempt: 1,
            invocationId: "invocation:accepted",
          },
          status: "running",
          startedAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
          outputEvidenceRefs: [],
        }),
      { createIfMissing: false },
    );
    let durable = materialized.repro;
    const recovered = await reconcileSparkReproLaneTopology({
      workspaceCwd: root,
      repositoryCwd: root,
      repro: materialized.repro,
      evidenceRefs: [],
      persist: async (next) => {
        durable = next;
      },
      dispatch: async (taskRefs) => {
        expect(taskRefs).toEqual([]);
        return [];
      },
    });

    expect(route.status).toBe("pending");
    expect(recovered.repro.threeLane.routes[0]?.status).toBe("acknowledged");
    expect(recovered.repro.threeLane.formalize.ownership).toEqual({
      gitChangeRef: "artifact:canonical",
      integratorSessionId: "session:integrator",
      generation: 1,
    });
    expect(durable).toEqual(recovered.repro);
  });

  it("turns an attention result into one stable daemon async Ask", async () => {
    let repro = { ...createSparkSessionRepro("session:attention") };
    repro = {
      ...repro,
      threeLane: registerSparkReproWorkItem(repro.threeLane, "implementation", {
        workItemId: "work:attention",
        title: "Need a user decision",
        scope: "decision.boundary",
        planRevision: repro.plan.currentRevision,
        sourceRevision: "commit:candidate",
        status: "open",
        taskRef: task("attention"),
        evidenceRefs: [],
        unresolvedIds: [],
      }),
    };
    const reconciled = reconcileSparkReproLaneResult({
      state: repro.threeLane,
      reproId: repro.reproId,
      evidenceRef: evidence("attention"),
      result: parseSparkReproLaneResult({
        schema: "spark.repro.lane-result/v1",
        kind: "attention_request",
        reproId: repro.reproId,
        workItemId: "work:attention",
        lane: "implementation",
        planRevision: repro.plan.currentRevision,
        bindingRevision: 1,
        taskRef: task("attention"),
        runRef: run("attention"),
        sourceRevision: "commit:candidate",
        evidenceRefs: [],
        decisionKey: "decision:contract-choice",
        question: "Which accepted contract should govern this concern?",
        reason: "Both choices change the frozen acceptance contract.",
        expectedAnswerKind: "single",
      }),
    });
    const route = reconciled.pendingRoutes[0]!;
    const opened = new Set<string>();
    let durableCreates = 0;
    const interaction = async (request: { toolCallId?: string; kind: string }) => {
      if (!request.toolCallId) throw new Error("missing stable toolCallId");
      if (!opened.has(request.toolCallId)) {
        opened.add(request.toolCallId);
        durableCreates += 1;
      }
      return {
        version: 3 as const,
        kind: "askFlow" as const,
        requestId: "request",
        humanRequestId: "human:request",
        status: "pending" as const,
        answers: {},
        nextAction: "resume" as const,
      };
    };

    await expect(requestSparkReproRootAttention({ route, interaction })).resolves.toBe(true);
    await expect(requestSparkReproRootAttention({ route, interaction })).resolves.toBe(true);
    expect(durableCreates).toBe(1);
  });

  it("keeps driver-local Git authority narrower than user-gated lifecycle actions", () => {
    const repro = addExactnessFindingRoute(createSparkSessionRepro("session:authorization"), "one");
    const route = repro.threeLane.routes[0]!;
    expect(() =>
      assertSparkReproDriverGitAuthorization({
        repro,
        route,
        operation: "canonical_create",
      }),
    ).not.toThrow();
    for (const operation of [
      "force_push",
      "ready",
      "merge",
      "close",
      "change_base",
      "sync",
      "cleanup",
    ]) {
      expect(() => assertSparkReproDriverGitAuthorization({ repro, route, operation })).toThrow(
        "not authorized",
      );
    }
    expect(() =>
      assertSparkReproDriverGitAuthorization({
        repro,
        route: { ...route, toLane: "exactness" },
        operation: "candidate_create",
      }),
    ).toThrow("no current pending route authority");
  });
});

async function workspace(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `spark-repro-${name}-`));
  roots.push(root);
  return root;
}

async function putLaneResult(root: string, title: string, body: unknown) {
  return await defaultEvidenceStore(root).put({
    kind: "record",
    title,
    format: "json",
    body: body as never,
    provenance: { producer: "spark" },
  });
}

function formalizedRepro(projectRef: ProjectRef): SparkSessionRepro {
  const repro: SparkSessionRepro = {
    ...createSparkSessionRepro("session:formalized"),
    projectRef,
  };
  const base = {
    workItemId: "work:concern",
    title: "Bounded concern",
    scope: "component.boundary",
    planRevision: repro.plan.currentRevision,
    sourceRevision: "commit:candidate",
    status: "open" as const,
    evidenceRefs: [] as EvidenceRef[],
    unresolvedIds: [] as string[],
  };
  let state = registerSparkReproWorkItem(repro.threeLane, "implementation", {
    ...base,
    taskRef: task("implementation"),
    gitChangeRef: "artifact:implementation" as ArtifactRef,
  });
  const implementation = reconcileSparkReproLaneResult({
    state,
    reproId: repro.reproId,
    evidenceRef: evidence("implementation"),
    result: parseSparkReproLaneResult({
      schema: "spark.repro.lane-result/v1",
      kind: "implementation_candidate",
      reproId: repro.reproId,
      workItemId: base.workItemId,
      lane: "implementation",
      planRevision: repro.plan.currentRevision,
      bindingRevision: 1,
      taskRef: task("implementation"),
      runRef: run("implementation"),
      sourceRevision: base.sourceRevision,
      evidenceRefs: [],
      scope: base.scope,
      candidateRevisions: [base.sourceRevision],
      dependsOnHandoffIds: [],
      doneWhen: ["Exactness classified"],
    }),
  });
  const implementationRoute = implementation.pendingRoutes[0]!;
  state = registerSparkReproWorkItem(implementation.state, "exactness", {
    ...base,
    taskRef: task("exactness"),
    gitChangeRef: "artifact:exactness" as ArtifactRef,
    evidenceRefs: [implementationRoute.evidenceRef],
  });
  const exactness = reconcileSparkReproLaneResult({
    state,
    reproId: repro.reproId,
    evidenceRef: evidence("exactness"),
    result: parseSparkReproLaneResult({
      schema: "spark.repro.lane-result/v1",
      kind: "exactness_finding",
      reproId: repro.reproId,
      workItemId: base.workItemId,
      lane: "exactness",
      planRevision: repro.plan.currentRevision,
      bindingRevision: 1,
      taskRef: task("exactness"),
      runRef: run("exactness"),
      sourceRevision: base.sourceRevision,
      originRouteId: implementationRoute.routeId,
      evidenceRefs: [],
      finding: {
        findingId: "finding:concern",
        firstBadBoundary: "component.boundary",
        classification: "implementation_defect",
        disposition: "fix",
        confidence: "confirmed",
      },
      scope: base.scope,
      candidateRevisions: [base.sourceRevision],
      dependsOnHandoffIds: [implementation.state.handoffs[0]!.handoffId],
      doneWhen: ["Canonical integration passes"],
    }),
  });
  const exactnessRoute = exactness.pendingRoutes.find((route) => route.toLane === "formalize")!;
  state = registerSparkReproWorkItem(exactness.state, "formalize", {
    ...base,
    taskRef: task("formalize"),
    gitChangeRef: "artifact:canonical" as ArtifactRef,
    evidenceRefs: [exactnessRoute.evidenceRef],
  });
  state = bindSparkReproFormalizeOwnership(state, {
    gitChangeRef: "artifact:canonical" as ArtifactRef,
    integratorSessionId: "session:integrator",
    generation: 1,
  });
  return { ...repro, threeLane: state };
}

function addExactnessFindingRoute(repro: SparkSessionRepro, id: string): SparkSessionRepro {
  const workItemId = `work:${id}`;
  const state = registerSparkReproWorkItem(repro.threeLane, "exactness", {
    workItemId,
    title: `Concern ${id}`,
    scope: `component.${id}`,
    planRevision: repro.plan.currentRevision,
    sourceRevision: `commit:${id}`,
    status: "open",
    taskRef: task(`exactness-${id}`),
    evidenceRefs: [],
    unresolvedIds: [],
  });
  const result = parseSparkReproLaneResult({
    schema: "spark.repro.lane-result/v1",
    kind: "exactness_finding",
    reproId: repro.reproId,
    workItemId,
    lane: "exactness",
    planRevision: repro.plan.currentRevision,
    bindingRevision: 1,
    taskRef: task(`exactness-${id}`),
    runRef: run(`exactness-${id}`),
    sourceRevision: `commit:${id}`,
    evidenceRefs: [],
    finding: {
      findingId: `finding:${id}`,
      firstBadBoundary: `component.${id}`,
      classification: "implementation_defect",
      disposition: "fix",
      confidence: "confirmed",
    },
    scope: `component.${id}`,
    candidateRevisions: [`commit:${id}`],
    dependsOnHandoffIds: [],
    doneWhen: ["Integrate"],
  });
  return {
    ...repro,
    threeLane: reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence(`finding-${id}`),
      result,
    }).state,
  };
}
