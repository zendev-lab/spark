import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";

import type { DaemonSessionRegistry } from "./session-registry.ts";
import type { SparkDriverStore } from "./store/drivers.ts";
import type { SparkInvocationStore } from "./store/invocations.ts";

export const INACTIVE_UNASSIGNED_SESSION_RETENTION_DAYS = 30;
export const INACTIVE_UNASSIGNED_SESSION_RETENTION_MS =
  INACTIVE_UNASSIGNED_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const SESSION_RETENTION_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface SessionRetentionReconcileResult {
  examined: number;
  eligible: number;
  archived: string[];
  skippedActiveDriver: string[];
  skippedActiveInvocation: string[];
  failures: Array<{ sessionId: string; error: string }>;
}

export async function reconcileInactiveSessionRetention(input: {
  registry: DaemonSessionRegistry;
  driverStore: Pick<SparkDriverStore, "list">;
  invocationStore: Pick<SparkInvocationStore, "sessionActivities">;
  now?: Date;
  retentionMs?: number;
}): Promise<SessionRetentionReconcileResult> {
  const now = input.now ?? new Date();
  const cutoffMs = now.getTime() - (input.retentionMs ?? INACTIVE_UNASSIGNED_SESSION_RETENTION_MS);
  const sessions = await input.registry.list({ includeArchived: false });
  const activities = input.invocationStore.sessionActivities(
    sessions.map((session) => session.sessionId),
  );
  const inactiveCandidates = sessions.filter((session) => {
    if (!isUnassignedRetentionCandidate(session)) return false;
    const activity = activities.get(session.sessionId);
    const latestUpdate = [session.updatedAt, activity?.updatedAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    return latestUpdate !== undefined && Date.parse(latestUpdate) <= cutoffMs;
  });
  const skippedActiveInvocation = inactiveCandidates
    .filter((session) => activities.get(session.sessionId)?.active === true)
    .map((session) => session.sessionId);
  const activeInvocationOwners = new Set(skippedActiveInvocation);
  const candidates = inactiveCandidates.filter(
    (session) => !activeInvocationOwners.has(session.sessionId),
  );
  const skippedActiveDriver = candidates
    .filter((session) => input.driverStore.list({ ownerSessionId: session.sessionId }).length > 0)
    .map((session) => session.sessionId);
  const activeDriverOwners = new Set(skippedActiveDriver);
  const settled = await Promise.allSettled(
    candidates
      .filter((session) => !activeDriverOwners.has(session.sessionId))
      .map(async (session) => {
        const archived = await input.registry.archive({
          sessionId: session.sessionId,
          source: "retention",
          reason: `inactive unassigned session exceeded ${INACTIVE_UNASSIGNED_SESSION_RETENTION_DAYS} days`,
          tags: [
            "policy:inactive-unassigned-30d",
            `retention-days:${INACTIVE_UNASSIGNED_SESSION_RETENTION_DAYS}`,
            `last-active:${session.updatedAt.slice(0, 7)}`,
          ],
          expectedUpdatedAt: session.updatedAt,
          requireUnassigned: true,
          now,
        });
        return { sessionId: session.sessionId, archived: archived.status === "archived" };
      }),
  );
  const archived: string[] = [];
  const failures: SessionRetentionReconcileResult["failures"] = [];
  settled.forEach((result, index) => {
    const session = candidates.filter((candidate) => !activeDriverOwners.has(candidate.sessionId))[
      index
    ];
    if (!session) return;
    if (result.status === "fulfilled") {
      if (result.value.archived) archived.push(result.value.sessionId);
      return;
    }
    failures.push({ sessionId: session.sessionId, error: errorMessage(result.reason) });
  });
  return {
    examined: sessions.length,
    eligible: inactiveCandidates.length,
    archived,
    skippedActiveDriver,
    skippedActiveInvocation,
    failures,
  };
}

function isUnassignedRetentionCandidate(session: SparkSessionRegistryRecord): boolean {
  return (
    session.status === "ready" &&
    !session.role?.trim() &&
    !session.title?.trim() &&
    !session.relation &&
    session.bindings.length === 0
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
