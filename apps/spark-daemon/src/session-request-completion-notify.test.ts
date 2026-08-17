import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type { SparkSessionProjection } from "@zendev-lab/spark-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  notifySessionRequestCompletion,
  reconcileSessionRequestCompletions,
  SESSION_REQUEST_COMPLETION_SOURCE_KIND,
} from "./session-request-completion-notify.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import { SessionRequestCompletionDeliveryStore } from "./store/session-request-completion-deliveries.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import { workspaceSessionRecord } from "../../../test/support/session-fixtures.ts";

describe("session request completion notify", () => {
  it("submits one durable sender continuation for wake=true request completions", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender", harness.cwd);
    const target = localSession("sess_target", harness.cwd);
    const recordTurnQueued = vi.fn(async () => sender);
    const modelControl = {
      effectiveModel: vi.fn(async () => ({ providerName: "provider", modelId: "model" })),
      effectiveThinkingLevel: vi.fn(async () => "medium" as const),
      prepareModel: vi.fn(async () => undefined),
    };

    const source = harness.store.submit({
      sessionId: target.sessionId,
      prompt: "do delegated work",
      task: {
        type: "session.run",
        sessionId: target.sessionId,
        prompt: "do delegated work",
        cwd: harness.cwd,
        messageMetadata: {
          sessionMail: {
            messageId: "mail:req-1",
            kind: "request",
            intent: "work.request",
            fromSessionId: sender.sessionId,
            toSessionId: target.sessionId,
            wake: true,
          },
        },
      },
    });

    try {
      await expect(
        notifySessionRequestCompletion(
          {
            invocationStore: harness.store,
            sessionRegistry: completionRegistry(
              async (sessionId) => (sessionId === sender.sessionId ? sender : target),
              recordTurnQueued,
            ),
            modelControl,
          },
          {
            invocation: source,
            task: source.task as never,
            completion: {
              status: "succeeded",
              result: { assistantText: "investigation complete" },
            },
          },
        ),
      ).resolves.toMatchObject({ submitted: true });

      const [wake] = harness.store.listPendingForSession(sender.sessionId);
      expect(wake).toMatchObject({
        status: "queued",
        sourceKind: SESSION_REQUEST_COMPLETION_SOURCE_KIND,
        sourceRef: source.invocationId,
        task: {
          type: "session.run",
          sessionId: sender.sessionId,
          cwd: harness.cwd,
          model: "provider/model",
          thinkingLevel: "medium",
          actor: "spark-daemon-session-request-completion",
          messageMetadata: {
            sessionRequestCompletion: {
              sourceInvocationId: source.invocationId,
              sourceSessionId: target.sessionId,
              messageId: "mail:req-1",
              status: "succeeded",
            },
          },
        },
      });
      expect(recordTurnQueued).toHaveBeenCalledWith(sender.sessionId);

      await expect(
        notifySessionRequestCompletion(
          {
            invocationStore: harness.store,
            sessionRegistry: completionRegistry(
              async (sessionId) => (sessionId === sender.sessionId ? sender : target),
              recordTurnQueued,
            ),
          },
          {
            invocation: source,
            task: source.task as never,
            completion: {
              status: "succeeded",
              result: { assistantText: "investigation complete" },
            },
          },
        ),
      ).resolves.toMatchObject({ submitted: false, skippedReason: "already_notified" });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it("skips wake when wake is false", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender", harness.cwd);
    const target = localSession("sess_target", harness.cwd);
    const source = harness.store.submit({
      sessionId: target.sessionId,
      prompt: "blocking request",
      task: {
        type: "session.run",
        sessionId: target.sessionId,
        prompt: "blocking request",
        messageMetadata: {
          sessionMail: {
            messageId: "mail:req-2",
            kind: "request",
            fromSessionId: sender.sessionId,
            toSessionId: target.sessionId,
            wake: false,
          },
        },
      },
    });

    try {
      await expect(
        notifySessionRequestCompletion(
          {
            invocationStore: harness.store,
            sessionRegistry: completionRegistry(async (sessionId) =>
              sessionId === sender.sessionId ? sender : target,
            ),
          },
          {
            invocation: source,
            task: source.task as never,
            completion: { status: "succeeded", result: { assistantText: "done" } },
          },
        ),
      ).resolves.toMatchObject({ submitted: false, skippedReason: "notify_disabled" });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("still wakes in-flight tasks that only persist notifyOnCompletion", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender", harness.cwd);
    const target = localSession("sess_target", harness.cwd);
    const source = harness.store.submit({
      sessionId: target.sessionId,
      prompt: "legacy request",
      task: {
        type: "session.run",
        sessionId: target.sessionId,
        prompt: "legacy request",
        cwd: harness.cwd,
        messageMetadata: {
          sessionMail: {
            messageId: "mail:req-legacy",
            kind: "request",
            fromSessionId: sender.sessionId,
            toSessionId: target.sessionId,
            notifyOnCompletion: true,
          },
        },
      },
    });

    try {
      await expect(
        notifySessionRequestCompletion(
          {
            invocationStore: harness.store,
            sessionRegistry: completionRegistry(async (sessionId) =>
              sessionId === sender.sessionId ? sender : target,
            ),
          },
          {
            invocation: source,
            task: source.task as never,
            completion: { status: "succeeded", result: { assistantText: "legacy done" } },
          },
        ),
      ).resolves.toMatchObject({ submitted: true });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it("lets explicit wake=false win over notifyOnCompletion=true", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender", harness.cwd);
    const target = localSession("sess_target", harness.cwd);
    const source = harness.store.submit({
      sessionId: target.sessionId,
      prompt: "explicit false",
      task: {
        type: "session.run",
        sessionId: target.sessionId,
        prompt: "explicit false",
        messageMetadata: {
          sessionMail: {
            messageId: "mail:req-wake-wins",
            kind: "request",
            fromSessionId: sender.sessionId,
            toSessionId: target.sessionId,
            wake: false,
            notifyOnCompletion: true,
          },
        },
      },
    });

    try {
      await expect(
        notifySessionRequestCompletion(
          {
            invocationStore: harness.store,
            sessionRegistry: completionRegistry(async (sessionId) =>
              sessionId === sender.sessionId ? sender : target,
            ),
          },
          {
            invocation: source,
            task: source.task as never,
            completion: { status: "succeeded", result: { assistantText: "done" } },
          },
        ),
      ).resolves.toMatchObject({ submitted: false, skippedReason: "notify_disabled" });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("rechecks admission after model preparation before durably submitting the wake", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender", harness.cwd);
    const target = localSession("sess_target", harness.cwd);
    const recordTurnQueued = vi.fn(async () => sender);
    const source = harness.store.submit({
      sessionId: target.sessionId,
      prompt: "delegated work",
      task: requestMailTask(sender.sessionId, target.sessionId, true),
    });
    const canAdmit = vi.fn(() => canAdmit.mock.calls.length === 1);

    try {
      await expect(
        notifySessionRequestCompletion(
          {
            invocationStore: harness.store,
            sessionRegistry: completionRegistry(
              async (sessionId) => (sessionId === sender.sessionId ? sender : target),
              recordTurnQueued,
            ),
            modelControl: {
              effectiveModel: async () => ({ providerName: "provider", modelId: "model" }),
              effectiveThinkingLevel: async () => "low" as const,
              prepareModel: async () => undefined,
            },
            canAdmit,
          },
          {
            invocation: source,
            task: source.task as never,
            completion: { status: "succeeded", result: { assistantText: "done" } },
          },
        ),
      ).resolves.toEqual({ submitted: false, skippedReason: "admission_closed" });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(0);
      expect(recordTurnQueued).not.toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });

  it("persists one completion mail and retries sender wake after restart or unavailability", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender_retry", harness.cwd);
    const target = localSession("sess_target_retry", harness.cwd);
    const mailStore = new SparkSessionMailStore({ sparkHome: harness.cwd });
    const deliveryStore = new SessionRequestCompletionDeliveryStore(harness.db);
    const source = harness.store.submit({
      sessionId: target.sessionId,
      prompt: "delegated work",
      task: requestMailTask(sender.sessionId, target.sessionId, true),
    });
    harness.store.claimNext("completion-worker");
    harness.store.complete(source.invocationId, {
      status: "succeeded",
      result: { assistantText: "durable result" },
    });
    deliveryStore.enqueue(source.invocationId);
    deliveryStore.enqueue(source.invocationId);
    let senderAvailable = false;
    const recordTurnQueued = vi.fn(async () => sender);
    const deps = {
      invocationStore: harness.store,
      deliveryStore,
      mailStore,
      sessionRegistry: completionRegistry(
        async (sessionId: string) =>
          sessionId === sender.sessionId ? (senderAvailable ? sender : undefined) : target,
        recordTurnQueued,
      ),
    };

    try {
      await expect(reconcileSessionRequestCompletions(deps)).resolves.toEqual({
        attempted: 1,
        delivered: 0,
        failed: 1,
      });
      expect(await mailStore.list(sender.sessionId, { includeAcked: true })).toHaveLength(1);
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(0);

      senderAvailable = true;
      const restartedStore = new SessionRequestCompletionDeliveryStore(harness.db);
      await expect(
        reconcileSessionRequestCompletions({ ...deps, deliveryStore: restartedStore }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0 });
      expect(await mailStore.list(sender.sessionId, { includeAcked: true })).toHaveLength(1);
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(1);
      expect(recordTurnQueued).toHaveBeenCalledOnce();

      await expect(
        reconcileSessionRequestCompletions({ ...deps, deliveryStore: restartedStore }),
      ).resolves.toEqual({ attempted: 0, delivered: 0, failed: 0 });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(1);
      expect(recordTurnQueued).toHaveBeenCalledOnce();
    } finally {
      harness.close();
    }
  });

  it("retries a persisted wake when its Session admission fence fails", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender_wake_retry", harness.cwd);
    const target = localSession("sess_target_wake_retry", harness.cwd);
    const mailStore = new SparkSessionMailStore({ sparkHome: harness.cwd });
    const deliveryStore = new SessionRequestCompletionDeliveryStore(harness.db);
    const source = harness.store.submit({
      sessionId: target.sessionId,
      prompt: "delegated work",
      task: requestMailTask(sender.sessionId, target.sessionId, true),
    });
    harness.store.claimNext("completion-worker");
    harness.store.complete(source.invocationId, {
      status: "succeeded",
      result: { assistantText: "done" },
    });
    deliveryStore.enqueue(source.invocationId);
    let failWake = true;
    const recordTurnQueued = vi.fn(async () => {
      if (failWake) throw new Error("sender unavailable");
      return sender;
    });
    const deps = {
      invocationStore: harness.store,
      deliveryStore,
      mailStore,
      sessionRegistry: completionRegistry(async () => sender, recordTurnQueued),
    };

    try {
      await expect(reconcileSessionRequestCompletions(deps)).resolves.toEqual({
        attempted: 1,
        delivered: 0,
        failed: 1,
      });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(0);
      failWake = false;
      await expect(reconcileSessionRequestCompletions(deps)).resolves.toEqual({
        attempted: 1,
        delivered: 1,
        failed: 0,
      });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(1);
      expect(await mailStore.list(sender.sessionId, { includeAcked: true })).toHaveLength(1);
      expect(recordTurnQueued).toHaveBeenCalledTimes(2);
    } finally {
      harness.close();
    }
  });

  it("atomically claims one delivery across two reconcilers and delivers side effects once", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender_concurrent", harness.cwd);
    const target = localSession("sess_target_concurrent", harness.cwd);
    const mailStore = new SparkSessionMailStore({ sparkHome: harness.cwd });
    const firstStore = new SessionRequestCompletionDeliveryStore(harness.db);
    const secondStore = new SessionRequestCompletionDeliveryStore(harness.db);
    const source = completedRequest(harness, sender.sessionId, target.sessionId, "concurrent");
    firstStore.enqueue(source.invocationId);
    let senderWakeCount = 0;
    const deps = {
      invocationStore: harness.store,
      mailStore,
      sessionRegistry: completionRegistry(
        async () => sender,
        async () => {
          senderWakeCount += 1;
          return sender;
        },
      ),
    };

    try {
      const [first, second] = await Promise.all([
        reconcileSessionRequestCompletions({ ...deps, deliveryStore: firstStore }),
        reconcileSessionRequestCompletions({ ...deps, deliveryStore: secondStore }),
      ]);
      expect(first.attempted + second.attempted).toBe(1);
      expect(first.delivered + second.delivered).toBe(1);
      expect(await mailStore.list(sender.sessionId, { includeAcked: true })).toHaveLength(1);
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(1);
      expect(senderWakeCount).toBe(1);
      expect(firstStore.require(source.invocationId).status).toBe("delivered");
    } finally {
      harness.close();
    }
  });

  it("recovers an expired claim after restart without duplicating completion effects", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender_expired", harness.cwd);
    const target = localSession("sess_target_expired", harness.cwd);
    const mailStore = new SparkSessionMailStore({ sparkHome: harness.cwd });
    let now = new Date("2026-07-29T00:00:00.000Z");
    const firstStore = new SessionRequestCompletionDeliveryStore(harness.db, () => now);
    const source = completedRequest(harness, sender.sessionId, target.sessionId, "expired");
    firstStore.enqueue(source.invocationId);
    expect(firstStore.claim(source.invocationId, 1_000)?.status).toBe("processing");
    now = new Date("2026-07-29T00:00:02.000Z");
    const restartedStore = new SessionRequestCompletionDeliveryStore(harness.db, () => now);
    let senderWakeCount = 0;

    try {
      await expect(
        reconcileSessionRequestCompletions({
          invocationStore: harness.store,
          deliveryStore: restartedStore,
          mailStore,
          sessionRegistry: completionRegistry(
            async () => sender,
            async () => {
              senderWakeCount += 1;
              return sender;
            },
          ),
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0 });
      expect(await mailStore.list(sender.sessionId, { includeAcked: true })).toHaveLength(1);
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(1);
      expect(senderWakeCount).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("lets immediate notify and reconciliation race without duplicate target or wake execution", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender_immediate", harness.cwd);
    const target = localSession("sess_target_immediate", harness.cwd);
    const mailStore = new SparkSessionMailStore({ sparkHome: harness.cwd });
    const deliveryStore = new SessionRequestCompletionDeliveryStore(harness.db);
    const source = completedRequest(harness, sender.sessionId, target.sessionId, "immediate");
    deliveryStore.enqueue(source.invocationId);
    let senderWakeCount = 0;
    const deps = {
      invocationStore: harness.store,
      deliveryStore,
      mailStore,
      sessionRegistry: completionRegistry(
        async () => sender,
        async () => {
          senderWakeCount += 1;
          return sender;
        },
      ),
    };

    try {
      const [immediate, loop] = await Promise.all([
        reconcileSessionRequestCompletions(deps, 1, source.invocationId),
        reconcileSessionRequestCompletions(deps),
      ]);
      expect(immediate.attempted + loop.attempted).toBe(1);
      expect(await mailStore.list(sender.sessionId, { includeAcked: true })).toHaveLength(1);
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(1);
      expect(senderWakeCount).toBe(1);
      expect(deliveryStore.require(source.invocationId).status).toBe("delivered");
    } finally {
      harness.close();
    }
  });
});

function completionRegistry(
  get: (sessionId: string) => Promise<SparkSessionProjection | undefined>,
  beforeAdmission?: (sessionId: string) => Promise<unknown>,
) {
  return {
    get,
    commitInvocationAdmission: async (
      sessionId: string,
      admit: Parameters<DaemonSessionRegistry["commitInvocationAdmission"]>[1],
    ) => {
      const session = await get(sessionId);
      if (!session) throw new Error(`unknown test Session: ${sessionId}`);
      await beforeAdmission?.(sessionId);
      return admit(session);
    },
  };
}

function completedRequest(
  harness: ReturnType<typeof createHarness>,
  senderSessionId: string,
  targetSessionId: string,
  suffix: string,
) {
  const source = harness.store.submit({
    sessionId: targetSessionId,
    prompt: `delegated work ${suffix}`,
    task: requestMailTask(senderSessionId, targetSessionId, true),
  });
  harness.store.claimNext(`target-worker-${suffix}`);
  harness.store.complete(source.invocationId, {
    status: "succeeded",
    result: { assistantText: `done ${suffix}` },
  });
  return harness.store.require(source.invocationId);
}

function createHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "spark-session-request-completion-"));
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return {
    cwd,
    db,
    store: new SparkInvocationStore(db),
    close() {
      db.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function localSession(sessionId: string, cwd: string): SparkSessionProjection {
  return workspaceSessionRecord({
    sessionId,
    workspaceId: "workspace-test",
    cwd,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  });
}

function requestMailTask(fromSessionId: string, toSessionId: string, wake: boolean) {
  return {
    type: "session.run" as const,
    sessionId: toSessionId,
    prompt: "delegated work",
    messageMetadata: {
      sessionMail: {
        messageId: "mail:admission",
        kind: "request",
        fromSessionId,
        toSessionId,
        wake,
      },
    },
  };
}
