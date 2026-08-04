import { describe, expect, it } from "vitest";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { releaseMainTaskClaim } from "./authority.ts";
import {
  attachTaskClaimTestSession,
  loadedTaskClaimTestTask,
  taskClaimTestNow,
  withTaskClaimTestContext,
} from "./test-support.ts";

async function expectCode(run: () => Promise<unknown>, code: string) {
  await expect(run()).rejects.toMatchObject({ code });
}

describe("daemon task terminal transition fencing", () => {
  it("rejects an unclaimed unfinished task instead of reporting an idempotent finish", async () => {
    await withTaskClaimTestContext(async (context) => {
      const lease = attachTaskClaimTestSession(context, "session:one", taskClaimTestNow);

      await expectCode(
        () =>
          releaseMainTaskClaim(
            context.db,
            { ...lease, taskRef: context.task.ref, disposition: "done" },
            taskClaimTestNow,
          ),
        "task_claim_conflict",
      );

      expect(await loadedTaskClaimTestTask(context)).toMatchObject({
        status: context.task.status,
        claim: undefined,
      });
    });
  });

  it("allows an exact terminal retry only when the authoritative task already matches", async () => {
    await withTaskClaimTestContext(async (context) => {
      const graph = await defaultTaskGraphStore(context.root).load();
      expect(graph).toBeTruthy();
      graph!.setTaskStatus(context.task.ref, "done");
      await defaultTaskGraphStore(context.root).save(graph!);
      const lease = attachTaskClaimTestSession(context, "session:one", taskClaimTestNow);

      const retried = await releaseMainTaskClaim(
        context.db,
        { ...lease, taskRef: context.task.ref, disposition: "done" },
        taskClaimTestNow,
      );

      expect(retried).toMatchObject({ changed: false, outcome: "released" });
      expect(await loadedTaskClaimTestTask(context)).toMatchObject({
        status: "done",
        claim: undefined,
      });
    });
  });
});
