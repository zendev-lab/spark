import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
import type { SparkSessionSnapshotPage } from "@zendev-lab/spark-protocol";

export type SparkWebSseEvent = {
  event: "spark.session.snapshot";
  data: SparkSessionSnapshotPage;
  cursor: string;
};

export function sessionSnapshotCursor(page: SparkSessionSnapshotPage): string {
  return createHash("sha256").update(JSON.stringify(page)).digest("base64url");
}

export async function collectSessionLiveEvents(input: {
  sessionId: string;
  cursor?: string | null;
  invoke?: typeof requestSparkDaemon;
}): Promise<SparkWebSseEvent[]> {
  const invoke = input.invoke ?? requestSparkDaemon;
  const page = await invoke("session.snapshot-page", {
    sessionId: input.sessionId,
    messageLimit: 32,
  });
  const cursor = sessionSnapshotCursor(page);
  return !input.cursor || input.cursor !== cursor
    ? [{ event: "spark.session.snapshot", data: page, cursor }]
    : [];
}

export async function* streamSessionLiveEvents(input: {
  sessionId: string;
  cursor?: string | null;
  signal: AbortSignal;
  intervalMs?: number;
  invoke?: typeof requestSparkDaemon;
}): AsyncGenerator<SparkWebSseEvent> {
  let cursor = input.cursor;
  while (!input.signal.aborted) {
    const events = await collectSessionLiveEvents({
      sessionId: input.sessionId,
      cursor,
      ...(input.invoke ? { invoke: input.invoke } : {}),
    });
    for (const event of events) {
      cursor = event.cursor;
      yield event;
    }
    try {
      await wait(input.intervalMs ?? 750, undefined, { signal: input.signal });
    } catch (error) {
      if (input.signal.aborted) return;
      throw error;
    }
  }
}

export function formatSseFrame(event: SparkWebSseEvent): string {
  return `event: ${event.event}\nid: ${event.cursor}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
