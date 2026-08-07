import { describe, expect, it } from "vitest";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { ExecutionAttemptStore } from "../execution/state.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { releaseWorkspaceClient } from "../store/workspaces.ts";
import { acquireMainTaskClaim } from "./authority.ts";
import { MAIN_TASK_CLAIM_EXPIRY_GRACE_MS, MAIN_TASK_CLAIM_LEASE_MS } from "./policy.ts";
import { reconcileMainTaskClaims } from "./reconciler.ts";
import {
  attachTaskClaimTestSession,
  loadedTaskClaimTestTask,
  taskClaimTestNow,
  withTaskClaimTestContext,
} from "./test-support.ts";

function after(ms: number): string {
  return new Date(Date.parse(taskClaimTestNow) + ms).toISOString();
}

describe("daemon main task claim reconciler", () => {
  it("keeps Task Claim session-owned across execution attempt replacement", async () => {
    await withTaskClaimTestContext(async (context) => {
      const lease = attachTaskClaimTestSession(context, "session:attempt-owner", taskClaimTestNow);
      await acquireMainTaskClaim(
        context.db,
        { ...lease, taskRef: context.task.ref },
        taskClaimTestNow,
      );
      const invocationId = "inv_task_claim_attempt";
      new SparkInvocationStore(context.db).submit({
        invocationId,
        sessionId: "session:attempt-owner",
        prompt: "execute task",
        task: {
          type: "session.run",
          sessionId: "session:attempt-owner",
          prompt: "execute task",
        },
      });
      const attempts = new ExecutionAttemptStore(context.db);
      const first = attempts.create(invocationId, 1, "corr_task_claim", taskClaimTestNow);
      expect(
        attempts.crash(first, "process_spawn_failed", taskClaimTestNow).replacement,
      ).toMatchObject({ attemptEpoch: 2 });

      const reconciled = await reconcileMainTaskClaims(context.db, { now: taskClaimTestNow });
      expect(reconciled.expired).toEqual([]);
      expect((await loadedTaskClaimTestTask(context))?.claim).toMatchObject({
        kind: "main",
        sessionId: "session:attempt-owner",
      });
    });
  });

  it("revives a fresh session beyond the legacy ten-minute boundary", async () => {
    await withTaskClaimTestContext(async (context) => {
      const graph = await defaultTaskGraphStore(context.root).load();
      graph!.claimTask(context.task.ref, {
        kind: "main",
        claimedBy: "session:fresh",
        sessionId: "session:fresh",
        leaseMs: MAIN_TASK_CLAIM_LEASE_MS,
        now: taskClaimTestNow,
      });
      await defaultTaskGraphStore(context.root).save(graph!);
      const reconcileAt = after(10 * 60 * 1_000);
      attachTaskClaimTestSession(context, "session:fresh", reconcileAt);

      const result = await reconcileMainTaskClaims(context.db, { now: reconcileAt });

      expect(result.degraded).toEqual([]);
      expect(result.revived).toEqual([context.task.ref]);
      expect((await loadedTaskClaimTestTask(context))?.claim?.sessionId).toBe("session:fresh");
      expect((await loadedTaskClaimTestTask(context))?.claim?.expiresAt).toBe(
        after(10 * 60 * 1_000 + MAIN_TASK_CLAIM_LEASE_MS),
      );
    });
  });

  it("waits through claim TTL plus grace after the last client stops", async () => {
    await withTaskClaimTestContext(async (context) => {
      const lease = attachTaskClaimTestSession(context, "session:one", taskClaimTestNow);
      await acquireMainTaskClaim(
        context.db,
        { ...lease, taskRef: context.task.ref },
        taskClaimTestNow,
      );
      releaseWorkspaceClient(context.db, {
        clientId: lease.clientId,
        leaseFence: lease.leaseFence,
        now: taskClaimTestNow,
      });
      const beforeBoundary = after(MAIN_TASK_CLAIM_LEASE_MS + MAIN_TASK_CLAIM_EXPIRY_GRACE_MS - 1);
      const atBoundary = after(MAIN_TASK_CLAIM_LEASE_MS + MAIN_TASK_CLAIM_EXPIRY_GRACE_MS);

      const before = await reconcileMainTaskClaims(context.db, { now: beforeBoundary });
      expect(before.expired).toEqual([]);
      expect((await loadedTaskClaimTestTask(context))?.claim).toBeTruthy();

      const afterBoundary = await reconcileMainTaskClaims(context.db, { now: atBoundary });
      expect(afterBoundary.expired).toEqual([context.task.ref]);
      expect((await loadedTaskClaimTestTask(context))?.claim).toBeUndefined();
      expect((await loadedTaskClaimTestTask(context))?.status).toBe("pending");
    });
  });

  it("defers expiry during startup recovery and never renews role-run claims", async () => {
    await withTaskClaimTestContext(async (context) => {
      const graph = await defaultTaskGraphStore(context.root).load();
      graph!.claimTask(context.task.ref, {
        kind: "main",
        claimedBy: "session:old",
        sessionId: "session:old",
        leaseMs: 1,
        now: taskClaimTestNow,
      });
      const roleTask = graph!.createTask({
        projectRef: context.project.ref,
        title: "Role task",
        description: "Keep role-run lifecycle independent.",
        status: "ready",
        plan: {
          objective: "Verify role-run claim isolation.",
          contextRefs: ["apps/spark-daemon/src/task-claims/reconciler.ts"],
          constraints: ["Do not renew role-run claims from UI liveness."],
          nonGoals: ["Do not change role-run execution lifecycle."],
          openQuestions: [],
          askRefs: [],
          successCriteria: ["Daemon main reconciler leaves the role-run claim unchanged."],
          evidenceRequired: ["Focused reconciler test passes."],
          steps: ["Inspect role-run claim after reconciliation."],
        },
      });
      graph!.claimTask(roleTask.ref, {
        kind: "role-run",
        claimedBy: "role:worker",
        sessionId: "session:role-run",
        runName: "worker",
        leaseMs: 1,
        now: taskClaimTestNow,
      });
      await defaultTaskGraphStore(context.root).save(graph!);
      const reconcileAt = after(MAIN_TASK_CLAIM_EXPIRY_GRACE_MS + 1_000);

      const deferred = await reconcileMainTaskClaims(context.db, {
        now: reconcileAt,
        startupRecoveryUntil: after(MAIN_TASK_CLAIM_EXPIRY_GRACE_MS + 2_000),
      });
      expect(deferred.expired).toEqual([]);

      const settled = await reconcileMainTaskClaims(context.db, { now: reconcileAt });
      expect(settled.expired).toEqual([context.task.ref]);
      expect(settled.skippedRoleRun).toContain(roleTask.ref);
      expect(
        (await defaultTaskGraphStore(context.root).load())?.getTask(roleTask.ref).claim,
      ).toBeTruthy();
    });
  });
});
