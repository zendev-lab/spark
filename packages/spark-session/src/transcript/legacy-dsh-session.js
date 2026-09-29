// Keep retired Cordis declaration merges out of the active runtime's type graph.
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES } from "spark-dsh-session-v0";

export function restoreLegacyDshSession(document) {
  if (document.header.version !== 0) throw new Error("Unsupported legacy DSH format");
  for (const event of document.events) {
    if (
      !KNOWN_SESSION_EVENT_TYPES.has(event.type) &&
      ![
        "spark/meta",
        "spark/record",
        "spark/message-meta",
        "spark/entry",
        "subagent/model-selection-policy",
      ].includes(event.type) &&
      event.ignorable !== true
    ) {
      throw new Error(`unknown required event ${event.type}`);
    }
  }
  return Session.fromRestore(
    SessionId(String(document.header.id)),
    structuredClone(document.events),
    structuredClone(document.header),
  );
}
