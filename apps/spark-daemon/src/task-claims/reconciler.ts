import type { DatabaseSync } from "node:sqlite";
import { type Task } from "@zendev-lab/spark-tasks";
import {
  defaultTaskGraphStore,
  isUnfinishedTaskStatus,
  type TaskGraph,
} from "@zendev-lab/spark-tasks";
import { listWorkspaceClaimTargets } from "../store/workspaces.ts";
import {
  MAIN_TASK_CLAIM_LEASE_MS,
  mainTaskClaimExpiryBoundary,
  shouldRenewMainTaskClaim,
} from "./policy.ts";
import { interactiveConnectedSessionIds, updateTaskGraph } from "./authority-support.ts";

export interface MainTaskClaimReconcileResult {
  observedAt: string;
  workspaces: number;
  renewed: string[];
  revived: string[];
  expired: string[];
  skippedRoleRun: string[];
  degraded: Array<{ workspaceId: string; error: string }>;
}

export async function reconcileMainTaskClaims(
  db: DatabaseSync,
  options: { now?: string; startupRecoveryUntil?: string } = {},
): Promise<MainTaskClaimReconcileResult> {
  const now = options.now ?? new Date().toISOString();
  const result: MainTaskClaimReconcileResult = {
    observedAt: now,
    workspaces: 0,
    renewed: [],
    revived: [],
    expired: [],
    skippedRoleRun: [],
    degraded: [],
  };
  for (const workspace of listWorkspaceClaimTargets(db)) {
    result.workspaces += 1;
    const liveSessions = new Set(interactiveConnectedSessionIds(db, workspace.id, now));
    try {
      await reconcileWorkspaceClaims(
        workspace.localPath,
        liveSessions,
        now,
        options.startupRecoveryUntil,
        result,
      );
    } catch (error) {
      result.degraded.push({
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

async function reconcileWorkspaceClaims(
  cwd: string,
  liveSessions: ReadonlySet<string>,
  now: string,
  startupRecoveryUntil: string | undefined,
  result: MainTaskClaimReconcileResult,
): Promise<void> {
  const snapshot = await defaultTaskGraphStore(cwd).load();
  if (!snapshot || !snapshot.tasks().some((task) => claimNeedsMutation(task, liveSessions, now))) {
    collectRoleRunClaims(snapshot, result);
    return;
  }
  await updateTaskGraph(cwd, (graph) => {
    collectRoleRunClaims(graph, result);
    for (const task of graph.tasks()) {
      const claim = task.claim;
      if (!claim || claim.kind !== "main") continue;
      const sessionId = claim.sessionId ?? claim.claimedBy;
      if (liveSessions.has(sessionId)) {
        if (!shouldRenewMainTaskClaim(claim.expiresAt, now)) continue;
        const wasExpired = claim.expiresAt <= now;
        graph.claimTask(task.ref, {
          kind: "main",
          claimedBy: sessionId,
          sessionId,
          status: isUnfinishedTaskStatus(task.status) ? task.status : "running",
          roleRef: claim.roleRef,
          leaseMs: MAIN_TASK_CLAIM_LEASE_MS,
          now,
        });
        (wasExpired ? result.revived : result.renewed).push(task.ref);
        continue;
      }
      if (startupRecoveryUntil && now < startupRecoveryUntil) continue;
      if (mainTaskClaimExpiryBoundary(claim.expiresAt) > now) continue;
      if (graph.expireTaskClaim(task.ref, now)) result.expired.push(task.ref);
    }
  });
}

function claimNeedsMutation(task: Task, liveSessions: ReadonlySet<string>, now: string): boolean {
  const claim = task.claim;
  if (!claim || claim.kind !== "main") return false;
  const sessionId = claim.sessionId ?? claim.claimedBy;
  return liveSessions.has(sessionId)
    ? shouldRenewMainTaskClaim(claim.expiresAt, now)
    : mainTaskClaimExpiryBoundary(claim.expiresAt) <= now;
}

function collectRoleRunClaims(graph: TaskGraph | null, result: MainTaskClaimReconcileResult): void {
  if (!graph) return;
  for (const task of graph.tasks()) {
    if (task.claim?.kind === "role-run" && !result.skippedRoleRun.includes(task.ref)) {
      result.skippedRoleRun.push(task.ref);
    }
  }
}
