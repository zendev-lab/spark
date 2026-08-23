import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { TaskGraph, defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { attachWorkspaceClient, registerWorkspace } from "../store/workspaces.ts";

export const taskClaimTestNow = "2026-07-29T00:00:00.000Z";

export type TaskClaimTestContext = Awaited<ReturnType<typeof createTaskClaimTestContext>>;

async function createTaskClaimTestContext() {
  const root = await mkdtemp(join(tmpdir(), "spark-task-claim-authority-"));
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const db = openSparkDaemonDatabase(paths);
  const workspace = registerWorkspace(db, { localPath: root, displayName: "Claim workspace" });
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Claim project",
    description: "Exercise daemon task claim authority.",
  });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Claim task",
    description: "Exercise daemon claim authority.",
    status: "ready",
  });
  await defaultTaskGraphStore(root).save(graph);
  return { root, db, workspace, task, project };
}

export async function withTaskClaimTestContext(
  run: (context: TaskClaimTestContext) => Promise<void>,
): Promise<void> {
  const context = await createTaskClaimTestContext();
  try {
    await run(context);
  } finally {
    context.db.close();
    await rm(context.root, { recursive: true, force: true });
  }
}

export function attachTaskClaimTestSession(
  context: TaskClaimTestContext,
  sessionId: string,
  now: string,
) {
  const client = attachWorkspaceClient(context.db, {
    workspaceId: context.workspace.id,
    kind: "interactive",
    sessionId,
    leaseTtlMs: 60_000,
    now,
  });
  expect(client.leaseFence).toBeTruthy();
  return {
    workspaceId: context.workspace.id,
    clientId: client.id,
    leaseFence: client.leaseFence!,
    sessionId,
  };
}

export async function loadedTaskClaimTestTask(context: TaskClaimTestContext) {
  return (await defaultTaskGraphStore(context.root).load())?.getTask(context.task.ref);
}
