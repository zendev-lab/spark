import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import {
  SPARK_SCRIPTED_PROVIDER_MODEL,
  createSparkScriptedProvider,
  sparkScriptedAssistant,
  sparkScriptedToolCall,
  type SparkScriptedProviderRequest,
} from "../../../apps/spark-daemon/src/product/host/agent-runtime/testing/scripted-provider.ts";

interface ScriptedToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

interface ScriptedRound {
  label: string;
  audience?: "root" | "implementation" | "exactness" | "formalize";
  text?: string;
  toolCalls?: ScriptedToolCall[];
}

const REPRO_JOURNEY_SCRIPTED_PROVIDER_MODEL = {
  ...SPARK_SCRIPTED_PROVIDER_MODEL,
  // The Journey exercises the complete Spark system and tool surface. Keep its
  // deterministic provider large enough for that envelope while the shared
  // scripted model remains a small-context test fixture.
  contextWindow: 128_000,
};

export interface ScriptedProviderLedger {
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
  cursors?: Partial<Record<ScriptedAudience, number>>;
  lastLabels?: Partial<Record<ScriptedAudience, string>>;
}

export default function registerScriptedJourneyProvider(api: {
  registerProvider(name: string, config: Record<string, unknown>): void;
}): void {
  api.registerProvider(REPRO_JOURNEY_SCRIPTED_PROVIDER_MODEL.provider, {
    name: "Spark Repro Journey Script",
    api: REPRO_JOURNEY_SCRIPTED_PROVIDER_MODEL.api,
    baseUrl: REPRO_JOURNEY_SCRIPTED_PROVIDER_MODEL.baseUrl,
    models: [REPRO_JOURNEY_SCRIPTED_PROVIDER_MODEL],
    streamSimple(model: unknown, context: unknown, options?: unknown) {
      const path = requiredLedgerPath();
      return updateScriptedProviderLedger(path, (ledger) => {
        const availableTools = Array.isArray((context as { tools?: unknown[] }).tools)
          ? (context as { tools: unknown[] }).tools
          : [];
        const serializedContext = JSON.stringify(context);
        const latestMessage = Array.isArray((context as { messages?: unknown[] }).messages)
          ? ((context as { messages: unknown[] }).messages.at(-1) ?? {})
          : {};
        const continuationSeed = JSON.stringify(latestMessage).includes(
          "Record a bounded continuation checkpoint before Repro compaction.",
        );
        const toolApprovalReview = serializedContext.includes(
          "Review this Spark tool-call approval request before execution.",
        );
        const reviewerRequest = availableTools.some(
          (tool) => (tool as { name?: unknown }).name === "role_report_outcome",
        );
        const taskCompletionReview =
          !toolApprovalReview &&
          (reviewerRequest || serializedContext.includes("spark.task-finish-review-packet/v1"));
        const compactionRequest =
          availableTools.length === 0 && !toolApprovalReview && !taskCompletionReview;
        if (continuationSeed || compactionRequest || toolApprovalReview || taskCompletionReview) {
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
              : compactionRequest
                ? JSON.stringify({
                    version: 1,
                    objective: "Continue the daemon-owned Repro v10 checkpoint sequence",
                    completed: ["The current lane checkpoint has terminal TaskRun Evidence"],
                    inProgress: ["Resume from the daemon-owned current checkpoint binding"],
                    decisions: [
                      "Session transcript is context; Repro owner state is authoritative",
                    ],
                    changedFiles: [],
                    commands: [],
                    failures: [],
                    preservedFacts: [
                      "Reuse the same lane Session and reload TaskRef and RunRef from the next prompt",
                    ],
                    unresolved: [],
                    memoryRefs: [],
                  })
                : "Continuation checkpoint recorded; daemon-owned Repro state remains authoritative.";
          const auxiliaryLabel = taskCompletionReview
            ? "auxiliary.task-review"
            : toolApprovalReview
              ? toolApprovalOutcomeRecorded
                ? "auxiliary.tool-approval.verdict"
                : "auxiliary.tool-approval.outcome"
              : compactionRequest
                ? "auxiliary.compaction"
                : "auxiliary.continuation-seed";
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
          return stream;
        }
        const refs = collectRefs(context);
        const audience = scriptedAudience(refs);
        const audienceRounds = ledger.rounds.filter(
          (candidate) => (candidate.audience ?? "root") === audience,
        );
        const audienceCursor = ledger.cursors?.[audience] ?? 0;
        const round = audienceRounds[audienceCursor];
        if (!round) {
          throw new Error(
            `Spark Repro scripted provider received unexpected ${audience} request ${audienceCursor + 1}; configured ${audienceRounds.length} round(s)`,
          );
        }
        rememberPreviousRoundOutput(ledger, refs, ledger.lastLabels?.[audience]);
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
        (ledger.cursors ??= {})[audience] = audienceCursor + 1;
        (ledger.lastLabels ??= {})[audience] = round.label;
        const request = provider.requests[0];
        if (request) ledger.requests.push(requestRecord(request));
        return stream;
      });
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

export function updateScriptedProviderLedger<T>(
  path: string,
  update: (ledger: ScriptedProviderLedger) => T,
): T {
  const release = acquireLedgerLock(path);
  try {
    const ledger = readLedger(path);
    const result = update(ledger);
    writeLedger(path, ledger);
    return result;
  } finally {
    release();
  }
}

const ledgerLockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function acquireLedgerLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(
          descriptor,
          `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        );
      } catch (error) {
        closeSync(descriptor);
        unlinkSync(lockPath);
        throw error;
      }
      return () => {
        closeSync(descriptor);
        unlinkSync(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - startedAt >= 10_000) {
        throw new Error(
          `timed out waiting for scripted provider ledger lock: ${lockPath}; remove the test fixture to recover`,
        );
      }
      Atomics.wait(ledgerLockWaitBuffer, 0, 0, 10);
    }
  }
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
  runs: string[];
  routes: string[];
  workItems: string[];
  revisions: string[];
  binding: Record<string, string>;
}

type ScriptedAudience = "root" | "implementation" | "exactness" | "formalize";

function collectRefs(value: unknown): ContextRefs {
  const serialized = JSON.stringify(value);
  const text = collectStrings(value).join("\n");
  const binding = Object.fromEntries(
    [
      ["reproId", "Repro"],
      ["workItemId", "WorkItem"],
      ["checkpointId", "Checkpoint"],
      ["sourceCheckpointId", "Source checkpoint"],
      ["parentCheckpointId", "Parent checkpoint"],
      ["sessionId", "Session"],
      ["taskRef", "TaskRef"],
      ["runRef", "RunRef"],
    ].flatMap(([key, label]) => {
      const match = [...text.matchAll(new RegExp(`^${label}: (.+)$`, "gmu"))].at(-1)?.[1]?.trim();
      return match && match !== "none" ? [[key, match]] : [];
    }),
  );
  const checkpoint = [...text.matchAll(/Execute Repro v10 checkpoint ([a-z_]+)/gu)].at(-1)?.[1];
  if (checkpoint) {
    binding.checkpoint = checkpoint;
    binding.lane = checkpoint.startsWith("implementation")
      ? "implementation"
      : checkpoint.startsWith("exactness")
        ? "exactness"
        : "formalize";
  }
  return {
    artifacts: uniqueMatches(serialized, /artifact:[a-z0-9-]+/giu),
    evidence: uniqueMatches(serialized, /evidence:[a-z0-9-]+/giu),
    tasks: uniqueMatches(serialized, /task:[a-z0-9-]+/giu),
    runs: uniqueMatches(serialized, /run:[a-z0-9-]+/giu),
    routes: uniqueMatches(serialized, /route:[a-z0-9._:-]+/giu),
    workItems: uniqueMatches(serialized, /work:[a-z0-9._:-]+/giu),
    revisions: uniqueMatches(serialized, /\b[a-f0-9]{40}\b/giu),
    binding,
  };
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectStrings);
}

function scriptedAudience(refs: ContextRefs): ScriptedAudience {
  const lane = refs.binding.lane;
  return lane === "implementation" || lane === "exactness" || lane === "formalize" ? lane : "root";
}

function uniqueMatches(value: string, pattern: RegExp): string[] {
  return [...new Set(value.match(pattern) ?? [])];
}

function interpolateValue(
  value: unknown,
  ledger: ScriptedProviderLedger,
  refs: ContextRefs,
): unknown {
  if (typeof value === "string") {
    return interpolate(value, ledger, refs);
  }
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
    if (name === "LAST_RUN_REF") return refs.runs.at(-1) ?? missing(name);
    if (name === "LAST_ROUTE_ID") return refs.routes.at(-1) ?? missing(name);
    if (name === "LAST_WORK_ITEM_ID") return refs.workItems.at(-1) ?? missing(name);
    if (name === "LAST_REVISION") return refs.revisions.at(-1) ?? missing(name);
    const bindingKey =
      /^BINDING_(REPRO_ID|WORK_ITEM_ID|CHECKPOINT_ID|SOURCE_CHECKPOINT_ID|PARENT_CHECKPOINT_ID|SESSION_ID|TASK_REF|RUN_REF|LANE|CHECKPOINT)$/u.exec(
        name,
      )?.[1];
    if (bindingKey) {
      const key =
        {
          REPRO_ID: "reproId",
          WORK_ITEM_ID: "workItemId",
          CHECKPOINT_ID: "checkpointId",
          SOURCE_CHECKPOINT_ID: "sourceCheckpointId",
          PARENT_CHECKPOINT_ID: "parentCheckpointId",
          SESSION_ID: "sessionId",
          TASK_REF: "taskRef",
          RUN_REF: "runRef",
          LANE: "lane",
          CHECKPOINT: "checkpoint",
        }[bindingKey] ?? "";
      return refs.binding[key] ?? missing(name);
    }
    const artifactIndex = /^ARTIFACT_REF_(\d+)$/u.exec(name)?.[1];
    if (artifactIndex) return refs.artifacts[Number(artifactIndex) - 1] ?? missing(name);
    const evidenceIndex = /^EVIDENCE_REF_(\d+)$/u.exec(name)?.[1];
    if (evidenceIndex) return refs.evidence[Number(evidenceIndex) - 1] ?? missing(name);
    const taskIndex = /^TASK_REF_(\d+)$/u.exec(name)?.[1];
    if (taskIndex) return refs.tasks[Number(taskIndex) - 1] ?? missing(name);
    const runIndex = /^RUN_REF_(\d+)$/u.exec(name)?.[1];
    if (runIndex) return refs.runs[Number(runIndex) - 1] ?? missing(name);
    const routeIndex = /^ROUTE_ID_(\d+)$/u.exec(name)?.[1];
    if (routeIndex) return refs.routes[Number(routeIndex) - 1] ?? missing(name);
    const revisionIndex = /^REVISION_(\d+)$/u.exec(name)?.[1];
    if (revisionIndex) return refs.revisions[Number(revisionIndex) - 1] ?? missing(name);
    return missing(name);
  });
}

function rememberPreviousRoundOutput(
  ledger: ScriptedProviderLedger,
  refs: ContextRefs,
  previous: string | undefined,
): void {
  const evidenceVariable =
    previous &&
    {
      "implementation.proof": "IMPLEMENTATION_PROOF_EVIDENCE",
      "implementation.result": "IMPLEMENTATION_RESULT_EVIDENCE",
      "implementation-attention.proof": "IMPLEMENTATION_ATTENTION_PROOF_EVIDENCE",
      "implementation-attention.result": "IMPLEMENTATION_ATTENTION_RESULT_EVIDENCE",
      "exactness.proof": "EXACTNESS_PROOF_EVIDENCE",
      "exactness.result": "EXACTNESS_RESULT_EVIDENCE",
      "formalize.proof": "FORMALIZE_PROOF_EVIDENCE",
      "formalize.result": "FORMALIZE_RESULT_EVIDENCE",
      "exactness-refresh.proof": "EXACTNESS_REFRESH_PROOF_EVIDENCE",
      "exactness-refresh.result": "EXACTNESS_REFRESH_RESULT_EVIDENCE",
      "implementation-refresh.proof": "IMPLEMENTATION_REFRESH_PROOF_EVIDENCE",
      "implementation-refresh.result": "IMPLEMENTATION_REFRESH_RESULT_EVIDENCE",
    }[previous];
  const evidenceRef = refs.evidence.at(-1);
  if (evidenceVariable && evidenceRef) (ledger.vars ??= {})[evidenceVariable] = evidenceRef;
}

function missing(name: string): never {
  throw new Error(`Scripted provider placeholder ${name} is unavailable`);
}
