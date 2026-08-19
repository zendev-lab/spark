export const SPARK_SESSION_EVENT_CURSOR_SURFACES = ["hub", "web"] as const;
export type SparkSessionEventCursorSurface = (typeof SPARK_SESSION_EVENT_CURSOR_SURFACES)[number];

/** Browser sessionStorage key for a surface-scoped events cursor. */
export function sessionEventCursorStorageKey(
  surface: SparkSessionEventCursorSurface,
  sessionId: string,
): string | null {
  const normalized = sessionId.trim();
  return normalized ? `spark:${surface}:session:${normalized}:events-cursor` : null;
}

export function sessionEventCursor(event: {
  createdAt: string;
  id: string;
  sequence: number | null;
}): string {
  return event.sequence === null
    ? `${event.createdAt}|${event.id}`
    : `${event.sequence}|${event.createdAt}|${event.id}`;
}
