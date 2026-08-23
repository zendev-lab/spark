/**
 * Tool policy / dispatch helpers for SparkAgentLoop.
 */
import {
  hasActiveDriverBinding,
  resolveToolPolicy,
  resolveToolPolicyForArgs,
  type ResolvedToolPolicy,
  type SparkHostContext,
  type ToolConfig,
} from "@zendev-lab/spark-core";
import type {
  AssistantMessage,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@zendev-lab/spark-llm-providers";
import {
  compactToolResultContent,
  type SparkToolResultRawRecoveryDecision,
  type SparkToolResultRawRecoveryPath,
} from "./tool-result-compaction.ts";
import type { SparkTurnRegisteredTool } from "./turn-types.ts";
import type { SparkToolApprovalMethod, SparkToolApprovalRejectAction } from "./turn-types.ts";

export type ToolResultRawRecoveryRecord = {
  evidenceRef: string;
  reason: SparkToolResultRawRecoveryDecision["reason"];
  omittedChars: number;
  bodyChars: number;
  recoveryPath: SparkToolResultRawRecoveryPath;
  readHint: string;
};

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function mergeToolResultDetails(
  originalDetails: unknown,
  compaction: ReturnType<typeof compactToolResultContent>["details"],
  rawRecovery: ToolResultRawRecoveryRecord | undefined,
): unknown {
  if (!compaction && !rawRecovery) return originalDetails;
  return {
    ...(isPlainRecord(originalDetails) ? originalDetails : {}),
    ...(compaction ? { toolResultCompaction: compaction } : {}),
    ...(rawRecovery
      ? {
          toolResultRawRecovery: {
            evidenceRef: rawRecovery.evidenceRef,
            reason: rawRecovery.reason,
            omittedChars: rawRecovery.omittedChars,
            bodyChars: rawRecovery.bodyChars,
            recoveryPath: rawRecovery.recoveryPath,
            readHint: rawRecovery.readHint,
          },
        }
      : {}),
  };
}

export function rawToolResultRecoveryPath(evidenceRef: string): SparkToolResultRawRecoveryPath {
  return {
    kind: "evidence",
    evidenceRef,
    readTool: "evidence",
    readArgs: { action: "read", evidenceRef, maxChars: 20_000 },
  };
}

export function appendRawRecoveryHint(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>,
  hint: string,
): Array<{ type: string; text?: string; [key: string]: unknown }> {
  const index = content.findLastIndex(
    (part) => part.type === "text" && typeof part.text === "string",
  );
  const hintText = `[recovery] ${hint}`;
  if (index < 0) return [...content, { type: "text", text: hintText }];
  return content.map((part, partIndex) =>
    partIndex === index ? { ...part, text: `${part.text}\n\n${hintText}` } : part,
  );
}

export function rawToolResultEvidenceBody(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>,
): { format: "text" | "json"; body: string | Record<string, unknown>; bodyChars: number } {
  if (content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string") {
    return { format: "text", body: content[0].text, bodyChars: content[0].text.length };
  }
  const body = { schemaVersion: 1, content: jsonSafe(content) };
  return { format: "json", body, bodyChars: JSON.stringify(body).length };
}

export function rawToolOutputProducer(toolName: string): "spark" | "cue" {
  return toolName.startsWith("cue_") || toolName === "script_run" || toolName === "script_eval"
    ? "cue"
    : "spark";
}

export function evidenceRefFromToolResult(result: {
  content?: unknown;
  details?: unknown;
}): string | undefined {
  const details = isPlainRecord(result.details) ? result.details : undefined;
  const refs = isPlainRecord(details?.refs) ? details.refs : undefined;
  const fromRefs = stringField(refs, "evidenceRef");
  if (fromRefs?.startsWith("evidence:")) return fromRefs;
  const evidence = isPlainRecord(details?.evidence) ? details.evidence : undefined;
  const fromEvidence = stringField(evidence, "ref");
  if (fromEvidence?.startsWith("evidence:")) return fromEvidence;
  const text = Array.isArray(result.content)
    ? result.content
        .map((part) => (isPlainRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("\n")
    : "";
  return text.match(/evidence:[A-Za-z0-9._:-]+/u)?.[0];
}

export function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol")
    return value.description ? `[Symbol:${value.description}]` : "[Symbol]";
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      jsonSafe(child, seen),
    ]),
  );
}

export function normalizeToolCallArguments(
  parameters: unknown,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!isPlainRecord(parameters) || !isPlainRecord(parameters.properties)) return { ...args };
  const required = new Set(
    Array.isArray(parameters.required)
      ? parameters.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const properties = parameters.properties;
  return Object.fromEntries(
    Object.entries(args).filter(([key, value]) => {
      if (required.has(key) || !(key in properties)) return true;
      if (value === undefined || value === null) return false;
      return typeof value !== "string" || value.trim().length > 0;
    }),
  );
}

export function collectToolCalls(message: AssistantMessage): ToolCall[] {
  const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
  const seenIds = new Set<string>();
  for (const [index, toolCall] of toolCalls.entries()) {
    const id = typeof toolCall.id === "string" ? toolCall.id.trim() : "";
    if (!id) {
      throw new Error(`provider emitted a tool call without a non-empty id at index ${index}`);
    }
    if (seenIds.has(id)) throw new Error(`provider emitted duplicate tool call id: ${id}`);
    seenIds.add(id);
  }
  return toolCalls;
}

export function resolvedRegisteredToolPolicy(
  tool: SparkTurnRegisteredTool,
  args?: Readonly<Record<string, unknown>>,
): ResolvedToolPolicy {
  const policy =
    args && tool.config.resolvePolicy
      ? resolveToolPolicyForArgs(tool.config, args)
      : (tool.policy ?? resolveToolPolicy(tool.config));
  if (!legacyApprovalPolicyRequiresApproval(tool.config) || policy.approval === "required") {
    return policy;
  }
  return Object.freeze({
    ...policy,
    executionMode: "sequential",
    approval: "required",
  });
}

export function toolRequiresApproval(
  tool: SparkTurnRegisteredTool,
  args?: Readonly<Record<string, unknown>>,
  context?: Pick<SparkHostContext, "loop" | "driverAuthority">,
): boolean {
  const approval = resolvedRegisteredToolPolicy(tool, args).approval;
  if (approval === "required") return true;
  if (approval === "manual_only") {
    return !(hasActiveDriverBinding(context?.loop) && context?.driverAuthority === "granted");
  }
  return false;
}

function legacyApprovalPolicyRequiresApproval(config: ToolConfig): boolean {
  const approvalPolicy = (config as { approvalPolicy?: unknown }).approvalPolicy;
  if (approvalPolicy === true || approvalPolicy === "always") return true;
  return Boolean(
    approvalPolicy &&
    typeof approvalPolicy === "object" &&
    (approvalPolicy as { mode?: unknown }).mode === "always",
  );
}

export function safeSelectedSkills(
  getSelectedSkills: (() => readonly string[]) | undefined,
): readonly string[] {
  if (!getSelectedSkills) return [];
  try {
    const selected = getSelectedSkills();
    return Array.isArray(selected)
      ? selected.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function normalizeApprovalMethod(
  value: SparkToolApprovalMethod | undefined,
): SparkToolApprovalMethod {
  if (value === "skip" || value === "human" || value === "auto") return value;
  return "human";
}

export function normalizeApprovalRejectAction(
  value: SparkToolApprovalRejectAction | undefined,
): SparkToolApprovalRejectAction {
  if (value === "ask" || value === "deny") return value;
  return "ask";
}

export function toToolDefinition(config: ToolConfig): Tool {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters as Tool["parameters"],
  };
}

export function errorToolResult(
  toolCall: ToolCall,
  message: string,
  details?: Record<string, unknown>,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: message }],
    ...(details ? { details } : {}),
    isError: true,
    timestamp: Date.now(),
  };
}

type SparkToolFailureCertainty = "not-sent" | "unknown";
type SparkToolFailureRetryability = "transient" | "permanent" | "agent-decides";

export interface SparkToolFailureDisposition {
  certainty: SparkToolFailureCertainty;
  retryability: SparkToolFailureRetryability;
}

/** Delivery certainty and retryability are independent failure facts. */
export function sparkToolFailureDisposition(error: unknown): SparkToolFailureDisposition {
  return {
    certainty: sparkToolFailureCertainty(error),
    retryability: sparkToolFailureRetryability(error),
  };
}

/** Only an explicit cross-process not-sent tag permits replay. */
function sparkToolFailureCertainty(error: unknown): SparkToolFailureCertainty {
  const tagged = errorRecord(error);
  if (
    tagged?.certainty === "not-sent" ||
    tagged?.outcome === "not_sent" ||
    tagged?.code === "CHANNEL_DELIVERY_NOT_SENT" ||
    tagged?.code === "channel_delivery_not_sent"
  ) {
    return "not-sent";
  }
  const payload = errorRecord(tagged?.payload);
  const data = errorRecord(tagged?.data) ?? errorRecord(payload?.data);
  return data?.certainty === "not-sent" || payload?.certainty === "not-sent"
    ? "not-sent"
    : "unknown";
}

/** Missing retry metadata is always delegated to the Agent rather than retried implicitly. */
function sparkToolFailureRetryability(error: unknown): SparkToolFailureRetryability {
  const tagged = errorRecord(error);
  const payload = errorRecord(tagged?.payload);
  const data = errorRecord(tagged?.data) ?? errorRecord(payload?.data);
  for (const candidate of [tagged?.retryability, data?.retryability, payload?.retryability]) {
    if (candidate === "transient" || candidate === "permanent" || candidate === "agent-decides") {
      return candidate;
    }
  }
  for (const candidate of [tagged?.retriable, data?.retriable, payload?.retriable]) {
    if (candidate === true) return "transient";
    if (candidate === false) return "permanent";
  }
  return "agent-decides";
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
