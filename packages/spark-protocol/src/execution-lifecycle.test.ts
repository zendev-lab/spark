import { describe, expect, it } from "vitest";
import {
  EXECUTION_TERMINAL_IMMUTABLE,
  executionAttemptSchema,
  executionCheckpointSchema,
  executionProjectionSchema,
  executionRunSchema,
  executionRunStatusSchema,
} from "./execution-lifecycle.ts";

const now = "2026-08-12T00:00:00.000Z";

function run(status: string) {
  return {
    runRef: "run:aggregate",
    invocationId: "inv_aggregate",
    taskRef: "task:aggregate",
    projectRef: "proj:aggregate",
    workspaceId: "ws_aggregate",
    status,
    stateRevision: 2,
    createdAt: now,
    updatedAt: now,
  };
}

function assertMutable(status: string): void {
  if (["cancelled", "succeeded", "failed", "blocked", "recovery_required"].includes(status)) {
    throw new Error(`${EXECUTION_TERMINAL_IMMUTABLE}: cannot reopen ${status}`);
  }
}

describe("execution lifecycle protocol", () => {
  it("parses every execution run and attempt status", () => {
    for (const status of executionRunStatusSchema.options) {
      expect(executionRunSchema.parse(run(status)).status).toBe(status);
    }
    for (const status of [
      "queued",
      "running",
      "paused",
      "succeeded",
      "failed",
      "blocked",
      "recovery_required",
      "cancelled",
    ]) {
      expect(
        executionAttemptSchema.parse({
          attemptId: "attempt:aggregate",
          runRef: "run:aggregate",
          attempt: 1,
          status,
          daemonGeneration: 3,
          stateRevision: 2,
          leaseToken: "lease:aggregate",
          checkpointRevision: 0,
        }).status,
      ).toBe(status);
    }
  });

  it("keeps terminal execution states immutable", () => {
    for (const terminal of ["cancelled", "succeeded", "failed", "blocked", "recovery_required"]) {
      for (const target of ["queued", "running", "paused"]) {
        expect(() => {
          assertMutable(terminal);
          return target;
        }).toThrow(EXECUTION_TERMINAL_IMMUTABLE);
      }
    }
  });

  it("validates checkpoint and read-only projection identities", () => {
    const checkpoint = executionCheckpointSchema.parse({
      checkpointId: "checkpoint:aggregate",
      runRef: "run:aggregate",
      attemptId: "attempt:aggregate",
      revision: 1,
      payload: { phase: "tool_result", cursor: 7 },
      createdAt: now,
    });
    const projection = executionProjectionSchema.parse({
      ...run("paused"),
      pauseReason: "daemon_restart",
    });
    expect(checkpoint.payload).toEqual({ phase: "tool_result", cursor: 7 });
    expect(projection).not.toHaveProperty("transition");
    expect(projection).not.toHaveProperty("command");
  });
});
