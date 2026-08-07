import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import type { SparkDaemonHumanInteractionBroker } from "../core/human-interactions.ts";
import { createDaemonExecutionOwnerHandlers } from "./daemon-owner-capabilities.ts";

describe("daemon execution owner composition", () => {
  it("binds human interaction and Loop operations to one existing owner call", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const interact = vi.fn(async () => ({ answered: true }));
    const scheduleLoop = vi.fn(() => ({ scheduled: true }));
    const stopLoop = vi.fn(() => ({ stopped: true }));
    const owners = createDaemonExecutionOwnerHandlers({
      db,
      humanInteractions: { interact } as unknown as SparkDaemonHumanInteractionBroker,
      scheduleLoop,
      stopLoop,
    });
    const signal = new AbortController().signal;
    const identity = { invocationId: "inv_owner", attemptEpoch: 2, daemonGeneration: 3 };

    await expect(
      owners.humanInteraction(
        {
          interaction: {
            requestId: "ask-owner",
            kind: "askFlow",
            title: "Owner fixture",
            prompt: "Continue?",
            delivery: "blocking",
            mode: "decision",
            source: "daemon",
            questions: [{ id: "confirm", prompt: "Continue?", type: "freeform", required: true }],
            metadata: { source: "test" },
          },
          binding: { sessionId: "session-owner", sessionSource: "daemon" },
        },
        { identity, signal },
      ),
    ).resolves.toEqual({ answered: true });
    expect(interact).toHaveBeenCalledOnce();
    expect(interact).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "ask-owner" }),
      expect.objectContaining({
        invocationId: "inv_owner",
        sessionId: "session-owner",
        signal,
      }),
    );

    await expect(
      owners.loopSchedule(
        {
          loopId: "loop-owner",
          generation: 4,
          schedule: { delayMs: 500, reason: "fixture" },
        },
        { identity },
      ),
    ).resolves.toEqual({ scheduled: true });
    await expect(
      owners.loopStop({ loopId: "loop-owner", reason: "done" }, { identity }),
    ).resolves.toEqual({ stopped: true });
    expect(scheduleLoop).toHaveBeenCalledOnce();
    expect(stopLoop).toHaveBeenCalledOnce();
    db.close();
  });
});
