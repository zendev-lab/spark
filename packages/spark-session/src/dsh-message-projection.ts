/** Shared Spark projection for authoritative native DSH message events. */

export const SPARK_DSH_MESSAGE_META_EVENT_TYPE = "spark/message-meta";

export interface SparkDshProjectionMessageMetaData {
  position: number;
  eventSeq: number;
  entry: { id: string; parentId: string | null; timestamp: string };
  role: string;
  contentShape: "string" | "blocks";
  messageMeta: Record<string, unknown>;
  blockMeta: unknown[];
}

export interface SparkDshProjectedMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: Record<string, unknown> & { role: string; content: unknown };
}

export function parseSparkDshMessageMetaData(
  data: unknown,
  path: string,
): SparkDshProjectionMessageMetaData {
  if (
    !isRecord(data) ||
    !Number.isSafeInteger(data.position) ||
    Number(data.position) < 0 ||
    !Number.isSafeInteger(data.eventSeq) ||
    !isRecord(data.entry) ||
    typeof data.entry.id !== "string" ||
    !(typeof data.entry.parentId === "string" || data.entry.parentId === null) ||
    typeof data.entry.timestamp !== "string" ||
    typeof data.role !== "string" ||
    (data.contentShape !== "string" && data.contentShape !== "blocks") ||
    !isRecord(data.messageMeta) ||
    !Array.isArray(data.blockMeta)
  ) {
    throw new Error(`Spark session ${path} has invalid spark/message-meta metadata`);
  }
  return data as unknown as SparkDshProjectionMessageMetaData;
}

export function projectSparkDshMessageEntry(
  nativeEvent: unknown,
  meta: SparkDshProjectionMessageMetaData,
  path: string,
): SparkDshProjectedMessageEntry {
  if (!isRecord(nativeEvent) || nativeEvent.seq !== meta.eventSeq) {
    throw new Error(`Spark session ${path} has mismatched DSH message metadata`);
  }
  const nativeMessage = dshMessageFromEvent(nativeEvent, path);
  const nativeContent = dshMessageContent(nativeMessage, path);
  const blocks = nativeContent.map((block, index) =>
    sparkContentFromDshBlock(block, meta.blockMeta[index], path),
  );
  const content =
    meta.contentShape === "string"
      ? blocks
          .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
          .join("")
      : blocks;
  return {
    type: "message",
    id: meta.entry.id,
    parentId: meta.entry.parentId,
    timestamp: meta.entry.timestamp,
    message: { ...meta.messageMeta, role: meta.role, content },
  };
}

function dshMessageFromEvent(
  value: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  if (value.type === "user/message" && isRecord(value.data)) return value.data;
  if (
    (value.type === "assistant/message" || value.type === "tool/result") &&
    isRecord(value.data) &&
    isRecord(value.data.message)
  ) {
    return value.data.message;
  }
  throw new Error(`Spark session ${path} message metadata points at ${String(value.type)}`);
}

function dshMessageContent(message: Record<string, unknown>, path: string): unknown[] {
  if (!Array.isArray(message.content)) {
    throw new Error(`Spark session ${path} has invalid DSH message content`);
  }
  if (isRecord(message.source) && message.source.kind === "tool") {
    const result = message.content[0];
    if (!isRecord(result) || result.type !== "tool-result" || !Array.isArray(result.content)) {
      throw new Error(`Spark session ${path} has invalid DSH tool result content`);
    }
    return result.content;
  }
  return message.content;
}

function sparkContentFromDshBlock(block: unknown, metadata: unknown, path: string): unknown {
  if (!isRecord(block)) throw new Error(`Spark session ${path} has invalid DSH content block`);
  const extras = isRecord(metadata) ? metadata : {};
  if (block.type === "text" && typeof block.text === "string") {
    return { ...extras, type: "text", text: block.text };
  }
  if (block.type === "reasoning" && typeof block.text === "string") {
    return { ...extras, type: "thinking", thinking: block.text };
  }
  if (
    block.type === "tool-call" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    typeof block.arguments === "string"
  ) {
    let args: unknown;
    try {
      args = JSON.parse(block.arguments) as unknown;
    } catch (error) {
      throw new Error(`Spark session ${path} has invalid DSH tool arguments`, { cause: error });
    }
    return { ...extras, type: "toolCall", id: block.id, name: block.name, arguments: args };
  }
  if (block.type === "image" && extras.type === "image") return extras;
  throw new Error(`Spark session ${path} cannot project DSH content block ${String(block.type)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
