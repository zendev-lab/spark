import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
        rememberPreviousRoundOutput(ledger, path, refs, ledger.lastLabels?.[audience]);
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
  return {
    artifacts: uniqueMatches(serialized, /artifact:[a-z0-9-]+/giu),
    evidence: uniqueMatches(serialized, /evidence:[a-z0-9-]+/giu),
    tasks: uniqueMatches(serialized, /task:[a-z0-9-]+/giu),
    runs: uniqueMatches(serialized, /run:[a-z0-9-]+/giu),
    routes: uniqueMatches(serialized, /route:[a-z0-9._:-]+/giu),
    workItems: uniqueMatches(serialized, /work:[a-z0-9._:-]+/giu),
    revisions: uniqueMatches(serialized, /\b[a-f0-9]{40}\b/giu),
    binding: Object.fromEntries(
      [
        "reproId",
        "workItemId",
        "lane",
        "originRouteId",
        "planRevision",
        "bindingRevision",
        "taskRef",
        "runRef",
        "gitChangeRef",
        "sourceRevision",
      ].flatMap((key) => {
        const value = [...serialized.matchAll(new RegExp(`${key}=([^\\\\"]+)`, "gu"))].at(-1)?.[1];
        return value ? [[key, value]] : [];
      }),
    ),
  };
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
    if (value === "${BINDING_PLAN_REVISION}" || value === "${BINDING_REVISION}") {
      const number = Number(interpolate(value, ledger, refs));
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`Scripted provider placeholder ${value} is not a positive integer`);
      }
      return number;
    }
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
      /^BINDING_(REPRO_ID|WORK_ITEM_ID|ROUTE_ID|PLAN_REVISION|REVISION|TASK_REF|RUN_REF|GIT_CHANGE_REF|SOURCE_REVISION)$/u.exec(
        name,
      )?.[1];
    if (bindingKey) {
      const key =
        {
          REPRO_ID: "reproId",
          WORK_ITEM_ID: "workItemId",
          ROUTE_ID: "originRouteId",
          PLAN_REVISION: "planRevision",
          REVISION: "bindingRevision",
          TASK_REF: "taskRef",
          RUN_REF: "runRef",
          GIT_CHANGE_REF: "gitChangeRef",
          SOURCE_REVISION: "sourceRevision",
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
  ledgerPath: string,
  refs: ContextRefs,
  previous: string | undefined,
): void {
  if (previous === "implementation.head" || previous === "formalize.head") {
    const revision = bindingHeadRevision(ledgerPath, refs.binding.gitChangeRef);
    if (previous === "implementation.head" && refs.binding.sourceRevision) {
      (ledger.vars ??= {}).BASELINE_REVISION = refs.binding.sourceRevision;
    }
    (ledger.vars ??= {})[
      previous === "implementation.head" ? "CANDIDATE_REVISION" : "CANONICAL_REVISION"
    ] = revision;
  }
  const evidenceVariable =
    previous &&
    {
      "implementation.validation.evidence": "IMPLEMENTATION_VALIDATION_EVIDENCE",
      "implementation.result": "IMPLEMENTATION_RESULT_EVIDENCE",
      "implementation-attention.context": "IMPLEMENTATION_ATTENTION_CONTEXT_EVIDENCE",
      "implementation-attention.result": "IMPLEMENTATION_ATTENTION_RESULT_EVIDENCE",
      "exactness.validation.evidence": "EXACTNESS_VALIDATION_EVIDENCE",
      "exactness.result": "EXACTNESS_RESULT_EVIDENCE",
      "formalize.validation.evidence": "FORMALIZE_VALIDATION_EVIDENCE",
      "formalize.result": "FORMALIZE_RESULT_EVIDENCE",
      "exactness-refresh.validation.evidence": "EXACTNESS_REFRESH_VALIDATION_EVIDENCE",
      "exactness-refresh.result": "EXACTNESS_REFRESH_RESULT_EVIDENCE",
      "implementation-refresh.validation.evidence": "IMPLEMENTATION_REFRESH_VALIDATION_EVIDENCE",
      "implementation-refresh.result": "IMPLEMENTATION_REFRESH_RESULT_EVIDENCE",
    }[previous];
  const evidenceRef = refs.evidence.at(-1);
  if (evidenceVariable && evidenceRef) (ledger.vars ??= {})[evidenceVariable] = evidenceRef;
}

function bindingHeadRevision(ledgerPath: string, artifactRef: string | undefined): string {
  if (!artifactRef?.startsWith("artifact:")) {
    throw new Error("Scripted provider binding has no GitChangeRef");
  }
  const artifactPath = resolve(
    dirname(ledgerPath),
    "fixture-repo/.spark/artifacts",
    `${artifactRef.slice("artifact:".length)}.json`,
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    body?: { kind?: unknown; worktree?: { path?: unknown } };
  };
  const worktreePath = artifact.body?.worktree?.path;
  if (artifact.body?.kind !== "git_change" || typeof worktreePath !== "string") {
    throw new Error(`Scripted provider binding ${artifactRef} is not a GitChange`);
  }
  const revision = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error(`Scripted provider received invalid ${artifactRef} HEAD`);
  }
  return revision;
}

function missing(name: string): never {
  throw new Error(`Scripted provider placeholder ${name} is unavailable`);
}
