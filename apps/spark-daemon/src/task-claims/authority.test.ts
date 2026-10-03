import { describe, expect, it } from "vitest";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { acquireMainTaskClaim, recoverTaskClaim, releaseMainTaskClaim } from "./authority.ts";
import {
  attachTaskClaimTestSession,
  loadedTaskClaimTestTask,
  taskClaimTestNow,
  withTaskClaimTestContext,
} from "./test-support.ts";

async function expectCode(run: () => Promise<unknown>, code: string) {
  await expect(run()).rejects.toMatchObject({ code });
}

describe("daemon task claim authority", () => {
  it("acquires through a fenced lease and rejects stale fences", async () => {
    await withTaskClaimTestContext(async (context) => {
      const lease = attachTaskClaimTestSession(context, "session:one", taskClaimTestNow);
      const acquired = await acquireMainTaskClaim(
        context.db,
        { ...lease, taskRef: context.task.ref },
        taskClaimTestNow,
      );

      expect(acquired).toMatchObject({ outcome: "acquired", sessionId: "session:one" });
      expect((await loadedTaskClaimTestTask(context))?.claim?.sessionId).toBe("session:one");
      await expectCode(
        () =>
          acquireMainTaskClaim(
            context.db,
            { ...lease, leaseFence: "stale", taskRef: context.task.ref },
            taskClaimTestNow,
          ),
        "task_claim_lease_invalid",
      );
    });
  });

  it.each(["pending", "ready", "running", "blocked"] as const)(
    "atomically preserves the requested %s status",
    async (status) => {
      await withTaskClaimTestContext(async (context) => {
        const lease = attachTaskClaimTestSession(context, `session:${status}`, taskClaimTestNow);
        await acquireMainTaskClaim(
          context.db,
          { ...lease, taskRef: context.task.ref, status },
          taskClaimTestNow,
        );

        expect(await loadedTaskClaimTestTask(context)).toMatchObject({
          status,
          claim: { kind: "main", sessionId: `session:${status}` },
        });
      });
    },
  );

  it("lets another fresh client for the same session renew without reassigning", async () => {
    await withTaskClaimTestContext(async (context) => {
      const first = attachTaskClaimTestSession(context, "session:one", taskClaimTestNow);
      const firstResult = await acquireMainTaskClaim(
        context.db,
        { ...first, taskRef: context.task.ref },
        taskClaimTestNow,
      );
      const secondNow = "2026-07-29T00:01:00.000Z";
      const second = attachTaskClaimTestSession(context, "session:one", secondNow);
      const secondResult = await acquireMainTaskClaim(
        context.db,
        { ...second, taskRef: context.task.ref },
        secondNow,
      );

      expect(second.clientId).not.toBe(first.clientId);
      expect(secondResult.claim?.claimedAt).toBe(firstResult.claim?.claimedAt);
      expect(secondResult.claim?.heartbeatAt).toBe(secondNow);
    });
  });

  it("finishes through the current fenced session and rejects stale release fences", async () => {
    await withTaskClaimTestContext(async (context) => {
      const lease = attachTaskClaimTestSession(context, "session:one", taskClaimTestNow);
      await acquireMainTaskClaim(
        context.db,
        { ...lease, taskRef: context.task.ref },
        taskClaimTestNow,
      );
      await expectCode(
        () =>
          releaseMainTaskClaim(
            context.db,
            { ...lease, leaseFence: "stale", taskRef: context.task.ref, disposition: "done" },
            taskClaimTestNow,
          ),
        "task_claim_lease_invalid",
      );
      const released = await releaseMainTaskClaim(
        context.db,
        { ...lease, taskRef: context.task.ref, disposition: "done" },
        taskClaimTestNow,
      );

      expect(released).toMatchObject({ outcome: "released", changed: true });
      expect(await loadedTaskClaimTestTask(context)).toMatchObject({ status: "done" });
      expect((await loadedTaskClaimTestTask(context))?.claim).toBeUndefined();
    });
  });

  it("keeps role-run claims outside main claim release authority", async () => {
    await withTaskClaimTestContext(async (context) => {
      const lease = attachTaskClaimTestSession(context, "session:one", taskClaimTestNow);
      await acquireMainTaskClaim(
        context.db,
        { ...lease, taskRef: context.task.ref },
        taskClaimTestNow,
      );
      const graph = await defaultTaskGraphStore(context.root).load();
      expect(graph).toBeTruthy();
      const mainClaim = graph!.getTask(context.task.ref).claim!;
      graph!.updateTask(context.task.ref, {
        claim: {
          ...mainClaim,
          kind: "role-run",
          claimedBy: "role:worker",
          sessionId: "session:parent",
          runName: "worker-run",
        },
      });
      await defaultTaskGraphStore(context.root).save(graph!);

      await expectCode(
        () =>
          releaseMainTaskClaim(
            context.db,
            { ...lease, taskRef: context.task.ref, disposition: "cancelled" },
            taskClaimTestNow,
          ),
        "task_claim_conflict",
      );
      expect((await loadedTaskClaimTestTask(context))?.claim).toMatchObject({
        kind: "role-run",
        claimedBy: "role:worker",
      });
    });
  });

  it("recovers an expired role-run claim after its session is inactive", async () => {
    await withTaskClaimTestContext(async (context) => {
      const graph = await defaultTaskGraphStore(context.root).load();
      expect(graph).toBeTruthy();
      const roleTask = graph!.createTask({
        projectRef: context.project.ref,
        title: "Role-run recovery task",
        description: "Verify expired role-run claims can be recovered by a new session.",
        status: "ready",
        plan: {
          objective: "Recover one expired role-run claim through daemon claim authority.",
          contextRefs: ["apps/spark-daemon/src/task-claims/authority.ts"],
          constraints: ["Require bound recovery Evidence and an inactive previous session."],
          nonGoals: ["Do not change main claim acquisition semantics."],
          openQuestions: [],
          askRefs: [],
          successCriteria: ["The role-run claim is released and recovery reports changed=true."],
          evidenceRequired: ["Focused authority test passes with bound recovery Evidence."],
          steps: ["Claim the task as a role-run, authorize recovery, then verify release."],
        },
      });
      const claimed = graph!.claimTask(roleTask.ref, {
        kind: "role-run",
        runName: "claim-recovery",
        claimedBy: "session:task-run",
        sessionId: "session:task-run",
        roleRef: "role:worker",
        leaseMs: 1,
        now: taskClaimTestNow,
      });
      await defaultTaskGraphStore(context.root).save(graph!);
      const recoveryNow = "2026-07-29T00:02:00.000Z";
      const lease = attachTaskClaimTestSession(context, "session:new", recoveryNow);
      const evidence = await defaultEvidenceStore(context.root).put({
        kind: "record",
        title: "Role-run claim recovery",
        format: "json",
        body: {
          action: "authorize_task_claim_recovery",
          taskRef: roleTask.ref,
          recoveredBy: "session:new",
          previousClaim: {
            roleRef: claimed.claim!.roleRef ?? null,
            runName: claimed.claim!.runName ?? null,
            runRef: claimed.claim!.runRef ?? null,
            kind: claimed.claim!.kind,
            claimedBy: claimed.claim!.claimedBy,
            sessionId: claimed.claim!.sessionId ?? null,
            claimedAt: claimed.claim!.claimedAt,
            heartbeatAt: claimed.claim!.heartbeatAt,
            expiresAt: claimed.claim!.expiresAt,
          },
          decision: { reason: "claim_expired" },
        },
        provenance: { producer: "task", taskRef: roleTask.ref },
      });

      const recovered = await recoverTaskClaim(
        context.db,
        {
          ...lease,
          taskRef: roleTask.ref,
          previousSessionId: "session:task-run",
          reason: "claim_expired",
          evidenceRef: evidence.ref,
        },
        recoveryNow,
      );
      expect(recovered).toMatchObject({ outcome: "recovered", changed: true });
      expect(
        (await defaultTaskGraphStore(context.root).load())?.getTask(roleTask.ref).claim,
      ).toBeUndefined();
    });
  });

  it("recovers an expired claim only with bound evidence and no fresh old owner", async () => {
    await withTaskClaimTestContext(async (context) => {
      const graph = await defaultTaskGraphStore(context.root).load();
      expect(graph).toBeTruthy();
      const claimed = graph!.claimTask(context.task.ref, {
        kind: "main",
        claimedBy: "session:old",
        sessionId: "session:old",
        leaseMs: 1,
        now: taskClaimTestNow,
      });
      await defaultTaskGraphStore(context.root).save(graph!);
      const recoveryNow = "2026-07-29T00:02:00.000Z";
      const lease = attachTaskClaimTestSession(context, "session:new", recoveryNow);
      const evidence = await defaultEvidenceStore(context.root).put({
        kind: "record",
        title: "Claim recovery",
        format: "json",
        body: {
          action: "authorize_task_claim_recovery",
          taskRef: context.task.ref,
          recoveredBy: "session:new",
          previousClaim: {
            roleRef: claimed.claim!.roleRef ?? null,
            runName: claimed.claim!.runName ?? null,
            runRef: claimed.claim!.runRef ?? null,
            kind: claimed.claim!.kind,
            claimedBy: claimed.claim!.claimedBy,
            sessionId: claimed.claim!.sessionId ?? null,
            claimedAt: claimed.claim!.claimedAt,
            heartbeatAt: claimed.claim!.heartbeatAt,
            expiresAt: claimed.claim!.expiresAt,
          },
          decision: { reason: "claim_expired" },
        },
        provenance: { producer: "task", taskRef: context.task.ref },
      });

      const recovered = await recoverTaskClaim(
        context.db,
        {
          ...lease,
          taskRef: context.task.ref,
          previousSessionId: "session:old",
          reason: "claim_expired",
          evidenceRef: evidence.ref,
        },
        recoveryNow,
      );
      expect(recovered).toMatchObject({ outcome: "recovered", changed: true });
      expect((await loadedTaskClaimTestTask(context))?.claim).toBeUndefined();
    });
  });
});
