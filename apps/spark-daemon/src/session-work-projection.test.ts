import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { EvidenceRef, RunRef } from "@zendev-lab/spark-core";
import {
  sessionGoalStorePathV2,
  sessionReproStorePathV2,
  writeSparkSessionWorkspaceState,
} from "@zendev-lab/spark-loop";
import {
  sparkLoopCountersSchema,
  sparkLoopPolicySchema,
  type SparkLoopView,
} from "@zendev-lab/spark-protocol";
import type {
  SparkTokenUsageAggregate,
  SparkTokenUsageByPersistence,
} from "@zendev-lab/spark-protocol/token-usage";
import {
  createSparkSessionRepro,
  recordSparkReproResolution,
  recordSparkReproWorkHandoff,
  registerSparkReproWorkItem,
  stepDefinitionDigest,
  updateReproStep,
  verifyReproStepPass,
} from "@zendev-lab/spark-repro";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import { afterEach, describe, expect, it } from "vitest";

import {
  projectSparkSessionWork,
  readSessionReproForDaemon,
  resolveActiveSessionReproUsageScope,
  selectPrimarySessionLoop,
  type SparkSessionWorkProjectionDiagnostic,
} from "./session-work-projection.ts";

const roots: string[] = [];
const sessionId = "sess-work";
const context = { sessionId };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session work projection", () => {
  it("selects the primary loop by semantic status and stable id", () => {
    const loops = [
      driver("z-repro", "repro", "blocked"),
      driver("a-goal", "goal", "running"),
      driver("b-repro", "repro", "running"),
      driver("a-repro", "repro", "running"),
    ];

    expect(selectPrimarySessionLoop(loops)?.loopId).toBe("a-goal");
  });

  it("resolves usage scope only from the Repro owned by the exact session", async () => {
    const cwd = await tempCwd();
    const repro = createSparkSessionRepro(`session:${sessionId}`, undefined, {
      objective: "Own root-session token usage",
    });
    await writeJson(sessionReproStorePathV2(cwd, context), { version: 9, repro });

    await expect(resolveActiveSessionReproUsageScope({ cwd, sessionId })).resolves.toEqual({
      kind: "repro",
      reproId: repro.reproId,
    });
    await expect(
      resolveActiveSessionReproUsageScope({ cwd, sessionId: "another-session" }),
    ).resolves.toBeUndefined();
  });

  it("joins durable Goal/Repro state into a bounded display projection", async () => {
    const cwd = await tempCwd();
    const timestamp = "2026-07-28T00:00:00.000Z";
    await writeJson(sessionGoalStorePathV2(cwd, context), {
      version: 1,
      goal: {
        version: 1,
        goalId: "goal-1",
        sessionKey: `session:${sessionId}`,
        originalObjective: "Reproduce target logits",
        objective: "Reproduce target logits",
        status: "active",
        source: "explicit",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });

    let repro = createSparkSessionRepro(`session:${sessionId}`, undefined, {
      objective: "Reproduce target logits",
    });
    const step = repro.plan.steps[0]!;
    const evidenceRefs = ["evidence:contract"] as EvidenceRef[];
    const verifier = verifyReproStepPass(repro, step.id, {
      verdict: "Pass",
      planRevision: repro.plan.currentRevision,
      definitionDigest: stepDefinitionDigest(step),
      proofKind: "evidence",
      evidenceRefs,
      verifiedDoneWhen: [...step.doneWhen],
    });
    repro = updateReproStep(repro, step.id, {
      status: "done",
      evidenceRefs,
      verifier,
    })!;
    await writeJson(sessionReproStorePathV2(cwd, context), {
      version: 5,
      repro: { ...repro, version: 5 },
    });

    const work = await projectSparkSessionWork({
      cwd,
      sessionId,
      loops: [driver("driver-repro", "repro", "running")],
    });

    expect(work).toMatchObject({
      primary: { loopId: "driver-repro" },
      goal: { goalId: "goal-1", status: "active" },
    });
    expect(work?.repro).toBeUndefined();
  });

  it("keeps the driver snapshot when durable state is corrupt", async () => {
    const cwd = await tempCwd();
    const diagnostics: SparkSessionWorkProjectionDiagnostic[] = [];
    const reproPath = sessionReproStorePathV2(cwd, context);
    await mkdir(dirname(reproPath), { recursive: true });
    await writeFile(reproPath, "{not-json", "utf8");

    const work = await projectSparkSessionWork({
      cwd,
      sessionId,
      loops: [driver("driver-repro", "repro", "blocked")],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(work).toEqual({ primary: { loopId: "driver-repro" } });
    expect(diagnostics).toEqual([
      {
        code: "repro_state_unavailable",
        domain: "repro",
        sessionId,
      },
    ]);
  });

  it("projects daemon-owned Repro token usage without reading transcript totals", async () => {
    const cwd = await tempCwd();
    const repro = createSparkSessionRepro(`session:${sessionId}`, undefined, {
      objective: "Account for this reproduction",
    });
    await writeJson(sessionReproStorePathV2(cwd, context), { version: 9, repro });
    const tokenUsage: SparkTokenUsageAggregate = {
      scope: { kind: "repro", reproId: repro.reproId },
      reported: breakdown(12),
      estimated: breakdown(3),
      totalTokens: 15,
      responseCount: 3,
      estimatedResponseCount: 1,
      missingResponseCount: 1,
      activeExecutionCount: 1,
      quality: "partial",
      byExecutionKind: { root_session: breakdown(15) },
      byModel: { "provider/model": breakdown(15) },
      asOf: "2026-08-03T00:00:00.000Z",
    };
    const requestedScopes: Array<{ kind: "repro"; reproId: string }> = [];
    const tokenUsageByPersistence: SparkTokenUsageByPersistence = {
      scope: tokenUsage.scope,
      byPersistence: {
        anonymous: {
          quality: "exact",
          totalTokens: 3,
          activeExecutionCount: 0,
          responseCount: 1,
          estimatedResponseCount: 0,
          missingResponseCount: 0,
          reported: breakdown(3),
          estimated: breakdown(0),
        },
        persistent: {
          quality: "partial",
          totalTokens: 12,
          activeExecutionCount: 1,
          responseCount: 2,
          estimatedResponseCount: 1,
          missingResponseCount: 1,
          reported: breakdown(9),
          estimated: breakdown(3),
        },
      },
      asOf: tokenUsage.asOf,
    };

    const work = await projectSparkSessionWork({
      cwd,
      sessionId,
      loops: [driver(repro.reproId, "repro", "running")],
      tokenUsage: (scope) => {
        requestedScopes.push(scope);
        return tokenUsage;
      },
      tokenUsageByPersistence: (scope) => {
        requestedScopes.push(scope);
        return tokenUsageByPersistence;
      },
    });

    expect(requestedScopes).toEqual([
      { kind: "repro", reproId: repro.reproId },
      { kind: "repro", reproId: repro.reproId },
    ]);
    expect(work?.repro?.tokenUsage).toEqual(tokenUsage);
    expect(work?.repro?.tokenUsageByPersistence).toEqual(tokenUsageByPersistence);
  });

  it("derives Goal readiness from the selected TaskGraph without blocking independent work", async () => {
    const cwd = await tempCwd();
    const timestamp = "2026-08-13T00:00:00.000Z";
    await writeJson(sessionGoalStorePathV2(cwd, context), {
      version: 1,
      goal: {
        version: 1,
        goalId: "goal-readiness",
        sessionKey: `session:${sessionId}`,
        originalObjective: "Keep independent work running while a decision is pending",
        objective: "Keep independent work running while a decision is pending",
        status: "active",
        source: "explicit",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Goal readiness",
      description: "Exercise TaskGraph-derived ready and blocked work",
    });
    const independent = graph.createTask({
      projectRef: project.ref,
      title: "Run independent validation",
      description: "Run a validation that does not depend on the pending decision.",
      status: "pending",
      plan: executionReadyPlan("independent validation"),
    });
    const prerequisite = graph.createTask({
      projectRef: project.ref,
      title: "Await the canonical decision",
      description: "Keep the decision prerequisite active until the user answers.",
      status: "running",
      plan: executionReadyPlan("canonical decision"),
    });
    const dependent = graph.createTask({
      projectRef: project.ref,
      title: "Apply the selected decision",
      description: "Apply the decision after its prerequisite completes.",
      status: "pending",
      plan: executionReadyPlan("decision application"),
    });
    graph.addDependency(dependent.ref, prerequisite.ref);
    await defaultTaskGraphStore(cwd).save(graph);
    await writeSparkSessionWorkspaceState(cwd, context, {
      version: 3,
      projectRef: project.ref,
    });

    const work = await projectSparkSessionWork({
      cwd,
      sessionId,
      loops: [driver("goal-readiness", "goal", "blocked")],
      pendingRequestCount: 1,
    });

    expect(work?.goal).toMatchObject({
      status: "waiting_decision",
      readiness: {
        readyTaskRefs: [independent.ref],
        readyTaskCount: 1,
        blockedTaskRefs: [dependent.ref],
        blockedTaskCount: 1,
        pendingRequestCount: 1,
      },
    });
  });

  it("rebuilds lane, handoff, resolution, and formalized tip projections after restart", async () => {
    const cwd = await tempCwd();
    const graphResult = await defaultTaskGraphStore(cwd).update(
      (graph) => {
        const project = graph.createProject({ title: "Repro", description: "Projection" });
        const tasks = Object.fromEntries(
          ["implementation", "exactness", "formalize"].map((lane) => [
            lane,
            graph.createTask({
              projectRef: project.ref,
              title: `${lane} concern`,
              description: "Projection binding",
            }),
          ]),
        );
        graph.recordRun({
          ref: "run:implementation-latest" as RunRef,
          projectRef: project.ref,
          taskRef: tasks.implementation!.ref,
          status: "succeeded",
          startedAt: "2026-08-14T00:00:00.000Z",
          finishedAt: "2026-08-14T00:01:00.000Z",
          outputEvidenceRefs: [],
        });
        return { project, tasks };
      },
      { createIfMissing: true },
    );
    const { project, tasks } = graphResult.result;
    let repro = {
      ...createSparkSessionRepro(`session:${sessionId}`, undefined, {
        objective: "Recover three-lane work",
        reproId: "repro-restart",
      }),
      projectRef: project.ref,
    };
    let threeLane = registerSparkReproWorkItem(repro.threeLane, "implementation", {
      workItemId: "work:restart-boundary",
      title: "Recover the first bad boundary",
      scope: "/private/repro/candidate",
      planRevision: repro.plan.currentRevision,
      sourceRevision: "commit:candidate",
      status: "open",
      taskRef: tasks.implementation!.ref,
      evidenceRefs: [],
      unresolvedIds: [],
    });
    for (const lane of ["exactness", "formalize"] as const) {
      threeLane = registerSparkReproWorkItem(threeLane, lane, {
        workItemId: "work:restart-boundary",
        title: "Recover the first bad boundary",
        scope: "/private/repro/candidate",
        planRevision: repro.plan.currentRevision,
        sourceRevision: "commit:candidate",
        status: "open",
        taskRef: tasks[lane]!.ref,
        evidenceRefs: [],
        unresolvedIds: [],
      });
    }
    threeLane = recordSparkReproWorkHandoff(threeLane, {
      handoffId: "handoff:implementation-exactness",
      workItemId: "work:restart-boundary",
      from: "implementation",
      to: "exactness",
      planRevision: repro.plan.currentRevision,
      sourceRevision: "commit:candidate",
      scope: "Verify the candidate at the first bad boundary",
      findingIds: [],
      evidenceRefs: ["evidence:implementation" as EvidenceRef],
      candidateRevisions: ["commit:candidate"],
      dependsOnHandoffIds: [],
      doneWhen: ["The first bad boundary is classified"],
      status: "accepted",
    });
    threeLane = recordSparkReproWorkHandoff(threeLane, {
      handoffId: "handoff:exactness-formalize",
      workItemId: "work:restart-boundary",
      from: "exactness",
      to: "formalize",
      planRevision: repro.plan.currentRevision,
      sourceRevision: "commit:candidate",
      scope: "Retire the verified candidate",
      findingIds: [],
      evidenceRefs: ["evidence:exactness" as EvidenceRef],
      candidateRevisions: ["commit:candidate"],
      dependsOnHandoffIds: ["handoff:implementation-exactness"],
      doneWhen: ["The normative entry is accepted"],
      status: "accepted",
    });
    threeLane = recordSparkReproResolution(threeLane, {
      resolutionId: "resolution:formalize-exactness",
      workItemId: "work:restart-boundary",
      from: "formalize",
      to: "exactness",
      status: "resolved",
      canonicalRevision: "commit:formalized",
      supersededRevisions: ["commit:candidate"],
      evidenceRefs: ["evidence:formalized" as EvidenceRef],
    });
    threeLane = recordSparkReproResolution(threeLane, {
      resolutionId: "resolution:exactness-implementation",
      workItemId: "work:restart-boundary",
      from: "exactness",
      to: "implementation",
      status: "superseded",
      canonicalRevision: "commit:formalized",
      supersededRevisions: ["commit:candidate"],
      evidenceRefs: ["evidence:superseded" as EvidenceRef],
      parentResolutionId: "resolution:formalize-exactness",
    });
    repro = { ...repro, threeLane };
    await writeJson(sessionReproStorePathV2(cwd, context), { version: 9, repro });

    const beforeRestart = await projectSparkSessionWork({ cwd, sessionId, loops: [] });
    const recovered = await readSessionReproForDaemon(cwd, sessionId);
    const afterRestart = await projectSparkSessionWork({ cwd, sessionId, loops: [] });

    expect(recovered?.threeLane.handoffs).toHaveLength(2);
    expect(recovered?.threeLane.resolutions).toHaveLength(2);
    expect(afterRestart?.repro?.lanes).toEqual(beforeRestart?.repro?.lanes);
    expect(afterRestart?.repro?.lanes).toMatchObject({
      implementation: {
        totalCount: 1,
        items: [
          {
            workItemId: "work:restart-boundary",
            bindingRevision: 1,
            runRef: "run:implementation-latest",
            handoffCount: 2,
            resolutionCount: 2,
          },
        ],
      },
      exactness: { totalCount: 1 },
      formalize: { totalCount: 1 },
      formalizedTip: "commit:formalized",
    });
    expect(JSON.stringify(afterRestart?.repro?.lanes)).not.toContain("/private/repro/candidate");
  });

  it("keeps Repro work available when token usage aggregation fails", async () => {
    const cwd = await tempCwd();
    const repro = createSparkSessionRepro(`session:${sessionId}`, undefined, {
      objective: "Keep the technical work visible",
    });
    await writeJson(sessionReproStorePathV2(cwd, context), { version: 9, repro });
    const diagnostics: string[] = [];

    const work = await projectSparkSessionWork({
      cwd,
      sessionId,
      loops: [driver(repro.reproId, "repro", "running")],
      tokenUsage: () => {
        throw new Error("ledger unavailable");
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    expect(work?.repro?.reproId).toBe(repro.reproId);
    expect(work?.repro?.tokenUsage).toBeUndefined();
    expect(diagnostics).toEqual(["token_usage_unavailable"]);
  });

  it("keeps a valid Goal projection when Repro state is corrupt", async () => {
    const cwd = await tempCwd();
    const timestamp = "2026-07-28T00:00:00.000Z";
    const diagnostics: SparkSessionWorkProjectionDiagnostic[] = [];
    await writeJson(sessionGoalStorePathV2(cwd, context), {
      version: 1,
      goal: {
        version: 1,
        goalId: "goal-independent",
        sessionKey: `session:${sessionId}`,
        originalObjective: "Keep the valid domain",
        objective: "Keep the valid domain",
        status: "active",
        source: "explicit",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    await writeJson(sessionReproStorePathV2(cwd, context), {
      version: 4,
      repro: { objective: "Incomplete persisted state" },
    });

    const work = await projectSparkSessionWork({
      cwd,
      sessionId,
      loops: [driver("driver-goal", "goal", "running")],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(work).toMatchObject({
      primary: { loopId: "driver-goal" },
      goal: {
        goalId: "goal-independent",
        objective: "Keep the valid domain",
        status: "active",
      },
    });
    expect(work).not.toHaveProperty("repro");
    expect(diagnostics).toEqual([
      {
        code: "repro_state_unavailable",
        domain: "repro",
        sessionId,
      },
    ]);
  });
});

function driver(
  loopId: string,
  domain: "goal" | "loop" | "repro" | "workflow",
  status: SparkLoopView["status"],
): SparkLoopView {
  const binding =
    domain === "goal"
      ? { goalId: loopId }
      : domain === "repro"
        ? { reproId: loopId }
        : domain === "workflow"
          ? { workflowRunId: loopId }
          : {};
  return {
    loopId,
    binding,
    ownerSessionId: sessionId,
    status,
    sessionLifetime: "driver",
    continuity: "session",
    generation: 1,
    policy: sparkLoopPolicySchema.parse({}),
    counters: sparkLoopCountersSchema.parse({}),
    attempt: 0,
  };
}

async function tempCwd(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spark-work-projection-"));
  roots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function breakdown(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
  };
}

function executionReadyPlan(subject: string) {
  return {
    objective: `Validate ${subject}`,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`The ${subject} check exits successfully with no validation failures.`],
    evidenceRequired: [`Evidence records the ${subject} command, output, and exit code.`],
    steps: [`Run the ${subject} check and record its result.`],
    riskLevel: "normal" as const,
    openQuestions: [],
    askRefs: [],
  };
}
