import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

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
  checkpoint?: string;
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
  releasedCheckpoints?: string[];
  checkpointWaits?: Array<{
    checkpoint: string;
    label: string;
    daemonPid: number;
    cursor: number;
    providerHighWater: number;
  }>;
  vars?: Record<string, string>;
  refs?: ContextRefs;
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
        const toolApprovalReview = serializedContext.includes(
          "Review this Spark tool-call approval request before execution.",
        );
        const reviewerRequest = availableTools.some(
          (tool) => (tool as { name?: unknown }).name === "role_report_outcome",
        );
        const taskCompletionReview =
          !toolApprovalReview &&
          (reviewerRequest || serializedContext.includes("spark.task-finish-review-packet/v1"));
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
          return stream;
        }
        let round = ledger.rounds[ledger.cursor];
        if (!round) {
          throw new Error(
            `Spark Repro scripted provider received unexpected request ${ledger.cursor + 1}; configured ${ledger.rounds.length} round(s)`,
          );
        }
        if (round.checkpoint && !(ledger.releasedCheckpoints ?? []).includes(round.checkpoint)) {
          const waits = (ledger.checkpointWaits ??= []);
          if (
            !waits.some(
              (wait) => wait.checkpoint === round.checkpoint && wait.daemonPid === process.pid,
            )
          ) {
            waits.push({
              checkpoint: round.checkpoint,
              label: round.label,
              daemonPid: process.pid,
              cursor: ledger.cursor,
              providerHighWater: ledger.requests.length,
            });
          }
          return createCheckpointStream({
            path,
            checkpoint: round.checkpoint,
            cursor: ledger.cursor,
            model,
            context,
            options,
          });
        }
        if (round.checkpoint) {
          ledger.cursor += 1;
          const resumedRound = ledger.rounds[ledger.cursor];
          if (!resumedRound || resumedRound.checkpoint) {
            throw new Error(`Checkpoint ${round.checkpoint} has no resumable owner round`);
          }
          round = resumedRound;
        }
        const refs = collectLedgerRefs(ledger, context);
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

function createCheckpointStream(input: {
  path: string;
  checkpoint: string;
  cursor: number;
  model: unknown;
  context: unknown;
  options: unknown;
}) {
  const delegate = waitForCheckpointRelease(input);
  return {
    async *[Symbol.asyncIterator]() {
      const stream = await delegate;
      for await (const event of stream) yield event;
    },
    result: async () => await (await delegate).result(),
  };
}

async function waitForCheckpointRelease(input: {
  path: string;
  checkpoint: string;
  cursor: number;
  model: unknown;
  context: unknown;
  options: unknown;
}) {
  for (;;) {
    const ledger = readLedger(input.path);
    if ((ledger.releasedCheckpoints ?? []).includes(input.checkpoint)) {
      if (ledger.cursor !== input.cursor) {
        throw new Error(
          `Checkpoint ${input.checkpoint} cursor changed from ${input.cursor} to ${ledger.cursor}`,
        );
      }
      const marker = ledger.rounds[ledger.cursor];
      if (!marker || marker.checkpoint !== input.checkpoint) {
        throw new Error(`Checkpoint ${input.checkpoint} no longer owns cursor ${ledger.cursor}`);
      }
      ledger.cursor += 1;
      const round = ledger.rounds[ledger.cursor];
      if (!round || round.checkpoint) {
        throw new Error(`Checkpoint ${input.checkpoint} has no resumable owner round`);
      }
      const refs = collectLedgerRefs(ledger, input.context);
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
        input.model as Parameters<typeof provider.streamFunction>[0],
        input.context as Parameters<typeof provider.streamFunction>[1],
        input.options as Parameters<typeof provider.streamFunction>[2],
      );
      ledger.cursor += 1;
      const request = provider.requests[0];
      if (request) ledger.requests.push(requestRecord(request));
      writeLedger(input.path, ledger);
      return stream;
    }
    const aborted = (input.options as { signal?: AbortSignal } | undefined)?.signal?.aborted;
    if (aborted) throw new Error(`Checkpoint ${input.checkpoint} provider request was aborted`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

function collectLedgerRefs(ledger: ScriptedProviderLedger, value: unknown): ContextRefs {
  const observed = collectRefs(value);
  const refs = {
    artifacts: uniqueStrings([...(ledger.refs?.artifacts ?? []), ...observed.artifacts]),
    evidence: uniqueStrings([...(ledger.refs?.evidence ?? []), ...observed.evidence]),
    tasks: uniqueStrings([...(ledger.refs?.tasks ?? []), ...observed.tasks]),
  };
  ledger.refs = refs;
  return refs;
}

function collectRefs(value: unknown): ContextRefs {
  const serialized = JSON.stringify(value);
  return {
    artifacts: uniqueMatches(serialized, /artifact:[a-z0-9-]+/giu),
    evidence: uniqueMatches(serialized, /evidence:[a-z0-9-]+(?::[a-z0-9-]+)*/giu),
    tasks: uniqueMatches(serialized, /task:[a-z0-9-]+/giu),
  };
}

function uniqueMatches(value: string, pattern: RegExp): string[] {
  return uniqueStrings(value.match(pattern) ?? []);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
