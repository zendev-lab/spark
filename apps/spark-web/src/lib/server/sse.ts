import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
import type { SparkSessionView } from "@zendev-lab/spark-protocol";

export type SparkWebSseEvent = {
  event: "spark.session.snapshot" | "spark.turn.event";
  data: unknown;
  cursor: string;
};

export function sessionSnapshotCursor(view: SparkSessionView): string {
  return `${view.updatedAt ?? view.createdAt ?? ""}|${view.sessionId}|${view.pendingTurns?.length ?? 0}`;
}

export async function readSessionSnapshot(sessionId: string): Promise<SparkSessionView> {
  return await requestSparkDaemon("session.snapshot", { sessionId });
}

export async function collectSessionLiveEvents(input: {
  sessionId: string;
  cursor?: string | null;
  invoke?: typeof requestSparkDaemon;
}): Promise<SparkWebSseEvent[]> {
  const invoke = input.invoke ?? requestSparkDaemon;
  const snapshot = await invoke("session.snapshot", { sessionId: input.sessionId });
  const cursor = sessionSnapshotCursor(snapshot);
  const events: SparkWebSseEvent[] = [];
  if (!input.cursor || input.cursor !== cursor) {
    events.push({ event: "spark.session.snapshot", data: snapshot, cursor });
  }
  for (const turn of snapshot.pendingTurns ?? []) {
    const page = await invoke("turn.stream", {
      invocationId: turn.invocationId,
      after: 0,
      limit: 100,
    });
    for (const item of page.events) {
      events.push({
        event: "spark.turn.event",
        data: item,
        cursor: `${item.sequence}|${item.createdAt}|${item.invocationId}`,
      });
    }
  }
  return events;
}

export function formatSseFrame(event: SparkWebSseEvent): string {
  return `event: ${event.event}\nid: ${event.cursor}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
