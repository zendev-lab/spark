import { getCockpitDictionary } from "@zendev-lab/spark-cockpit-i18n";
import {
  parseSparkSessionView,
  type SparkDriverStatus,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

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
    expect(body).not.toContain("lastProgressDigest");
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

function hostFor(liveSessionView: SparkSessionView): SessionConversationHost {
  return {
    copy,
    liveSessionView,
    statusLabel: (status: string) => status,
    relative: (value: string | null) => value ?? "",
  } as unknown as SessionConversationHost;
}
