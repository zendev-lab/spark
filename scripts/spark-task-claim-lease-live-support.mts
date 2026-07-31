/// <reference types="node" />
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { type TaskRef } from "@zendev-lab/spark-core";
import {
  createSparkDaemonClient,
  SparkDaemonRemoteError,
  type SparkDaemonClient,
} from "@zendev-lab/spark-daemon-client";
import { type SparkPaths } from "@zendev-lab/spark-system";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";

export interface LiveLease {
  workspaceId: string;
  clientId: string;
  leaseFence: string;
  sessionId: string;
}

export interface LiveCheck {
  passed: boolean;
  [key: string]: unknown;
}

export async function attachLiveLease(
  client: SparkDaemonClient,
  workspaceId: string,
  sessionId: string,
  clientId?: string,
): Promise<LiveLease> {
  const attached = await client.request("workspace.client.attach", {
    workspaceId,
    clientId,
    kind: "interactive",
    sessionId,
    displayName: "Task claim live harness",
    leaseTtlMs: 60_000,
    metadata: { surface: "live-harness" },
  });
  const leaseFence = attached.client.leaseFence;
  assert.ok(leaseFence);
  return { workspaceId, clientId: attached.client.id, leaseFence, sessionId };
}

export async function seedLiveTasks(workspaceRoot: string) {
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Task claim live",
    description: "Live daemon claim acceptance.",
  });
  const firstTask = graph.createTask(taskInput(project.ref, "Acquire and release"));
  const restartTask = graph.createTask(taskInput(project.ref, "Restart and reattach"));
  await defaultTaskGraphStore(workspaceRoot).save(graph);
  return { firstTask, restartTask };
}

export async function rejectStaleFence(
  client: SparkDaemonClient,
  lease: LiveLease,
  taskRef: string,
): Promise<LiveCheck> {
  try {
    await client.request("task.claim.acquire", {
      ...lease,
      leaseFence: "stale-fence",
      taskRef,
    });
    return { passed: false, taskRef, error: "stale fence was accepted" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof SparkDaemonRemoteError &&
      error.payload &&
      typeof error.payload === "object" &&
      "code" in error.payload
        ? error.payload.code
        : undefined;
    return { passed: code === "task_claim_lease_invalid", taskRef, code, error: message };
  }
}

export async function liveTaskStatus(workspaceRoot: string, taskRef: string) {
  return (await defaultTaskGraphStore(workspaceRoot).load())?.getTask(taskRef as TaskRef).status;
}

export interface LiveDaemonIdentity {
  pid: number;
  generation: string;
}

export async function waitForLiveDaemon(
  client: ReturnType<typeof createSparkDaemonClient>,
  paths: Pick<SparkPaths, "pidFile">,
  previous?: LiveDaemonIdentity,
): Promise<LiveDaemonIdentity> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const status = await client.request("daemon.status", {});
      const pid = Number((await readFile(paths.pidFile, "utf8")).trim());
      const processIdentity = status.lifecycle.process;
      if (
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        processIdentity?.pid === pid &&
        processIdentity.generation.length > 0 &&
        (!previous ||
          (processIdentity.pid !== previous.pid &&
            processIdentity.generation !== previous.generation))
      ) {
        return { pid, generation: processIdentity.generation };
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`daemon did not become ready${lastError ? `: ${errorText(lastError)}` : ""}`);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error) ?? "unknown error";
}

function taskInput(projectRef: `proj:${string}`, title: string) {
  const now = new Date().toISOString();
  const action = title.toLowerCase();
  return {
    projectRef,
    title,
    description: `Validate ${action} through the real daemon.`,
    status: "ready" as const,
    plan: {
      objective: `Validate ${action} through typed daemon RPC.`,
      contextRefs: ["apps/spark-daemon/src/task-claims/authority.ts"],
      constraints: ["Use an exact fenced interactive session lease."],
      nonGoals: ["Do not mutate user daemon state."],
      successCriteria: ["Live typed RPC returns success and persisted task status is done."],
      evidenceRequired: ["reports/daemon/task-claim-lease-live.json records refs and timestamps."],
      items: [
        {
          id: "live",
          title: `Execute and verify ${action}`,
          status: "done" as const,
          createdAt: now,
          updatedAt: now,
        },
      ],
      steps: [`Execute and verify ${action}`],
      openQuestions: [],
      askRefs: [],
    },
  };
}
