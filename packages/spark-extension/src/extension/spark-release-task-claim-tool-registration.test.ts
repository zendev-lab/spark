import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nowIso, type TaskRef } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import { registerSparkReleaseTaskClaimTool } from "./spark-release-task-claim-tool-registration.ts";
import { saveCurrentProjectRef, sparkSessionKey, sparkStateCwd } from "./session-state.ts";
import type { SparkTaskClaimDaemonClient } from "./spark-task-claim-daemon-client.ts";
import type { SparkRegisteredToolConfig, SparkToolContext } from "./spark-tool-registration.ts";

function testContext(cwd: string): SparkToolContext {
  const sessionId = "session:release-contract";
  return {
    cwd,
    sessionId,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "session.json"),
      isPersisted: () => true,
    },
  };
}

function captureReleaseTool(daemon: SparkTaskClaimDaemonClient): SparkRegisteredToolConfig {
  let tool: SparkRegisteredToolConfig | undefined;
  registerSparkReleaseTaskClaimTool(
    (registered) => {
      tool = registered;
    },
    {
      refreshSparkWidget: async () => undefined,
      taskClaimDaemonClient: daemon,
    },
  );
  expect(tool).toBeTruthy();
  return tool!;
}

async function createClaimedTask(cwd: string, ctx: SparkToolContext) {
  const sessionKey = sparkSessionKey(ctx);
  const stateCwd = sparkStateCwd(cwd, ctx);
  const store = defaultTaskGraphStore(stateCwd);
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Release contract",
    description: "Daemon-owned claim release",
  });
  const task = graph.createTask({
    projectRef: project.ref,
    name: "release-target",
    title: "Release target",
    description: "Release without finishing",
    status: "running",
  });
  graph.claimTask(task.ref, {
    kind: "main",
    claimedBy: sessionKey,
    sessionId: sessionKey,
    leaseMs: 60_000,
  });
  graph.setCurrentTask(project.ref, task.ref);
  await store.save(graph);
  await saveCurrentProjectRef(cwd, ctx, project.ref, task.ref);
  return { store, project, task, sessionKey };
}

describe("task claim release authority", () => {
  it("routes release through daemon authority and verifies the unclaimed projection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-release-daemon-"));
    try {
      const ctx = testContext(cwd);
      const { store, project, task, sessionKey } = await createClaimedTask(cwd, ctx);
      const calls: TaskRef[] = [];
      const daemon: SparkTaskClaimDaemonClient = {
        acquire: async () => {
          throw new Error("not used");
        },
        recover: async () => {
          throw new Error("not used");
        },
        release: async (_ctx, input) => {
          calls.push(input.taskRef as TaskRef);
          await store.update((graph) => graph.releaseTaskClaim(input.taskRef as TaskRef));
          return {
            taskRef: input.taskRef,
            projectRef: project.ref,
            sessionId: sessionKey,
            outcome: "released",
            changed: true,
            observedAt: nowIso(),
          } as Awaited<ReturnType<SparkTaskClaimDaemonClient["release"]>>;
        },
      };
      const tool = captureReleaseTool(daemon);

      const result = await tool.execute(
        "release-call",
        { taskRef: task.ref },
        new AbortController().signal,
        () => undefined,
        ctx,
      );

      expect(calls).toEqual([task.ref]);
      expect(result.details).toMatchObject({ committed: true });
      expect((await store.load())?.getTask(task.ref)).toMatchObject({
        status: "pending",
        claim: undefined,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when daemon reports success without releasing the persisted claim", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-release-projection-"));
    try {
      const ctx = testContext(cwd);
      const { project, task, sessionKey } = await createClaimedTask(cwd, ctx);
      const tool = captureReleaseTool({
        acquire: async () => {
          throw new Error("not used");
        },
        recover: async () => {
          throw new Error("not used");
        },
        release: async () =>
          ({
            taskRef: task.ref,
            projectRef: project.ref,
            sessionId: sessionKey,
            outcome: "released",
            changed: true,
            observedAt: nowIso(),
          }) as Awaited<ReturnType<SparkTaskClaimDaemonClient["release"]>>,
      });

      const result = await tool.execute(
        "release-call",
        { taskRef: task.ref },
        new AbortController().signal,
        () => undefined,
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        error: "daemon_release_projection_mismatch",
        authorityAccepted: true,
        committed: true,
        projectionVerified: false,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
