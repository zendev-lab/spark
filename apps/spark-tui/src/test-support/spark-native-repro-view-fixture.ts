import { SPARK_PROTOCOL_VERSION, type SparkSessionView } from "@zendev-lab/spark-protocol";

export function sparkNativeReproSessionView(input?: {
  sessionId?: string;
  updatedAt?: string;
  includeMessages?: boolean;
}): SparkSessionView {
  const updatedAt = input?.updatedAt ?? "2026-08-13T08:30:00.000Z";
  return {
    version: SPARK_PROTOCOL_VERSION,
    sessionId: input?.sessionId ?? "session:repro-tui",
    status: "streaming",
    messages: input?.includeMessages
      ? [
          {
            version: SPARK_PROTOCOL_VERSION,
            id: "message:latest",
            role: "assistant",
            text: "latest daemon-projected answer",
            status: "done",
            metadata: {},
          },
        ]
      : [],
    tools: [],
    runs: [
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "run:exactness",
        kind: "task",
        title: "Verify RMSNorm boundary",
        status: "running",
        evidenceRefs: ["evidence:exactness"],
        artifactRefs: [],
        metadata: {},
      },
    ],
    work: {
      repro: {
        reproId: "repro:three-lane",
        status: "active",
        contractStatus: "frozen",
        objective: "Reproduce the target exactly",
        successCriteria: ["Formalize one verified correction"],
        evidenceRequired: ["First bad boundary"],
        stage: {
          name: "alignment",
          title: "Alignment",
          index: 3,
          total: 5,
          phase: "implement",
        },
        plan: { revision: 2, completedSteps: 3, totalSteps: 5 },
        stopGuard: { decision: "continue", stagnationCount: 0, limit: 3 },
        lanes: {
          implementation: {
            status: "blocked",
            totalCount: 2,
            openCount: 1,
            blockedCount: 1,
            completedCount: 0,
            supersededCount: 0,
            pendingHandoffCount: 1,
            resolutionCount: 0,
            items: [
              {
                workItemId: "work:implementation-ready",
                title: "Localize RMSNorm divergence",
                status: "open",
                taskRef: "task:implementation",
                evidenceRefs: ["evidence:implementation"],
                handoffCount: 1,
                resolutionCount: 0,
              },
              {
                workItemId: "work:implementation-blocked",
                title: "Recover reference capture",
                status: "blocked",
                evidenceRefs: [],
                handoffCount: 0,
                resolutionCount: 0,
              },
            ],
          },
          exactness: {
            status: "active",
            totalCount: 2,
            openCount: 2,
            blockedCount: 0,
            completedCount: 0,
            supersededCount: 0,
            pendingHandoffCount: 1,
            resolutionCount: 1,
            items: [
              {
                workItemId: "work:exactness-rmsnorm",
                title: "Classify the RMSNorm mismatch",
                status: "open",
                runRef: "run:exactness",
                evidenceRefs: ["evidence:exactness"],
                handoffCount: 2,
                resolutionCount: 1,
              },
              {
                workItemId: "work:exactness-resync",
                title: "Verify isolate and resync",
                status: "open",
                evidenceRefs: [],
                handoffCount: 0,
                resolutionCount: 0,
              },
            ],
          },
          formalize: {
            status: "active",
            totalCount: 1,
            openCount: 1,
            blockedCount: 0,
            completedCount: 0,
            supersededCount: 0,
            pendingHandoffCount: 0,
            resolutionCount: 1,
            items: [
              {
                workItemId: "work:formalize-rmsnorm",
                title: "Retire the verified correction",
                status: "open",
                gitChangeRef: "artifact:formalize-stack",
                evidenceRefs: ["evidence:formalize"],
                handoffCount: 1,
                resolutionCount: 1,
              },
            ],
          },
          formalizedTip: "commit:canonical-rmsnorm",
        },
        updatedAt,
      },
    },
    tasks: [
      {
        version: SPARK_PROTOCOL_VERSION,
        ref: "task:implementation",
        name: "implementation",
        title: "Localize RMSNorm divergence",
        kind: "implement",
        status: "running",
        projectRef: "proj:repro",
        todos: [],
        runRefs: [],
        evidenceRefs: ["evidence:implementation"],
        artifactRefs: [],
        metadata: {},
      },
    ],
    artifacts: [
      {
        version: SPARK_PROTOCOL_VERSION,
        ref: "artifact:formalize-stack",
        title: "Canonical Formalize stack",
        kind: "git_change",
        format: "json",
        status: "active",
        metadata: {},
      },
    ],
    evidence: [
      {
        version: SPARK_PROTOCOL_VERSION,
        ref: "evidence:implementation",
        title: "Implementation boundary capture",
        kind: "record",
        format: "json",
        status: "accepted",
        metadata: {},
      },
      {
        version: SPARK_PROTOCOL_VERSION,
        ref: "evidence:exactness",
        title: "Exactness comparison",
        kind: "record",
        format: "json",
        status: "accepted",
        metadata: {},
      },
      {
        version: SPARK_PROTOCOL_VERSION,
        ref: "evidence:formalize",
        title: "Formal retirement receipt",
        kind: "record",
        format: "json",
        status: "accepted",
        metadata: {},
      },
    ],
    updatedAt,
    metadata: {},
  };
}
