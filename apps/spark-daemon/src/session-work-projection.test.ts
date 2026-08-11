import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { EvidenceRef } from "@zendev-lab/spark-core";
import { sessionGoalStorePathV2, sessionReproStorePathV2 } from "@zendev-lab/spark-loop";
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
  stepDefinitionDigest,
  updateReproStep,
  verifyReproStepPass,
} from "@zendev-lab/spark-repro";
import { afterEach, describe, expect, it } from "vitest";

import {
  projectSparkSessionWork,
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
    await writeJson(sessionReproStorePathV2(cwd, context), { version: 7, repro });

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
    await writeJson(sessionReproStorePathV2(cwd, context), { version: 7, repro });
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

  it("keeps Repro work available when token usage aggregation fails", async () => {
    const cwd = await tempCwd();
    const repro = createSparkSessionRepro(`session:${sessionId}`, undefined, {
      objective: "Keep the technical work visible",
    });
    await writeJson(sessionReproStorePathV2(cwd, context), { version: 7, repro });
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
    expect(diagnostics).toContain("token_usage_unavailable");
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
    expect(diagnostics).toContainEqual({
      code: "repro_state_unavailable",
      domain: "repro",
      sessionId,
    });
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
