import { sessionEventCursorStorageKey, type SparkSessionView } from "@zendev-lab/spark-protocol";

export function attachWebSessionEvents(
  sessionId: string,
  onSnapshot: (view: SparkSessionView) => void,
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
    const view = JSON.parse((message as MessageEvent<string>).data) as SparkSessionView;
    if (storageKey && "lastEventId" in message && typeof message.lastEventId === "string") {
      window.sessionStorage.setItem(storageKey, message.lastEventId);
    }
    onSnapshot(view);
  });
  return () => source.close();
}
