import {
  parseSparkSessionSnapshotWindow,
  sessionEventCursorStorageKey,
  type SparkSessionSnapshotPage,
} from "@zendev-lab/spark-protocol";

export type WebSessionConnectionState = "connecting" | "connected" | "reconnecting";

export function attachWebSessionEvents(
  sessionId: string,
  onSnapshot: (window: SparkSessionSnapshotPage) => void,
  onConnectionState?: (state: WebSessionConnectionState) => void,
): () => void {
  const storageKey = sessionEventCursorStorageKey("web", sessionId);
  let cursor: string | null = null;
  try {
    cursor = storageKey ? window.sessionStorage.getItem(storageKey) : null;
  } catch {
    // Cursor persistence is optional when the browser disallows storage.
  }
  let source: EventSource | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 750;
  let disposed = false;

  function reconnect(current: EventSource) {
    if (disposed || source !== current) return;
    current.close();
    source = undefined;
    onConnectionState?.("reconnecting");
    reconnectTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10_000);
  }

  function connect() {
    reconnectTimer = undefined;
    if (disposed) return;
    const url = new URL(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      window.location.origin,
    );
    if (cursor) url.searchParams.set("cursor", cursor);
    const current = new EventSource(url);
    source = current;
    current.addEventListener("open", () => {
      if (!disposed && source === current) onConnectionState?.("connected");
    });
    // An HTTP 503 ends native EventSource retries, so reconnect explicitly.
    current.addEventListener("error", () => reconnect(current));
    current.addEventListener("spark.session.snapshot", (message) => {
      if (disposed || source !== current) return;
      let snapshotWindow: SparkSessionSnapshotPage;
      try {
        snapshotWindow = parseSparkSessionSnapshotWindow(
          JSON.parse((message as MessageEvent<string>).data),
        );
      } catch {
        reconnect(current);
        return;
      }
      if (snapshotWindow.snapshot.sessionId !== sessionId) return;
      retryDelay = 750;
      if ("lastEventId" in message && typeof message.lastEventId === "string") {
        cursor = message.lastEventId;
        try {
          if (storageKey) window.sessionStorage.setItem(storageKey, cursor);
        } catch {
          // The in-memory cursor still supports reconnection.
        }
      }
      onConnectionState?.("connected");
      onSnapshot(snapshotWindow);
    });
  }

  onConnectionState?.("connecting");
  connect();
  return () => {
    disposed = true;
    clearTimeout(reconnectTimer);
    source?.close();
  };
}
