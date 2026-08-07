import { describe, expect, it, vi } from "vitest";

import {
  attachTaskClaimTestSession,
  loadedTaskClaimTestTask,
  withTaskClaimTestContext,
} from "../task-claims/test-support.ts";
import type { ExecutionAttemptIdentity } from "./contract.ts";
import {
  EXECUTION_PARENT_CAPABILITIES,
  ExecutionParentCapabilityError,
  type ExecutionCapabilityDefinition,
} from "./capability-registry.ts";
import { createInProcessExecutionCapabilityRegistry } from "./owner-capabilities.ts";
import { createTaskClaimExecutionOwner } from "./task-claim-owner.ts";

const first: ExecutionAttemptIdentity & { correlationId: string } = {
  invocationId: "inv_capability",
  attemptEpoch: 1,
  daemonGeneration: 3,
  correlationId: "corr_capability",
};

describe("execution parent capability registry", () => {
  it("calls only registered daemon owners once", async () => {
    let current = first;
    const owners = {
      taskClaim: vi.fn(async () => ({ claimed: true })),
      humanInteraction: vi.fn(async () => ({ status: "answered" })),
      loopSchedule: vi.fn(async () => ({ status: "scheduled" })),
      loopStop: vi.fn(async () => ({ status: "stopped" })),
    };
    const registry = createInProcessExecutionCapabilityRegistry({
      currentAttempt: () => current,
      owners,
    });
    expect(registry.operations()).toEqual([...EXECUTION_PARENT_CAPABILITIES].sort());
    const requests = [
      ["task.claim", owners.taskClaim],
      ["human.interaction", owners.humanInteraction],
      ["loop.schedule", owners.loopSchedule],
      ["loop.stop", owners.loopStop],
    ] as const;
    for (const [operation, handler] of requests) {
      await registry.dispatch({
        identity: first,
        correlationId: first.correlationId,
        operation,
        request: { action: operation },
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        { action: operation },
        { identity: { invocationId: first.invocationId, attemptEpoch: 1, daemonGeneration: 3 } },
      );
    }
    current = { ...first, attemptEpoch: 2, correlationId: "corr_replacement" };
  });

  it("routes Task Claim through the existing daemon owner and keeps session ownership", async () => {
    await withTaskClaimTestContext(async (context) => {
      let current = first;
      const lease = attachTaskClaimTestSession(
        context,
        "session:capability",
        new Date().toISOString(),
      );
      const taskClaim = createTaskClaimExecutionOwner(context.db);
      const registry = createInProcessExecutionCapabilityRegistry({
        currentAttempt: () => current,
        owners: {
          taskClaim,
          humanInteraction: async () => ({}),
          loopSchedule: async () => ({}),
          loopStop: async () => ({}),
        },
      });
      await registry.dispatch({
        identity: first,
        correlationId: first.correlationId,
        operation: "task.claim",
        request: { action: "acquire", params: { ...lease, taskRef: context.task.ref } },
      });
      expect((await loadedTaskClaimTestTask(context))?.claim).toMatchObject({
        kind: "main",
        sessionId: "session:capability",
      });

      current = { ...first, attemptEpoch: 2, correlationId: "corr_replacement" };
      await expect(
        registry.dispatch({
          identity: first,
          correlationId: first.correlationId,
          operation: "task.claim",
          request: { action: "release", params: { ...lease, taskRef: context.task.ref } },
        }),
      ).rejects.toMatchObject({ code: "execution_capability_stale_attempt" });
      expect((await loadedTaskClaimTestTask(context))?.claim?.sessionId).toBe("session:capability");
    });
  });

  it("keeps Task Claim session ownership across replacement and rejects stale claim calls", async () => {
    let current = first;
    const sessionClaim = { sessionId: "session-interactive", taskRef: "task:example" };
    const owners = {
      taskClaim: vi.fn(async (request: Record<string, unknown>) => {
        if (request.action === "acquire") return sessionClaim;
        return sessionClaim;
      }),
      humanInteraction: vi.fn(async () => ({})),
      loopSchedule: vi.fn(async () => ({})),
      loopStop: vi.fn(async () => ({})),
    };
    const registry = createInProcessExecutionCapabilityRegistry({
      currentAttempt: () => current,
      owners,
    });
    expect(
      await registry.dispatch({
        identity: first,
        correlationId: first.correlationId,
        operation: "task.claim",
        request: { action: "acquire", sessionId: sessionClaim.sessionId },
      }),
    ).toEqual(sessionClaim);

    current = { ...first, attemptEpoch: 2, correlationId: "corr_replacement" };
    expect(sessionClaim).toEqual({ sessionId: "session-interactive", taskRef: "task:example" });
    await expect(
      registry.dispatch({
        identity: first,
        correlationId: first.correlationId,
        operation: "task.claim",
        request: { action: "renew" },
      }),
    ).rejects.toMatchObject({ code: "execution_capability_stale_attempt" });
    expect(owners.taskClaim).toHaveBeenCalledOnce();
  });

  it.each(["file.read", "file.edit", "search.web", "external.command", "model.call"])(
    "denies unregistered ordinary operation %s",
    async (operation) => {
      const registry = createInProcessExecutionCapabilityRegistry({
        currentAttempt: () => first,
        owners: {
          taskClaim: async () => ({}),
          humanInteraction: async () => ({}),
          loopSchedule: async () => ({}),
          loopStop: async () => ({}),
        },
      });
      await expect(
        registry.dispatch({
          identity: first,
          correlationId: first.correlationId,
          operation,
          request: {},
        }),
      ).rejects.toMatchObject({ code: "execution_capability_denied" });
    },
  );

  it("rejects registration outside the closed capability set", () => {
    const registry = createInProcessExecutionCapabilityRegistry({
      currentAttempt: () => first,
      owners: {
        taskClaim: async () => ({}),
        humanInteraction: async () => ({}),
        loopSchedule: async () => ({}),
        loopStop: async () => ({}),
      },
    });
    expect(() =>
      registry.register({
        operation: "file.read",
        validate: () => ({}),
        handle: async () => ({}),
      } as unknown as ExecutionCapabilityDefinition),
    ).toThrowError(expect.objectContaining({ code: "execution_capability_registration_denied" }));
  });
});

expect(ExecutionParentCapabilityError).toBeDefined();
