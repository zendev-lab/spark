import { getCockpitDictionary } from "@zendev-lab/spark-i18n/cockpit";
import {
  parseSparkSessionView,
  type SparkDriverStatus,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ReproTokenUsage from "./ReproTokenUsage.svelte";
import SessionWorkPanel from "./SessionWorkPanel.svelte";
import type { SessionConversationHost } from "./conversation-host";

const copy = getCockpitDictionary("en").sessions.workbench;

describe("SessionWorkPanel", () => {
  it.each<SparkDriverStatus>([
    "scheduled",
    "running",
    "retry_wait",
    "dormant",
    "blocked",
    "stopped",
  ])("renders the reachable %s driver state with text and an accessible status", (status) => {
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
      drivers: [
        {
          driverId: "repro-driver",
          kind: "repro",
          ownerSessionId: "session-repro",
          status: "blocked",
          continuity: "session",
          attempt: 2,
          reason: "Waiting for a decision",
        },
      ],
      work: {
        primary: { kind: "repro", driverId: "repro-driver" },
        repro: {
          reproId: "repro-1",
          status: "active",
          contractStatus: "frozen",
          objective: "Reproduce target logits",
          successCriteria: ["20-step parity"],
          evidenceRequired: ["Bound result"],
          stage: { name: "reproduce", title: "Reproduce", index: 2, total: 5, phase: "implement" },
          plan: {
            revision: 2,
            completedSteps: 5,
            totalSteps: 11,
            currentStep: {
              id: "bitwise-pass-20",
              stage: "reproduce",
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
            stepId: "baseline-probe",
            proofKind: "evidence",
            verifiedDoneWhen: ["Baseline executes"],
            evidenceRefs: ["evidence:baseline"],
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
    expect(body).toContain("20 steps pass");
    expect(body).toContain("GPU unavailable");
    expect(body).toContain("baseline-probe");
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
          persistence: copy.sessionPersistence,
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

function driverSession(status: SparkDriverStatus): SparkSessionView {
  return parseSparkSessionView({
    sessionId: "session-driver",
    status: "idle",
    drivers: [
      {
        driverId: "driver-1",
        kind: "goal",
        ownerSessionId: "session-driver",
        status,
        continuity: "session",
        attempt: 0,
      },
    ],
    work: { primary: { kind: "goal", driverId: "driver-1" } },
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
