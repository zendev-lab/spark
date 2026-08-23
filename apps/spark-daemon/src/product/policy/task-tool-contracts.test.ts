import { describe, expect, it } from "vitest";

import { type TaskClaim } from "@zendev-lab/spark-tasks";
import {
  type TaskCompletionReadiness,
  type TaskPlanItem,
  type TaskStatus,
} from "@zendev-lab/spark-tasks";
import type { TaskPlanInput } from "@zendev-lab/spark-tasks";
import {
  finishProjectionIssue,
  firstBlockingCompletionIssue,
  preserveTaskPlanItemMetadata,
  releaseProjectionIssue,
  terminalTaskPlanInputs,
} from "./task-tool-contracts.ts";

const claim: TaskClaim = {
  kind: "main",
  claimedBy: "session:contract",
  sessionId: "session:contract",
  claimedAt: "2026-08-04T00:00:00.000Z",
  heartbeatAt: "2026-08-04T00:00:00.000Z",
  expiresAt: "2026-08-04T01:00:00.000Z",
};

function planned(status: TaskStatus | undefined): TaskPlanInput {
  return {
    name: `task-${status ?? "default"}`,
    title: `Task ${status ?? "default"}`,
    description: "Exercise the task transition contract",
    kind: "implement",
    status,
  };
}

describe("task tool transition contracts", () => {
  it("classifies exactly the terminal statuses as planning bypasses", () => {
    const tasks = [
      planned(undefined),
      planned("pending"),
      planned("ready"),
      planned("running"),
      planned("blocked"),
      planned("done"),
      planned("failed"),
      planned("cancelled"),
    ];

    expect(terminalTaskPlanInputs(tasks).map((task) => task.status)).toEqual(["done", "failed"]);
  });

  it("selects the first blocking completion issue and ignores warnings", () => {
    const readiness: TaskCompletionReadiness = {
      ready: false,
      issues: [
        {
          kind: "missing_completion_evidence",
          severity: "warning",
          evidenceRequired: ["report"],
          message: "warning only",
        },
        {
          kind: "open_plan_items",
          severity: "blocking",
          openItems: ["pending: validate"],
          message: "plan item remains open",
        },
        {
          kind: "missing_completion_evidence",
          severity: "blocking",
          evidenceRequired: ["report"],
          message: "evidence remains missing",
        },
      ],
    };

    expect(firstBlockingCompletionIssue(readiness)).toMatchObject({
      kind: "open_plan_items",
      message: "plan item remains open",
    });
    expect(
      firstBlockingCompletionIssue({
        ready: true,
        issues: [
          {
            kind: "missing_completion_evidence",
            severity: "warning",
            evidenceRequired: ["report"],
            message: "warning only",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("accepts a finish projection only when daemon state is exactly terminal and unclaimed", () => {
    for (const requestedStatus of ["done", "failed", "cancelled"] as const) {
      expect(
        finishProjectionIssue({
          requestedStatus,
          daemonChanged: true,
          task: { status: requestedStatus, claim: undefined },
        }),
      ).toBeUndefined();
      expect(
        finishProjectionIssue({
          requestedStatus,
          daemonChanged: false,
          task: { status: requestedStatus, claim: undefined },
        }),
      ).toBeUndefined();
      expect(
        finishProjectionIssue({
          requestedStatus,
          daemonChanged: true,
          task: { status: requestedStatus, claim },
        }),
      ).toContain("claim");
      expect(
        finishProjectionIssue({
          requestedStatus,
          daemonChanged: false,
          task: { status: "running", claim },
        }),
      ).toContain("no change");
    }
    expect(
      finishProjectionIssue({
        requestedStatus: "done",
        daemonChanged: true,
        task: { status: "failed", claim: undefined },
      }),
    ).toContain("expected status=done");
  });

  it("accepts a release projection only when ownership is cleared and status is preserved or reset", () => {
    expect(
      releaseProjectionIssue({ statusBefore: "running", task: { status: "pending" } }),
    ).toBeUndefined();
    for (const statusBefore of ["pending", "ready", "blocked"] as const) {
      expect(
        releaseProjectionIssue({
          statusBefore,
          task: { status: statusBefore, claim: undefined },
        }),
      ).toBeUndefined();
    }
    expect(releaseProjectionIssue({ statusBefore: "running", task: undefined })).toContain(
      "disappeared",
    );
    expect(
      releaseProjectionIssue({ statusBefore: "running", task: { status: "pending", claim } }),
    ).toContain("claim");
    expect(releaseProjectionIssue({ statusBefore: "running", task: { status: "done" } })).toContain(
      "terminal",
    );
    expect(
      releaseProjectionIssue({ statusBefore: "running", task: { status: "ready" } }),
    ).toContain("expected status=pending");
  });

  it("preserves semantic metadata for existing items without leaking it to appended items", () => {
    const before: TaskPlanItem[] = [
      {
        id: "existing",
        title: "Validate target",
        description: "Run the exact target validation.",
        status: "in_progress",
        evidenceRefs: ["evidence:target"],
        notes: ["keep"],
        blockedBy: [],
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
      },
    ];
    const after: TaskPlanItem[] = [
      {
        ...before[0],
        description: undefined,
        evidenceRefs: undefined,
        status: "done",
      },
      {
        id: "new",
        title: "Record follow-up",
        status: "in_progress",
        notes: [],
        blockedBy: [],
        createdAt: "2026-08-04T00:01:00.000Z",
        updatedAt: "2026-08-04T00:01:00.000Z",
      },
    ];

    expect(preserveTaskPlanItemMetadata(before, after)).toEqual([
      {
        ...after[0],
        description: "Run the exact target validation.",
        evidenceRefs: ["evidence:target"],
      },
      after[1],
    ]);
  });
});
