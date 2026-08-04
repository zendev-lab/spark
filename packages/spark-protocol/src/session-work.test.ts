import { describe, expect, it } from "vitest";

import { parseSparkSessionView } from "./index.ts";

const baseSnapshot = {
  sessionId: "session-1",
  status: "idle" as const,
  messages: [],
  tools: [],
  runs: [],
  tasks: [],
  artifacts: [],
  evidence: [],
};

describe("SparkSessionView work projection", () => {
  it("keeps snapshots from older daemons compatible", () => {
    expect(parseSparkSessionView(baseSnapshot).work).toBeUndefined();
  });

  it("parses display-safe Goal and Repro work", () => {
    const parsed = parseSparkSessionView({
      ...baseSnapshot,
      work: {
        primary: { kind: "repro", loopId: "driver-repro" },
        goal: {
          goalId: "goal-1",
          objective: "Reproduce target logits",
          status: "active",
          updatedAt: "2026-07-28T00:00:00.000Z",
        },
        repro: {
          reproId: "repro-1",
          status: "active",
          contractStatus: "frozen",
          objective: "Reproduce target logits",
          successCriteria: ["20-step bitwise parity"],
          evidenceRequired: ["Bound run output"],
          stage: {
            name: "target",
            title: "Reproduce",
            index: 2,
            total: 5,
            phase: "implement",
          },
          plan: {
            revision: 2,
            completedSteps: 5,
            totalSteps: 11,
            currentStep: {
              id: "bitwise-pass-20",
              stage: "target",
              goal: "Reach 20-step parity",
              status: "blocked",
              authority: "safe_local",
              doneWhen: ["20 steps pass"],
              evidenceRequired: ["Alignment result"],
              blocker: "GPU unavailable",
            },
          },
          stopGuard: { decision: "ask", stagnationCount: 3, limit: 3 },
          latestVerification: {
            stepId: "baseline-probe-passed",
            proofKind: "evidence",
            verifiedDoneWhen: ["Baseline executes"],
            evidenceRefs: ["evidence:baseline"],
          },
          updatedAt: "2026-07-28T00:00:00.000Z",
        },
      },
    });

    expect(parsed.work?.repro?.plan.currentStep).toMatchObject({
      id: "bitwise-pass-20",
      status: "blocked",
    });
    expect(parsed.work?.repro?.latestVerification?.evidenceRefs).toEqual(["evidence:baseline"]);
  });
});
