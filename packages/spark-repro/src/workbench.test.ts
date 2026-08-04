import { normalizeSparkA2uiDocument } from "@zendev-lab/spark-protocol/a2ui";
import { describe, expect, it } from "vitest";

import { buildSparkReproWorkSummary } from "./work-summary.ts";
import { renderSparkReproWorkbenchA2ui, sparkReproWorkbenchProjectionDigest } from "./workbench.ts";

describe("Repro A2UI Workbench projection", () => {
  it("projects typed facts and revision-bound closed Loop actions", () => {
    const work = buildSparkReproWorkSummary({
      reproId: "repro-1",
      title: "Align model",
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
    const input = {
      work,
      goalContract: {
        status: "frozen" as const,
        objective: "Align model",
        constraints: [],
        nonGoals: [],
        successCriteria: ["formal parity"],
        evidenceRequired: ["formal evidence"],
        authority: {
          safeLocal: "auto" as const,
          externalWrites: "ask" as const,
          destructiveActions: "ask" as const,
          scopeExpansion: "ask" as const,
        },
        evidenceRefs: [],
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
        frozenAt: "2026-08-04T00:00:00.000Z",
      },
      loop: {
        loopId: "loop-1",
        ownerSessionId: "session-1",
        status: "scheduled" as const,
        continuity: "session" as const,
        generation: 4,
        binding: {
          goalId: "goal-1",
          workflowSelector: "builtin:repro" as const,
          reproId: "repro-1",
        },
        policy: {
          cadenceMs: 30_000,
          retry: { maxAttempts: 3, delaysMs: [30_000] },
          beforeTick: [],
          afterTick: [],
        },
        counters: {
          tickCount: 1,
          skippedCount: 1,
          llmRequestsAvoided: 1,
          conditionRetryCount: 0,
        },
        attempt: 0,
      },
      artifactRef: "artifact:workbench" as const,
      revision: 2,
      lifecycle: "live" as const,
    };
    const content = renderSparkReproWorkbenchA2ui(input);
    const document = normalizeSparkA2uiDocument(content);
    const surface = document.surfaces[0]!;
    expect(document.diagnostics).toEqual([]);
    expect(surface.components["control-pause"]?.action).toMatchObject({
      event: {
        name: "spark.loop.control",
        context: {
          actionId: "pause",
          artifactRef: "artifact:workbench",
          revision: 2,
          loopId: "loop-1",
          generation: 4,
        },
      },
    });
    expect(surface.components["control-stop"]?.action).toMatchObject({
      event: { context: { confirm: true } },
    });
    expect(content).toContain("Goal Contract");
    expect(sparkReproWorkbenchProjectionDigest(input)).toHaveLength(64);
  });
});
