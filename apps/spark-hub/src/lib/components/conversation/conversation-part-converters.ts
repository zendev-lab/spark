import type { SparkMessageView } from "@zendev-lab/spark-protocol";
import type {
  ConversationApprovalState,
  ConversationPart,
  ConversationTaskState,
  ConversationToolState,
} from "@zendev-lab/spark-ui/conversation";

type UnknownRecord = Record<string, unknown>;
type PartContext = { message: SparkMessageView; index: number; partType: string };
type PartParser = (value: UnknownRecord, context: PartContext) => ConversationPart[];

const partParsers: Readonly<Record<string, PartParser>> = {
  text: parseTextPart,
  image: parseImagePart,
  thinking: parseReasoningPart,
  reasoning: parseReasoningPart,
  "tool-call": parseToolPart,
  "tool-result": parseToolPart,
  tool: parseToolPart,
  task: parseTaskPart,
  approval: parseApprovalPart,
  artifact: parseArtifactPart,
  error: parseErrorPart,
};

export function normalizeConversationPart(
  value: unknown,
  message: SparkMessageView,
  index: number,
): ConversationPart[] {
  if (!isRecord(value)) return [];
  const partType = stringField(value, "type");
  if (!partType) return [];
  const parser = partParsers[partType];
  return parser
    ? parser(value, { message, index, partType })
    : [{ type: "unknown", label: boundedLabel(partType) }];
}

function parseTextPart(value: UnknownRecord, { message }: PartContext): ConversationPart[] {
  const text = stringField(value, "text");
  if (!text?.trim()) return [];
  const streaming = stringField(value, "status") === "streaming" || message.status === "streaming";
  return stringField(value, "phase") === "commentary"
    ? [{ type: "commentary", summary: text, state: streaming ? "streaming" : "complete" }]
    : [{ type: "text", text, streaming }];
}

function parseImagePart(value: UnknownRecord): ConversationPart[] {
  if (
    typeof value.contentIndex !== "number" ||
    !Number.isSafeInteger(value.contentIndex) ||
    value.contentIndex < 0 ||
    !isRenderableImageMediaType(value.mediaType)
  ) {
    return [];
  }
  return [
    {
      type: "image",
      contentIndex: value.contentIndex,
      mediaType: value.mediaType,
      ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    },
  ];
}

function parseReasoningPart(value: UnknownRecord, { message }: PartContext): ConversationPart[] {
  const redacted = value.redacted === true;
  const summary = redacted ? "" : (stringField(value, "summary") ?? stringField(value, "text"));
  if (!summary?.trim() && !redacted) return [];
  return [
    {
      type: "reasoning",
      summary: summary ?? "",
      state:
        stringField(value, "status") === "streaming" || message.status === "streaming"
          ? "streaming"
          : "complete",
      redacted,
    },
  ];
}

function parseToolPart(value: UnknownRecord, context: PartContext): ConversationPart[] {
  const { message, index, partType } = context;
  const callId =
    stringField(value, "callId") ??
    stringField(value, "toolCallId") ??
    message.toolCallId ??
    `${message.id}:tool:${index}`;
  const name =
    stringField(value, "name") ?? stringField(value, "toolName") ?? message.toolName ?? "tool";
  const summary =
    stringField(value, "summary") ??
    stringField(value, "text") ??
    (message.role === "tool" && message.text.trim() ? message.text.trim() : undefined) ??
    (partType === "tool-result" && message.text.trim() ? message.text.trim() : undefined);
  return [
    {
      type: "tool",
      callId,
      name,
      state: toolState(stringField(value, "status") ?? message.status, partType),
      ...(summary ? { summary } : {}),
    },
  ];
}

function parseTaskPart(value: UnknownRecord, { message, index }: PartContext): ConversationPart[] {
  const taskRef = stringField(value, "taskRef") ?? `${message.id}:task:${index}`;
  return [
    {
      type: "task",
      taskRef,
      title: stringField(value, "title") ?? taskRef,
      state: taskState(stringField(value, "status")),
      summary: stringField(value, "summary"),
    },
  ];
}

function parseApprovalPart(
  value: UnknownRecord,
  { message, index }: PartContext,
): ConversationPart[] {
  const requestId = stringField(value, "requestId") ?? `${message.id}:approval:${index}`;
  return [
    {
      type: "approval",
      requestId,
      title: stringField(value, "title") ?? requestId,
      state: approvalState(stringField(value, "status")),
      kind: stringField(value, "kind"),
      summary: stringField(value, "summary"),
    },
  ];
}

function parseArtifactPart(
  value: UnknownRecord,
  { message, index }: PartContext,
): ConversationPart[] {
  const artifactRef =
    stringField(value, "artifactRef") ??
    stringField(value, "artifactId") ??
    stringField(value, "ref") ??
    `${message.id}:artifact:${index}`;
  const previewHref = explicitPreviewHref(value);
  return [
    {
      type: "artifact",
      artifactRef,
      title: stringField(value, "title") ?? artifactRef,
      kind: stringField(value, "kind"),
      state: stringField(value, "state") ?? stringField(value, "status"),
      summary: stringField(value, "summary"),
      ...(previewHref ? { previewHref } : {}),
    },
  ];
}

function explicitPreviewHref(value: UnknownRecord): string | undefined {
  const href = stringField(value, "previewHref");
  if (!href) return undefined;
  if (href.startsWith("/")) return href;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function parseErrorPart(value: UnknownRecord): ConversationPart[] {
  const title = stringField(value, "title") ?? "Error";
  return [
    {
      type: "error",
      title,
      message:
        stringField(value, "message") ??
        stringField(value, "summary") ??
        stringField(value, "text") ??
        title,
      code: stringField(value, "code"),
    },
  ];
}

export function mergeToolParts(parts: readonly ConversationPart[]): ConversationPart[] {
  const result: ConversationPart[] = [];
  const toolIndexes = new Map<string, number>();
  for (const part of parts) {
    if (part.type !== "tool") {
      result.push(part);
      continue;
    }
    const previousIndex = toolIndexes.get(part.callId);
    const previous = previousIndex === undefined ? undefined : result[previousIndex];
    if (previousIndex === undefined || previous?.type !== "tool") {
      toolIndexes.set(part.callId, result.length);
      result.push(part);
      continue;
    }
    result[previousIndex] = {
      ...previous,
      name: part.name || previous.name,
      state: laterToolState(previous.state, part.state),
      summary: preferToolSummary(previous.summary, part.summary, previous.state, part.state),
    };
  }
  return result;
}

export function laterToolState(
  previous: ConversationToolState,
  next: ConversationToolState,
): ConversationToolState {
  const rank: Record<ConversationToolState, number> = {
    pending: 0,
    "awaiting-approval": 1,
    running: 2,
    completed: 3,
    denied: 3,
    cancelled: 3,
    failed: 4,
  };
  return rank[next] >= rank[previous] ? next : previous;
}

export function preferToolSummary(
  previous: string | undefined,
  next: string | undefined,
  previousState: ConversationToolState,
  nextState: ConversationToolState,
): string | undefined {
  const terminal = new Set<ConversationToolState>(["completed", "failed", "denied", "cancelled"]);
  if (terminal.has(nextState) && next?.trim()) return next.trim();
  if (terminal.has(previousState) && previous?.trim()) return previous.trim();
  return next?.trim() || previous?.trim() || undefined;
}

export function taskState(value: string | undefined): ConversationTaskState {
  if (["completed", "complete", "done", "succeeded", "success"].includes(value ?? ""))
    return "completed";
  if (["failed", "error"].includes(value ?? "")) return "failed";
  if (value === "blocked") return "blocked";
  if (["cancelled", "canceled"].includes(value ?? "")) return "cancelled";
  if (["running", "in_progress", "claimed"].includes(value ?? "")) return "running";
  return "pending";
}

export function approvalState(value: string | undefined): ConversationApprovalState {
  if (["approved", "accepted"].includes(value ?? "")) return "approved";
  if (["answered", "resolved", "completed", "complete", "done"].includes(value ?? ""))
    return "resolved";
  if (["rejected", "denied"].includes(value ?? "")) return "rejected";
  if (["cancelled", "canceled"].includes(value ?? "")) return "cancelled";
  return "requested";
}

export function toolState(value: string | undefined, partType: string): ConversationToolState {
  if (value === "awaiting-approval") return "awaiting-approval";
  if (["completed", "complete", "done", "succeeded", "success"].includes(value ?? ""))
    return "completed";
  if (["failed", "error"].includes(value ?? "")) return "failed";
  if (["denied", "rejected"].includes(value ?? "")) return "denied";
  if (["cancelled", "canceled"].includes(value ?? "")) return "cancelled";
  if (["running", "streaming"].includes(value ?? "")) return "running";
  return partType === "tool-result" ? "completed" : "pending";
}

function isRenderableImageMediaType(
  value: unknown,
): value is Extract<ConversationPart, { type: "image" }>["mediaType"] {
  return ["image/bmp", "image/gif", "image/jpeg", "image/png", "image/webp"].includes(
    String(value),
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: UnknownRecord, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function boundedLabel(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}…`;
}
