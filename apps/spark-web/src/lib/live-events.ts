import {
  parseSparkSessionSnapshotWindow,
  sessionEventCursorStorageKey,
  type SparkSessionSnapshotPage,
} from "@zendev-lab/spark-protocol";

export function attachWebSessionEvents(
  sessionId: string,
  onSnapshot: (window: SparkSessionSnapshotPage) => void,
): () => void {
  const storageKey = sessionEventCursorStorageKey("web", sessionId);
  const cursor = storageKey ? window.sessionStorage.getItem(storageKey) : null;
  const url = new URL(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    window.location.origin,
  );
  if (cursor) url.searchParams.set("cursor", cursor);
  const source = new EventSource(url);
  source.addEventListener("spark.session.snapshot", (message) => {
    const snapshotWindow = parseSparkSessionSnapshotWindow(
      JSON.parse((message as MessageEvent<string>).data),
    );
    if (storageKey && "lastEventId" in message && typeof message.lastEventId === "string") {
      window.sessionStorage.setItem(storageKey, message.lastEventId);
    }
    onSnapshot(snapshotWindow);
  });
  return () => source.close();
}
