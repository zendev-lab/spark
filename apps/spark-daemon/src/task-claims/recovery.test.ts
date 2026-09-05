import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { acquireMainTaskClaim, recoverTaskClaim } from "./authority.ts";
import {
  attachTaskClaimTestSession,
  loadedTaskClaimTestTask,
  taskClaimTestNow,
  withTaskClaimTestContext,
} from "./test-support.ts";

const recoveryNow = "2026-07-29T00:02:00.000Z";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(recoveryNow));
});
afterEach(() => vi.useRealTimers());

for (const entry of ["recover-main", "recover-role-run", "acquire"] as const) {
  describe(entry, () => {
    it.each([
      "unchanged",
      "legacy-owner",
      "reclaimed",
      "renewed",
      "owner-connected",
      "wrong-evidence-owner",
      "wrong-task",
      "wrong-reason",
      "missing-claim",
      "within-grace",
      "stale-fence",
    ] as const)("handles %s recovery without releasing unrelated work", async (scenario) => {
      await withTaskClaimTestContext(async (context) => {
        const store = defaultTaskGraphStore(context.root);
        let graph = (await store.load())!;
        const task = graph.claimTask(context.task.ref, {
          kind: "main",
          claimedBy: "session:old",
          sessionId: "session:old",
          leaseMs: scenario === "within-grace" ? 60_000 : 1,
          now: taskClaimTestNow,
        });
        const claim = {
          ...task.claim!,
          sessionId: scenario === "legacy-owner" ? undefined : "session:old",
          ...(entry === "recover-role-run"
            ? {
                kind: "role-run" as const,
                claimedBy: scenario === "legacy-owner" ? "session:old" : "role:worker",
                runName: "worker-run",
              }
            : {}),
        };
        graph.updateTask(task.ref, { claim });
        await store.save(graph);
        const lease = attachTaskClaimTestSession(context, "session:new", recoveryNow);
        const evidence = await defaultEvidenceStore(context.root).put({
          kind: "record",
          title: "Claim recovery authorization",
          format: "json",
          body: {
            action: "authorize_task_claim_recovery",
            taskRef: scenario === "wrong-task" ? "task:other" : task.ref,
            recoveredBy: scenario === "wrong-evidence-owner" ? "session:other" : lease.sessionId,
            previousClaim: {
              ...claim,
              sessionId: claim.sessionId ?? null,
              roleRef: claim.roleRef ?? null,
              runName: claim.runName ?? null,
              runRef: claim.runRef ?? null,
            },
            decision: { reason: scenario === "wrong-reason" ? "other" : "claim_expired" },
          },
          provenance: { producer: "task", taskRef: task.ref },
        });
        graph = (await store.load())!;
        if (scenario === "reclaimed" || scenario === "renewed") {
          graph.updateTask(task.ref, {
            claim: {
              ...claim,
              claimedAt: scenario === "reclaimed" ? "2026-07-29T00:00:01.000Z" : claim.claimedAt,
              heartbeatAt: "2026-07-29T00:00:01.000Z",
              expiresAt: "2026-07-29T00:00:02.000Z",
            },
          });
          await store.save(graph);
        }
        if (scenario === "missing-claim") {
          graph.releaseTaskClaim(task.ref);
          await store.save(graph);
        }
        if (scenario === "owner-connected") {
          attachTaskClaimTestSession(context, "session:old", recoveryNow);
        }
        const before = await loadedTaskClaimTestTask(context);
        const recovery = {
          previousSessionId: "session:old",
          reason: "claim_expired" as const,
          evidenceRef: evidence.ref,
        };
        const input = {
          ...lease,
          taskRef: task.ref,
          ...(scenario === "stale-fence" ? { leaseFence: "stale" } : {}),
        };
        const run = () =>
          entry === "acquire"
            ? acquireMainTaskClaim(context.db, { ...input, recovery }, recoveryNow)
            : recoverTaskClaim(context.db, { ...input, ...recovery }, recoveryNow);
        if (scenario === "unchanged" || scenario === "legacy-owner") {
          await expect(run()).resolves.toMatchObject({ changed: true });
          const after = await loadedTaskClaimTestTask(context);
          if (entry === "acquire") expect(after?.claim?.sessionId).toBe("session:new");
          else expect(after?.claim).toBeUndefined();
          await expect(run()).rejects.toMatchObject({ code: "task_claim_recovery_refused" });
          expect(await loadedTaskClaimTestTask(context)).toEqual(after);
        } else {
          await expect(run()).rejects.toMatchObject({
            code:
              scenario === "stale-fence"
                ? "task_claim_lease_invalid"
                : "task_claim_recovery_refused",
          });
          expect(await loadedTaskClaimTestTask(context)).toEqual(before);
        }
      });
    });
  });
}
