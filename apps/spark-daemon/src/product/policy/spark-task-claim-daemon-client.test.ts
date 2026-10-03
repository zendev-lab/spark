import { describe, expect, it, vi } from "vitest";
import type { SparkToolContext } from "./spark-tool-registration.ts";
import {
  createSparkTaskClaimDaemonClient,
  SparkDaemonSessionLeaseRequiredError,
} from "./spark-task-claim-daemon-client.ts";

describe("task claim daemon client session identity", () => {
  it("accepts a canonical lease for a raw persistent session id", async () => {
    const request = vi.fn(async () => ({ outcome: "acquired" }));
    const client = createSparkTaskClaimDaemonClient({ client: { request } as never });
    const lease = {
      workspaceId: "workspace-task",
      clientId: "client-task",
      sessionId: "session:sess_task_worker",
      leaseFence: "fence-task",
    };

    await client.acquire(
      {
        cwd: "/workspace",
        sessionId: "sess_task_worker",
        sessionLease: () => lease,
      } as SparkToolContext,
      { taskRef: "task:managed" },
    );

    expect(request).toHaveBeenCalledWith("task.claim.acquire", {
      ...lease,
      taskRef: "task:managed",
    });
  });

  it("rejects a lease fenced for another canonical session", async () => {
    const client = createSparkTaskClaimDaemonClient({
      client: { request: vi.fn() } as never,
    });

    await expect(
      client.acquire(
        {
          cwd: "/workspace",
          sessionId: "sess_task_worker",
          sessionLease: () => ({
            workspaceId: "workspace-task",
            clientId: "client-task",
            sessionId: "session:other",
            leaseFence: "fence-task",
          }),
        } as SparkToolContext,
        { taskRef: "task:managed" },
      ),
    ).rejects.toBeInstanceOf(SparkDaemonSessionLeaseRequiredError);
  });
});
