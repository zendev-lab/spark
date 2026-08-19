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
        version: 10,
        reproId: "repro:three-lane",
        status: "active",
        objective: "Reproduce the target exactly",
        workItemId: "work:repro-three-lane",
        lanes: {
          implementation: {
            sessionId: "session:repro-implementation",
            taskRef: "task:implementation",
            roleRef: "role:extension-repro-implementation-explorer",
          },
          exactness: {
            sessionId: "session:repro-exactness",
            taskRef: "task:exactness",
            roleRef: "role:extension-repro-exactness-instrumentation-worker",
          },
          formalize: {
            sessionId: "session:repro-formalize",
            taskRef: "task:formalize",
            roleRef: "role:extension-repro-precision-fixer",
          },
        },
        checkpoint: {
          checkpointId: "checkpoint:exactness",
          kind: "exactness",
          lane: "exactness",
          status: "running",
          sessionId: "session:repro-exactness",
          taskRef: "task:exactness",
          runRef: "run:exactness",
          attempt: 1,
          evidenceRefs: ["evidence:exactness"],
          summary: "Verify RMSNorm boundary",
        },
        progress: { accepted: 1, total: 5 },
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
