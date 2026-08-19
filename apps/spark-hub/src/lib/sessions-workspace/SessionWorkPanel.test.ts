import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import {
  parseSparkSessionView,
  type SparkLoopStatus,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ReproTokenUsage from "./ReproTokenUsage.svelte";
import SessionWorkPanel from "./SessionWorkPanel.svelte";
import type { SessionConversationHost } from "./conversation-host";

const copy = getHubDictionary("en").sessions.workbench;

describe("SessionWorkPanel", () => {
  it.each<SparkLoopStatus>([
    "scheduled",
    "running",
    "retry_wait",
    "dormant",
    "paused",
    "blocked",
    "completed",
    "stopped",
  ])("renders the reachable %s loop state with text and an accessible status", (status) => {
    const body = render(SessionWorkPanel, {
      props: { host: hostFor(driverSession(status)) },
    }).body;

    expect(body).toContain(`Work status: ${status}`);
    expect(body).toContain(`>${status}<`);
  });

  it("renders current completion criteria, blocker, and a bounded verification receipt", () => {
    const session = parseSparkSessionView({
      sessionId: "session-repro",
      status: "idle",
      work: {
        repro: {
          version: 10,
          reproId: "repro-1",
          status: "waiting_attention",
          objective: "Reproduce target logits",
          workItemId: "work:repro-1",
          lanes: {
            implementation: {
              sessionId: "session:implementation",
              taskRef: "task:implementation",
              roleRef: "role:implementation",
            },
            exactness: {
              sessionId: "session:exactness",
              taskRef: "task:exactness",
              roleRef: "role:exactness",
            },
            formalize: {
              sessionId: "session:formalize",
              taskRef: "task:formalize",
              roleRef: "role:formalize",
            },
          },
          checkpoint: {
            checkpointId: "checkpoint:exactness",
            kind: "exactness",
            lane: "exactness",
            status: "attention",
            sessionId: "session:exactness",
            taskRef: "task:exactness",
            runRef: "run:exactness",
            attempt: 2,
            evidenceRefs: ["evidence:baseline"],
            summary: "Reach 20-step parity",
            attention: {
              decisionKey: "gpu-access",
              question: "GPU unavailable",
              expectedAnswerKind: "single",
            },
          },
          progress: { accepted: 1, total: 5 },
          workbench: {
            artifactRef: "artifact:workbench-repro-1",
            revision: 4,
            lifecycle: "live",
          },
          tokenUsage: {
            scope: { kind: "repro", reproId: "repro-1" },
            reported: tokenBreakdown(124_800),
            estimated: tokenBreakdown(2_631),
            totalTokens: 127_431,
            responseCount: 14,
            missingResponseCount: 2,
            coverageGapCount: 1,
            activeExecutionCount: 1,
            quality: "partial",
            byExecutionKind: {
              root_session: tokenBreakdown(100_000),
              role_run: tokenBreakdown(27_431),
            },
            byModel: { "openai/gpt-5": tokenBreakdown(127_431) },
            asOf: "2026-08-03T00:00:00.000Z",
          },
          tokenUsageByPersistence: {
            scope: { kind: "repro", reproId: "repro-1" },
            byPersistence: {
              anonymous: tokenUsageBucket(27_431, 3),
              persistent: tokenUsageBucket(100_000, 11),
            },
            asOf: "2026-08-03T00:00:00.000Z",
          },
          updatedAt: "2026-07-28T00:00:00.000Z",
        },
      },
      messages: [],
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
    });

    const body = render(SessionWorkPanel, { props: { host: hostFor(session) } }).body;

    expect(body).toContain("Reach 20-step parity");
    expect(body).toContain("GPU unavailable");
    expect(body).toContain("evidence:baseline");
    expect(body).toContain("127,431 tokens");
    expect(body).toContain("124,800 reported");
    expect(body).toContain("2,631 estimated");
    expect(body).toContain("2 responses missing");
    expect(body).toContain("1 coverage gap");
    expect(body).toContain("partial · lower bound");
    expect(body).toContain("Temporary sessions");
    expect(body).toContain("27,431 ·");
    expect(body).toContain("Persistent sessions");
    expect(body).toContain("Loading trusted Repro Workbench");
    expect(body).toContain("session:implementation");
    expect(body).toContain("session:exactness");
    expect(body).toContain("session:formalize");
    expect(body).not.toContain("lastProgressDigest");
  });

  it("does not present unknown Repro usage as a measured zero", () => {
    const body = render(ReproTokenUsage, {
      props: {
        usage: {
          scope: { kind: "repro", reproId: "repro-unknown" },
          reported: tokenBreakdown(0),
          estimated: tokenBreakdown(0),
          totalTokens: 0,
          responseCount: 0,
          missingResponseCount: 0,
          activeExecutionCount: 0,
          quality: "unknown",
          byExecutionKind: {},
          byModel: {},
          asOf: "2026-08-03T00:00:00.000Z",
        },
        labels: {
          title: copy.reproTokenUsage,
          reported: copy.reportedTokens,
          estimated: copy.estimatedTokens,
          missingResponses: copy.missingResponses,
          coverageGaps: copy.coverageGaps,
          activeExecutions: copy.activeExecutions,
          lowerBound: copy.lowerBound,
          breakdown: copy.tokenBreakdown,
          executionKinds: copy.executionKinds,
          models: copy.models,
          persistence: copy.executionPersistence,
          anonymousSessions: copy.anonymousSessions,
          persistentSessions: copy.persistentSessions,
          responses: copy.responses,
          noBreakdown: copy.noTokenBreakdown,
          unknownUsage: copy.unknownTokenUsage,
        },
      },
    }).body;

    expect(body).toContain("Token usage unavailable");
    expect(body).toContain(">unknown<");
    expect(body).not.toContain("0 tokens");
  });
});

function driverSession(status: SparkLoopStatus): SparkSessionView {
  return parseSparkSessionView({
    sessionId: "session-driver",
    status: "idle",
    loops: [
      {
        loopId: "driver-1",
        binding: { goalId: "goal-1" },
        ownerSessionId: "session-driver",
        status,
        continuity: "session",
        generation: 1,
        policy: {},
        counters: {},
        attempt: 0,
      },
    ],
    work: { primary: { loopId: "driver-1" } },
    messages: [],
    tools: [],
    runs: [],
    tasks: [],
    artifacts: [],
    evidence: [],
  });
}

function tokenBreakdown(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
  };
}

function tokenUsageBucket(totalTokens: number, responseCount: number) {
  return {
    quality: "exact" as const,
    totalTokens,
    activeExecutionCount: 0,
    responseCount,
    missingResponseCount: 0,
    reported: tokenBreakdown(totalTokens),
    estimated: tokenBreakdown(0),
  };
}

function hostFor(liveSessionView: SparkSessionView): SessionConversationHost {
  return {
    copy,
    liveSessionView,
    statusLabel: (status: string) => status,
    relative: (value: string | null) => value ?? "",
  } as unknown as SessionConversationHost;
}
