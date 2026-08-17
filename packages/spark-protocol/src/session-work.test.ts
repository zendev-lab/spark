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
          status: "waiting_decision",
          readiness: {
            readyTaskRefs: ["task:independent"],
            readyTaskCount: 1,
            blockedTaskRefs: ["task:needs-answer"],
            blockedTaskCount: 1,
            pendingRequestCount: 1,
          },
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
              authority: "driver_local",
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
          lanes: {
            implementation: lane({
              status: "active",
              items: [
                {
                  workItemId: "work:rmsnorm",
                  title: "Reach RMSNorm",
                  status: "open",
                  taskRef: "task:implementation",
                  runRef: "run:probe",
                  gitChangeRef: "artifact:candidate",
                  evidenceRefs: ["evidence:probe"],
                  handoffCount: 1,
                  resolutionCount: 0,
                },
              ],
              pendingHandoffCount: 1,
            }),
            exactness: lane({ status: "blocked", totalCount: 1, blockedCount: 1 }),
            formalize: lane({ status: "complete", totalCount: 1, completedCount: 1 }),
            formalizedTip: "commit:canonical",
          },
          updatedAt: "2026-07-28T00:00:00.000Z",
        },
      },
    });

    expect(parsed.work?.repro?.plan.currentStep).toMatchObject({
      id: "bitwise-pass-20",
      status: "blocked",
      authority: "driver_local",
    });
    expect(parsed.work?.repro?.latestVerification?.evidenceRefs).toEqual(["evidence:baseline"]);
    expect(parsed.work?.goal).toMatchObject({
      status: "waiting_decision",
      readiness: { readyTaskRefs: ["task:independent"], pendingRequestCount: 1 },
    });
    expect(parsed.work?.repro?.lanes?.implementation.items[0]).toMatchObject({
      workItemId: "work:rmsnorm",
      taskRef: "task:implementation",
    });
    expect(parsed.work?.repro?.lanes?.formalizedTip).toBe("commit:canonical");
  });

  it("rejects unbounded lane details and view-model v1", () => {
    const item = {
      workItemId: "work:item",
      title: "Bounded item",
      status: "open" as const,
      evidenceRefs: [],
      handoffCount: 0,
      resolutionCount: 0,
    };
    expect(() =>
      parseSparkSessionView({
        ...baseSnapshot,
        version: 2,
        work: {
          repro: {
            reproId: "repro-1",
            status: "active",
            contractStatus: "frozen",
            objective: "Bound the projection",
            successCriteria: [],
            evidenceRequired: [],
            stage: {
              name: "alignment",
              title: "Align",
              index: 3,
              total: 5,
              phase: "implement",
            },
            plan: { revision: 1, completedSteps: 0, totalSteps: 1 },
            stopGuard: { decision: "continue", stagnationCount: 0, limit: 3 },
            lanes: {
              implementation: lane({ status: "active", items: Array(7).fill(item) }),
              exactness: lane({ status: "empty" }),
              formalize: lane({ status: "empty" }),
            },
            updatedAt: "2026-07-28T00:00:00.000Z",
          },
        },
      }),
    ).toThrow();
    expect(() => parseSparkSessionView({ ...baseSnapshot, version: 1 })).toThrow();
  });
});

function lane(input: {
  status: "empty" | "active" | "blocked" | "complete";
  totalCount?: number;
  items?: unknown[];
  openCount?: number;
  blockedCount?: number;
  completedCount?: number;
  supersededCount?: number;
  pendingHandoffCount?: number;
  resolutionCount?: number;
}) {
  return {
    status: input.status,
    totalCount: input.totalCount ?? input.items?.length ?? 0,
    openCount: input.openCount ?? input.items?.length ?? 0,
    blockedCount: input.blockedCount ?? 0,
    completedCount: input.completedCount ?? 0,
    supersededCount: input.supersededCount ?? 0,
    pendingHandoffCount: input.pendingHandoffCount ?? 0,
    resolutionCount: input.resolutionCount ?? 0,
    items: input.items ?? [],
  };
}
