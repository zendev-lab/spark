import { readFileSync, renameSync, writeFileSync } from "node:fs";

import {
  SPARK_SCRIPTED_PROVIDER_MODEL,
  createSparkScriptedProvider,
  sparkScriptedAssistant,
  sparkScriptedToolCall,
  type SparkScriptedProviderRequest,
} from "@zendev-lab/spark-turn/testing/scripted-provider";

interface ScriptedToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

interface ScriptedRound {
  label: string;
  text?: string;
  toolCalls?: ScriptedToolCall[];
}

interface ScriptedProviderLedger {
  schema: "spark.repro.scripted-provider-ledger/v1";
  cursor: number;
  rounds: ScriptedRound[];
  requests: Array<{
    round: number;
    label?: string;
    messageRoles: string[];
    toolNames: string[];
  }>;
  auxiliaryRequests?: Array<{
    label: string;
    messageRoles: string[];
    toolNames: string[];
  }>;
  vars?: Record<string, string>;
}

export default function registerScriptedJourneyProvider(api: {
  registerProvider(name: string, config: Record<string, unknown>): void;
}): void {
  api.registerProvider(SPARK_SCRIPTED_PROVIDER_MODEL.provider, {
    name: "Spark Repro Journey Script",
    api: SPARK_SCRIPTED_PROVIDER_MODEL.api,
    baseUrl: SPARK_SCRIPTED_PROVIDER_MODEL.baseUrl,
    models: [SPARK_SCRIPTED_PROVIDER_MODEL],
    streamSimple(model: unknown, context: unknown, options?: unknown) {
      const path = requiredLedgerPath();
      const ledger = readLedger(path);
      const availableTools = Array.isArray((context as { tools?: unknown[] }).tools)
        ? (context as { tools: unknown[] }).tools
        : [];
      const serializedContext = JSON.stringify(context);
      const toolApprovalReview = serializedContext.includes(
        "Review this Spark tool-call approval request before execution.",
      );
      const reviewerRequest = availableTools.some(
        (tool) => (tool as { name?: unknown }).name === "role_report_outcome",
      );
      const taskCompletionReview = reviewerRequest && !toolApprovalReview;
      if (availableTools.length === 0 || toolApprovalReview || taskCompletionReview) {
        const toolApprovalOutcomeRecorded = serializedContext.includes(
          "Recorded completed outcome (journey_tool_approval_approved).",
        );
        const auxiliaryText = taskCompletionReview
          ? JSON.stringify({
              outcome: "approved",
              summary: "The Task plan and cited Golden Journey evidence satisfy this transition.",
              findings: [],
              blockers: [],
              confidence: "high",
            })
          : toolApprovalReview
            ? JSON.stringify({
                outcome: "approved",
                summary:
                  "The deterministic Journey contract authorizes the Draft forge-shim submission.",
                findings: [],
                blockers: [],
                confidence: "high",
              })
            : "The deterministic Repro Journey is active and its durable owner state remains authoritative.";
        const auxiliaryLabel = taskCompletionReview
          ? "auxiliary.task-review"
          : toolApprovalReview
            ? toolApprovalOutcomeRecorded
              ? "auxiliary.tool-approval.verdict"
              : "auxiliary.tool-approval.outcome"
            : "auxiliary.compaction";
        const auxiliaryContent =
          toolApprovalReview && !toolApprovalOutcomeRecorded
            ? [
                sparkScriptedToolCall("journey.reviewer.outcome", "role_report_outcome", {
                  kind: "completed",
                  code: "journey_tool_approval_approved",
                  reason:
                    "The deterministic Draft forge-shim submission is safe and contract-authorized.",
                }),
              ]
            : [{ type: "text" as const, text: auxiliaryText }];
        const auxiliary = createSparkScriptedProvider([
          {
            label: auxiliaryLabel,
            message: sparkScriptedAssistant(auxiliaryContent, {
              stopReason: auxiliaryContent.some((part) => part.type === "toolCall")
                ? "toolUse"
                : "stop",
            }),
          },
        ]);
        const stream = auxiliary.streamFunction(
          model as Parameters<typeof auxiliary.streamFunction>[0],
          context as Parameters<typeof auxiliary.streamFunction>[1],
          options as Parameters<typeof auxiliary.streamFunction>[2],
        );
        const request = auxiliary.requests[0];
        if (request) {
          (ledger.auxiliaryRequests ??= []).push({
            label: auxiliaryLabel,
            messageRoles: request.messages.map((message) => message.role),
            toolNames: request.tools.map((tool) => tool.name),
          });
        }
        writeLedger(path, ledger);
        return stream;
      }
      const round = ledger.rounds[ledger.cursor];
      if (!round) {
        throw new Error(
          `Spark Repro scripted provider received unexpected request ${ledger.cursor + 1}; configured ${ledger.rounds.length} round(s)`,
        );
      }
      const refs = collectRefs(context);
      const content = [
        ...(round.text
          ? [{ type: "text" as const, text: interpolate(round.text, ledger, refs) }]
          : []),
        ...(round.toolCalls ?? []).map((call) =>
          sparkScriptedToolCall(
            call.id,
            call.name,
            interpolateValue(call.arguments ?? {}, ledger, refs) as Record<string, unknown>,
          ),
        ),
      ];
      const provider = createSparkScriptedProvider([
        {
          label: round.label,
          message: sparkScriptedAssistant(content, {
            stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
          }),
        },
      ]);
      const stream = provider.streamFunction(
        model as Parameters<typeof provider.streamFunction>[0],
        context as Parameters<typeof provider.streamFunction>[1],
        options as Parameters<typeof provider.streamFunction>[2],
      );
      ledger.cursor += 1;
      const request = provider.requests[0];
      if (request) ledger.requests.push(requestRecord(request));
      writeLedger(path, ledger);
      return stream;
    },
  });
}

function requiredLedgerPath(): string {
  const path = process.env.SPARK_REPRO_SCRIPTED_PROVIDER_LEDGER?.trim();
  if (!path) throw new Error("SPARK_REPRO_SCRIPTED_PROVIDER_LEDGER is required");
  return path;
}

function readLedger(path: string): ScriptedProviderLedger {
  const value = JSON.parse(readFileSync(path, "utf8")) as ScriptedProviderLedger;
  if (value.schema !== "spark.repro.scripted-provider-ledger/v1") {
    throw new Error(`Unsupported scripted provider ledger: ${String(value.schema)}`);
  }
  return value;
}

function writeLedger(path: string, ledger: ScriptedProviderLedger): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function requestRecord(request: SparkScriptedProviderRequest) {
  return {
    round: request.round,
    ...(request.label ? { label: request.label } : {}),
    messageRoles: request.messages.map((message) => message.role),
    toolNames: request.tools.map((tool) => tool.name),
  };
}

interface ContextRefs {
  artifacts: string[];
  evidence: string[];
  tasks: string[];
}

function collectRefs(value: unknown): ContextRefs {
  const serialized = JSON.stringify(value);
  return {
    artifacts: uniqueMatches(serialized, /artifact:[a-z0-9-]+/giu),
    evidence: uniqueMatches(serialized, /evidence:[a-z0-9-]+/giu),
    tasks: uniqueMatches(serialized, /task:[a-z0-9-]+/giu),
  };
}

function uniqueMatches(value: string, pattern: RegExp): string[] {
  return [...new Set(value.match(pattern) ?? [])];
}

function interpolateValue(
  value: unknown,
  ledger: ScriptedProviderLedger,
  refs: ContextRefs,
): unknown {
  if (typeof value === "string") return interpolate(value, ledger, refs);
  if (Array.isArray(value)) return value.map((entry) => interpolateValue(entry, ledger, refs));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, interpolateValue(entry, ledger, refs)]),
  );
}

function interpolate(value: string, ledger: ScriptedProviderLedger, refs: ContextRefs): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gu, (_match, name: string) => {
    const configured = ledger.vars?.[name];
    if (configured !== undefined) return configured;
    if (name === "LAST_ARTIFACT_REF") return refs.artifacts.at(-1) ?? missing(name);
    if (name === "LAST_EVIDENCE_REF") return refs.evidence.at(-1) ?? missing(name);
    if (name === "LAST_TASK_REF") return refs.tasks.at(-1) ?? missing(name);
    const artifactIndex = /^ARTIFACT_REF_(\d+)$/u.exec(name)?.[1];
    if (artifactIndex) return refs.artifacts[Number(artifactIndex) - 1] ?? missing(name);
    const evidenceIndex = /^EVIDENCE_REF_(\d+)$/u.exec(name)?.[1];
    if (evidenceIndex) return refs.evidence[Number(evidenceIndex) - 1] ?? missing(name);
    const taskIndex = /^TASK_REF_(\d+)$/u.exec(name)?.[1];
    if (taskIndex) return refs.tasks[Number(taskIndex) - 1] ?? missing(name);
    return missing(name);
  });
}

function missing(name: string): never {
  throw new Error(`Scripted provider placeholder ${name} is unavailable`);
}
