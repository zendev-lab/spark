import type { SparkSessionState } from "@zendev-lab/spark-protocol";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import type { SparkInvocationRecord, SparkInvocationStore } from "./store/invocations.ts";
import type { SparkLoopRecord, SparkLoopStore } from "./store/loops.ts";

const terminalSessionAdmissionCodes = new Set([
  "session_archived",
  "session_closed",
  "session_closing",
  "session_not_found",
]);

export interface QuiescedSessionLoops {
  invocationSessionIds: string[];
  stoppedLoops: SparkLoopRecord[];
}

export async function commitLoopInvocationAdmission(
  registry: DaemonSessionRegistry,
  ownerSessionId: string,
  admit: () => SparkInvocationRecord,
): Promise<SparkInvocationRecord | undefined> {
  try {
    return await registry.commitInvocationAdmission(ownerSessionId, () => admit());
  } catch (error) {
    if (
      error instanceof SparkSessionRegistryError &&
      terminalSessionAdmissionCodes.has(error.code)
    ) {
      return undefined;
    }
    throw error;
  }
}

export function quiesceLoopsForClosingSession(
  loops: Pick<SparkLoopStore, "get" | "list" | "stop">,
  invocations: Pick<SparkInvocationStore, "get" | "listLoopExecutionSessionIds">,
  session: SparkSessionState,
  reason: string,
): QuiescedSessionLoops {
  // A driver-tick child closes after every tick and must not stop the next
  // generation. A stable driver is the Loop's execution resource, so closing
  // that exact Session stops its current incarnation. Closing the durable
  // owner Session quiesces every Loop it owns.
  if (session.lineage.kind === "child" && session.lineage.origin.kind === "driver_tick") {
    return { invocationSessionIds: [], stoppedLoops: [] };
  }
  const candidates =
    session.lineage.kind === "child" && session.lineage.origin.kind === "driver"
      ? matchingDriverLoop(
          loops.get(session.lineage.origin.driverId),
          session.sessionId,
          session.lineage.parentSessionId,
        )
      : loops.list({ ownerSessionId: session.sessionId, includeTerminal: true });
  const stoppedLoops: SparkLoopRecord[] = [];
  const invocationSessionIds = new Set(
    session.lineage.kind === "child" && session.lineage.origin.kind === "driver"
      ? []
      : invocations.listLoopExecutionSessionIds(session.sessionId),
  );

  for (const candidate of uniqueLoops(candidates)) {
    const loop =
      candidate.status === "completed" || candidate.status === "stopped"
        ? candidate
        : loops.stop(candidate.loopId, reason);
    if (loop !== candidate) stoppedLoops.push(loop);
    if (
      (session.lineage.kind === "child" && session.lineage.origin.kind === "driver") ||
      !loop.lastInvocationId
    ) {
      continue;
    }
    const invocation = invocations.get(loop.lastInvocationId);
    if (!invocation?.sessionId || invocation.payloadRedactedAt) continue;
    invocationSessionIds.add(invocation.sessionId);
  }

  return {
    invocationSessionIds: [...invocationSessionIds].sort(),
    stoppedLoops,
  };
}

function uniqueLoops(loops: SparkLoopRecord[]): SparkLoopRecord[] {
  return [...new Map(loops.map((loop) => [loop.loopId, loop])).values()];
}

function matchingDriverLoop(
  loop: SparkLoopRecord | undefined,
  sessionId: string,
  supervisorSessionId: string,
): SparkLoopRecord[] {
  return loop?.driverSessionId === sessionId && loop.ownerSessionId === supervisorSessionId
    ? [loop]
    : [];
}
