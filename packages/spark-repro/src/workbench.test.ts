import { normalizeSparkA2uiDocument } from "@zendev-lab/spark-protocol/a2ui";
import type { EvidenceRef } from "@zendev-lab/spark-core";
import { describe, expect, it } from "vitest";

import {
  migrateSparkReproWorkSummaryV2,
  normalizeSparkReproWorkSummaryV3,
} from "./three-lane-work-summary.ts";
import { buildSparkReproWorkSummary } from "./work-summary.ts";
import { renderSparkReproWorkbenchA2ui, sparkReproWorkbenchProjectionDigest } from "./workbench.ts";

describe("Repro A2UI Workbench projection", () => {
  it("projects typed facts and revision-bound closed Loop actions", () => {
    const workV2 = buildSparkReproWorkSummary({
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
    const planRevision = workV2.normativeCursor.planRevision;
    const evidenceRef = "evidence:workbench" as EvidenceRef;
    const workItem = {
      workItemId: "work:rmsnorm",
      title: "Localize RMSNorm divergence",
      scope: "internal scope is not projected",
      planRevision,
      sourceRevision: "commit:candidate",
      status: "open" as const,
      taskRef: "task:rmsnorm" as const,
      evidenceRefs: [evidenceRef],
      unresolvedIds: [],
    };
    const migrated = migrateSparkReproWorkSummaryV2(workV2);
    const work = normalizeSparkReproWorkSummaryV3({
      ...migrated,
      lanes: {
        ...migrated.lanes,
        implementation: {
          ...migrated.lanes.implementation,
          workItemIds: [workItem.workItemId],
        },
        exactness: {
          ...migrated.lanes.exactness,
          workItemIds: [workItem.workItemId],
        },
        formalize: {
          ...migrated.lanes.formalize,
          workItemIds: [workItem.workItemId],
          formalizedTip: "commit:canonical",
        },
      },
      workItems: [workItem],
      handoffs: [
        {
          handoffId: "handoff:implementation-exactness",
          workItemId: workItem.workItemId,
          from: "implementation",
          to: "exactness",
          planRevision,
          sourceRevision: workItem.sourceRevision,
          scope: workItem.scope,
          findingIds: [],
          evidenceRefs: [evidenceRef],
          candidateRevisions: [workItem.sourceRevision],
          dependsOnHandoffIds: [],
          doneWhen: ["Classify the boundary"],
          status: "accepted",
        },
        {
          handoffId: "handoff:exactness-formalize",
          workItemId: workItem.workItemId,
          from: "exactness",
          to: "formalize",
          planRevision,
          sourceRevision: workItem.sourceRevision,
          scope: workItem.scope,
          findingIds: [],
          evidenceRefs: [evidenceRef],
          candidateRevisions: [workItem.sourceRevision],
          dependsOnHandoffIds: ["handoff:implementation-exactness"],
          doneWhen: ["Accept one stack entry"],
          status: "accepted",
        },
      ],
      resolutions: [
        {
          resolutionId: "resolution:formalize-exactness",
          workItemId: workItem.workItemId,
          from: "formalize",
          to: "exactness",
          status: "resolved",
          canonicalRevision: "commit:canonical",
          supersededRevisions: [workItem.sourceRevision],
          evidenceRefs: [evidenceRef],
        },
      ],
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
          boundedExternalWrites: "driver" as const,
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
        sessionLifetime: "driver" as const,
        continuity: "session" as const,
        generation: 4,
        binding: {
          goalId: "goal-1",
          workflowSelector: "builtin:repro" as const,
          reproId: work.reproId,
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
    expect(content).toContain('"title": "Lanes"');
    expect(content).not.toContain('"title": "Plan"');
    expect(content).toContain("Implementation Explore");
    expect(content).toContain("Exactness Explore");
    expect(content).toContain("Formalized tip: `commit:canonical`");
    expect(content).toContain("`task:rmsnorm`");
    expect(content).toContain("`evidence:workbench`");
    expect(content).toContain("implementation → exactness");
    expect(content).toContain("formalize → exactness");
    expect(content).not.toContain(workItem.scope);
    expect(sparkReproWorkbenchProjectionDigest(input)).toHaveLength(64);

    const unquantifiedProgress = {
      quantified: false as const,
      stages: work.progress.stages.map(
        ({ percent: _percent, contribution: _contribution, ...stage }) => stage,
      ),
    };
    const unquantifiedContent = renderSparkReproWorkbenchA2ui({
      ...input,
      work: {
        ...work,
        progress: unquantifiedProgress,
        formalProgress: unquantifiedProgress,
      },
    });
    expect(unquantifiedContent).toContain("unquantified");
    expect(unquantifiedContent).not.toContain("undefined%");
  });
});
