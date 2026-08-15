import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { defaultEvidenceStore, type ArtifactRef } from "@zendev-lab/spark-artifacts";
import type { EvidenceRef, RunRef, TaskRef } from "@zendev-lab/spark-core";
import { reconcileSparkReproLaneTopology } from "@zendev-lab/spark-extension/repro-lane-execution";
import {
  createSparkSessionRepro,
  parseSparkReproLaneResult,
  registerSparkReproWorkItem,
  type SparkReproLane,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

const roots: string[] = [];
const rootSessionId = "session:repro-root";
const workItemId = "work:bounded-concern";
const candidateRevision = "commit:candidate";
const canonicalRevision = "commit:canonical";
const implementationGitChange = "artifact:implementation-candidate" as ArtifactRef;
const exactnessGitChange = "artifact:exactness-candidate" as ArtifactRef;
const canonicalGitChange = "artifact:canonical" as ArtifactRef;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

test("one Root drives the complete managed three-lane route and refresh chain", async () => {
  const workspaceCwd = await mkdtemp(join(tmpdir(), "spark-repro-execution-journey-"));
  roots.push(workspaceCwd);
  const graphStore = defaultTaskGraphStore(workspaceCwd);
  const project = (
    await graphStore.update(
      (graph) => graph.createProject({ title: "Repro", description: "Three-lane journey" }),
      { createIfMissing: true },
    )
  ).result;
  const implementationTask = (
    await graphStore.update(
      (graph) =>
        graph.createTask({
          projectRef: project.ref,
          name: "implementation-initial",
          title: "Implementation: bounded concern",
          description: "Create the initial candidate and lane-result Evidence.",
          kind: "generic",
          status: "ready",
          roleRef: "role:extension-repro-implementation-explorer",
          artifactRefs: [implementationGitChange],
        }),
      { createIfMissing: false },
    )
  ).result;

  let durable: SparkSessionRepro = {
    ...createSparkSessionRepro(rootSessionId),
    projectRef: project.ref,
  };
  durable = {
    ...durable,
    threeLane: registerSparkReproWorkItem(durable.threeLane, "implementation", {
      workItemId,
      title: "Align one bounded concern",
      scope: "component.boundary",
      planRevision: durable.plan.currentRevision,
      sourceRevision: candidateRevision,
      status: "open",
      taskRef: implementationTask.ref,
      gitChangeRef: implementationGitChange,
      evidenceRefs: [],
      unresolvedIds: [],
    }),
  };

  const managedSessions = new Map<TaskRef, string>([
    [implementationTask.ref, "session:implementation-initial"],
  ]);
  let draftCreates = 0;
  const draftWorkItems = new Set<string>();
  const deps = {
    ensureGitChange: async ({ targetLane }: { targetLane: SparkReproLane }) =>
      targetLane === "formalize"
        ? canonicalGitChange
        : targetLane === "exactness"
          ? exactnessGitChange
          : implementationGitChange,
    ensureFormalizeDraft: async ({ route }: { route: { workItemId: string } }) => {
      if (!draftWorkItems.has(route.workItemId)) {
        draftWorkItems.add(route.workItemId);
        draftCreates += 1;
      }
    },
  };
  const persist = async (next: SparkSessionRepro) => {
    durable = next;
  };
  const dispatch = async (taskRefs: TaskRef[]) =>
    taskRefs.map((taskRef) => {
      const binding = durable.threeLane.bindings.find((candidate) => candidate.taskRef === taskRef);
      if (!binding) throw new Error(`dispatched Task has no lane binding: ${taskRef}`);
      const sessionId =
        managedSessions.get(taskRef) ??
        (binding.lane === "formalize"
          ? "session:canonical-integrator"
          : `session:${binding.lane}-${binding.bindingRevision}`);
      managedSessions.set(taskRef, sessionId);
      return { taskRef, sessionId };
    });

  const implementationRecord = await putLaneResult(workspaceCwd, {
    ...resultBase(durable, "implementation", implementationTask.ref, "run:implementation"),
    kind: "implementation_candidate",
    scope: "component.boundary",
    candidateRevisions: [candidateRevision],
    dependsOnHandoffIds: [],
    doneWhen: ["Localize the first unequal boundary"],
  });
  await reconcile([implementationRecord.ref]);

  const implementationHandoff = durable.threeLane.handoffs[0]!;
  const exactnessBinding = binding("exactness");
  const exactnessRecord = await putLaneResult(workspaceCwd, {
    ...resultBase(durable, "exactness", exactnessBinding.taskRef, "run:exactness"),
    kind: "exactness_finding",
    originRouteId: originRoute("exactness"),
    finding: {
      findingId: "finding:bounded-concern",
      firstBadBoundary: "component.boundary",
      classification: "implementation_defect",
      disposition: "fix",
      confidence: "confirmed",
    },
    scope: "component.boundary",
    candidateRevisions: [candidateRevision],
    dependsOnHandoffIds: [implementationHandoff.handoffId],
    doneWhen: ["Integrate the confirmed correction"],
  });
  await reconcile([exactnessRecord.ref]);

  const formalizeBinding = binding("formalize");
  const formalizedRecord = await putLaneResult(workspaceCwd, {
    ...resultBase(durable, "formalize", formalizeBinding.taskRef, "run:formalize"),
    kind: "formalized",
    originRouteId: originRoute("formalize"),
    canonicalRevision,
    supersededRevisions: [candidateRevision],
  });
  await reconcile([formalizedRecord.ref]);

  const exactnessRefreshBinding = binding("exactness");
  const exactnessRefreshRecord = await putLaneResult(workspaceCwd, {
    ...resultBase(durable, "exactness", exactnessRefreshBinding.taskRef, "run:exactness-refresh"),
    kind: "refresh",
    originRouteId: originRoute("exactness", "refresh_binding"),
    canonicalRevision,
    supersededRevisions: [candidateRevision],
    outcome: "rebased",
  });
  await reconcile([exactnessRefreshRecord.ref]);

  const implementationRefreshBinding = binding("implementation");
  const implementationRefreshRecord = await putLaneResult(workspaceCwd, {
    ...resultBase(
      durable,
      "implementation",
      implementationRefreshBinding.taskRef,
      "run:implementation-refresh",
    ),
    kind: "refresh",
    originRouteId: originRoute("implementation", "refresh_binding"),
    canonicalRevision,
    supersededRevisions: [candidateRevision],
    outcome: "refreshed",
  });
  await reconcile([implementationRefreshRecord.ref]);

  expect(durable.sessionKey).toBe(rootSessionId);
  expect(durable.threeLane.workItems).toMatchObject([
    { workItemId, status: "completed", sourceRevision: canonicalRevision },
  ]);
  expect(durable.threeLane.bindings).toHaveLength(3);
  expect(durable.threeLane.bindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        lane: "implementation",
        bindingRevision: 2,
        gitChangeRef: implementationGitChange,
        status: "converged",
      }),
      expect.objectContaining({
        lane: "exactness",
        bindingRevision: 2,
        gitChangeRef: exactnessGitChange,
        status: "converged",
      }),
      expect.objectContaining({
        lane: "formalize",
        bindingRevision: 1,
        gitChangeRef: canonicalGitChange,
        status: "converged",
      }),
    ]),
  );
  expect(durable.threeLane.formalize).toMatchObject({
    formalizedTip: canonicalRevision,
    ownership: {
      gitChangeRef: canonicalGitChange,
      integratorSessionId: "session:canonical-integrator",
      generation: 1,
    },
  });
  expect(durable.threeLane.handoffs).toHaveLength(2);
  expect(durable.threeLane.resolutions).toHaveLength(2);
  expect(durable.threeLane.routes.every((route) => route.status === "acknowledged")).toBe(true);
  expect(draftCreates).toBe(1);
  expect(new Set(managedSessions.values()).has(rootSessionId)).toBe(false);
  expect(
    [...managedSessions.values()].filter(
      (sessionId) => sessionId === "session:canonical-integrator",
    ),
  ).toHaveLength(1);
  expect((await graphStore.load())?.tasks(project.ref)).toHaveLength(5);

  function binding(lane: SparkReproLane) {
    const value = durable.threeLane.bindings.find((candidate) => candidate.lane === lane);
    if (!value) throw new Error(`missing ${lane} binding`);
    return value;
  }

  function originRoute(lane: SparkReproLane, action = "materialize_binding") {
    const value = durable.threeLane.routes.find(
      (route) =>
        route.toLane === lane && route.action === action && route.status === "acknowledged",
    );
    if (!value) throw new Error(`missing ${action} route for ${lane}`);
    return value.routeId;
  }

  async function reconcile(evidenceRefs: EvidenceRef[]) {
    const result = await reconcileSparkReproLaneTopology({
      workspaceCwd,
      repositoryCwd: workspaceCwd,
      repro: durable,
      evidenceRefs,
      persist,
      dispatch,
      deps,
    });
    durable = result.repro;
  }
});

function resultBase(
  repro: SparkSessionRepro,
  lane: SparkReproLane,
  taskRef: TaskRef,
  runRef: RunRef,
) {
  const binding = repro.threeLane.bindings.find(
    (candidate) => candidate.workItemId === workItemId && candidate.lane === lane,
  );
  if (!binding) throw new Error(`missing ${lane} binding`);
  return {
    schema: "spark.repro.lane-result/v1",
    reproId: repro.reproId,
    workItemId,
    lane,
    planRevision: repro.threeLane.planRevision,
    bindingRevision: binding.bindingRevision,
    taskRef,
    runRef,
    sourceRevision: binding.sourceRevision,
    evidenceRefs: [],
  };
}

async function putLaneResult(workspaceCwd: string, body: unknown) {
  return await defaultEvidenceStore(workspaceCwd).put({
    kind: "record",
    title: "Repro lane result",
    format: "json",
    body: parseSparkReproLaneResult(body) as never,
    provenance: { producer: "spark" },
  });
}
