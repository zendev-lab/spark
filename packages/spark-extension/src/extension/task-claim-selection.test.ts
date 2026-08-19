import { describe, expect, it } from "vitest";

import { TaskGraph } from "@zendev-lab/spark-tasks";
import { resolveSessionClaimedTask, sparkTaskClaimSessionKey } from "./task-claim-selection.ts";

function executionReadyPlan(subject: string) {
  return {
    objective: `Validate ${subject}`,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`pnpm test verifies ${subject} selection with exit code 0.`],
    evidenceRequired: [`Evidence records the ${subject} test command, output, and exit code.`],
    steps: [`Validate ${subject}`],
    riskLevel: "normal" as const,
    openQuestions: [],
    askRefs: [],
  };
}

function claimedGraph() {
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Claim selector contract",
    description: "Exercise exact, prefix, and fallback selection",
  });
  const sessionKey = "session:selector-contract";
  const alpha = graph.createTask({
    projectRef: project.ref,
    name: "validate-alpha",
    title: "Validate API alpha",
    description: "Validate alpha",
    plan: executionReadyPlan("alpha"),
    status: "running",
  });
  const beta = graph.createTask({
    projectRef: project.ref,
    name: "validate-beta",
    title: "Validate API beta",
    description: "Validate beta",
    plan: executionReadyPlan("beta"),
    status: "running",
  });
  graph.claimTask(alpha.ref, {
    kind: "main",
    claimedBy: sessionKey,
    sessionId: sessionKey,
    leaseMs: 60_000,
  });
  graph.claimTask(beta.ref, {
    kind: "role-run",
    claimedBy: `${sessionKey}/beta-run`,
    sessionId: sessionKey,
    runName: "beta-run",
    leaseMs: 60_000,
  });
  graph.setCurrentTask(project.ref, alpha.ref);
  return { graph, project, sessionKey, alpha, beta };
}

describe("claimed task selection", () => {
  it("uses the current Session as the only claim identity", () => {
    expect(sparkTaskClaimSessionKey({ sessionId: "session:ordinary" })).toBe("session:ordinary");
  });

  it("prefers exact ref, name, and title over prefix matching", () => {
    const { graph, project, sessionKey, alpha, beta } = claimedGraph();

    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, alpha.ref)?.ref).toBe(
      alpha.ref,
    );
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, `@${beta.name}`)?.ref).toBe(
      beta.ref,
    );
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, beta.title)?.ref).toBe(
      beta.ref,
    );
  });

  it("accepts a unique title prefix but refuses an ambiguous prefix", () => {
    const { graph, project, sessionKey, alpha } = claimedGraph();

    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, "Validate API a")?.ref).toBe(
      alpha.ref,
    );
    expect(
      resolveSessionClaimedTask(graph, project.ref, sessionKey, "Validate API"),
    ).toBeUndefined();
  });

  it("uses the current claimed task when no selector is supplied", () => {
    const { graph, project, sessionKey, alpha } = claimedGraph();

    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey)?.ref).toBe(alpha.ref);
  });

  it("falls back deterministically to the newest claim when the current task is not claimed", () => {
    const { graph, project, sessionKey, beta } = claimedGraph();
    graph.setCurrentTask(project.ref, undefined);

    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey)?.ref).toBe(beta.ref);
  });
});
