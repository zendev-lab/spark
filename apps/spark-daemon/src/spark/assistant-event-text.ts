export type SparkDaemonPromptEvent = unknown;

export function extractTextDelta(event: SparkDaemonPromptEvent): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;

  if (record.type === "stream_event" && record.event && typeof record.event === "object") {
    return textDeltaFromRecord(record.event as Record<string, unknown>);
  }

  if (record.type === "message_update" && record.assistantMessageEvent) {
    return textDeltaFromRecord(record.assistantMessageEvent as Record<string, unknown>);
  }

  return textDeltaFromRecord(record);
}

export function extractFinalAssistantText(event: SparkDaemonPromptEvent): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;

  if (record.type === "stream_event" && record.event && typeof record.event === "object") {
    return finalTextFromStreamEvent(record.event as Record<string, unknown>);
  }

  if (record.type === "turn_complete") {
    return assistantMessageText(record.message);
  }

  if (record.type === "view_event" && record.event && typeof record.event === "object") {
    const view = record.event as Record<string, unknown>;
    if (view.type === "session.message") {
      return assistantMessageText(view.message);
    }
  }

  return assistantMessageText(record.message);
}

function textDeltaFromRecord(record: Record<string, unknown>): string | null {
  return record.type === "text_delta" && typeof record.delta === "string" ? record.delta : null;
}

function finalTextFromStreamEvent(event: Record<string, unknown>): string | null {
  if (event.type === "done") return assistantMessageText(event.message);
  if (event.type === "text_end" && typeof event.content === "string") return event.content;
  return null;
}

function assistantMessageText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return null;
  return messageContentText(message.content);
}

function messageContentText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("")
    .trim();
  return text || null;
}
