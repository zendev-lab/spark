import { createHash } from "node:crypto";
import { Type } from "typebox";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import type {
  SparkHostContext,
  JsonValue,
  ExtensionEvidenceRequestBinding,
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/spark-core";
import { ToolCallText } from "@zendev-lab/spark-text";
import {
  createAutonomousAskInteractionRequestId,
  parseSparkMemoryApprovalBinding,
  sparkEvidenceRequestBindingSchema,
} from "@zendev-lab/spark-protocol";
import {
  isExplicitMemoryApprovalEvidenceBody,
  isUserAnsweredAskEvidenceBody,
  recordCanonicalAskEvidenceReceipt,
  type SparkAskEvidenceBody,
} from "./evidence.ts";
import { SparkAutonomousAsyncOnlyError } from "./autonomous-policy.ts";
import { summarizeAskResult, type AskSummaryAnswer } from "./summary.ts";
import { requireCanonicalAskTransport } from "./transport.ts";
import type { SparkAskAutoAnswerRequest } from "./action-contracts.ts";

export type SparkAskAction = "ask" | "flow" | "answer";
export type SparkAskAutoAnswerMode = boolean;
export const DEFAULT_ASK_WAIT_TIMEOUT_MS = 60 * 60_000;
const MAX_ASK_WAIT_TIMEOUT_MS = 24 * 60 * 60_000;

export type SparkAskDaemonRequest = (
  method: string,
  params?: unknown,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

export interface SparkAskActionToolApi {
  registerTool(config: ToolConfig): void;
}

export interface SparkAskActionToolOptions {
  resolveTool(name: "ask_user" | "ask_flow"): ToolConfig | undefined;
  autoAnswer?: SparkAskAutoAnswerResolver;
  request?: SparkAskDaemonRequest;
}
export interface SparkAskAutoAnswerQuestion {
  id: string;
  prompt: string;
  header?: string;
  type?: string;
  required?: boolean;
  defaultValues?: string[];
  options?: SparkAskAutoAnswerOption[];
}

export interface SparkAskAutoAnswerOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface SparkAskAutoAnswerEntry {
  values?: string[];
  customText?: string;
  notes?: string;
  comment?: string;
}

export interface SparkAskAutoAnswerResult {
  answers?: Record<string, SparkAskAutoAnswerEntry>;
  blocked?: boolean;
  reason?: string;
}

export type SparkAskAutoAnswerResolver = (
  request: SparkAskAutoAnswerRequest,
  ctx: SparkHostContext,
) => Promise<SparkAskAutoAnswerResult> | SparkAskAutoAnswerResult;

export type SparkAskAutoAnswerProvider = (
  request: SparkAskAutoAnswerRequest,
  ctx: SparkHostContext,
) => Promise<SparkAskAutoAnswerResult | undefined> | SparkAskAutoAnswerResult | undefined;

const AUTO_ANSWER_PROVIDER_REGISTRY_KEY = "__zendevLabSparkAskAutoAnswerProviders";

type GlobalWithSparkAskAutoAnswerProviders = typeof globalThis & {
  __zendevLabSparkAskAutoAnswerProviders?: Map<string, SparkAskAutoAnswerProvider>;
};

function autoAnswerProviderRegistry(): Map<string, SparkAskAutoAnswerProvider> {
  const globalObject = globalThis as GlobalWithSparkAskAutoAnswerProviders;
  globalObject[AUTO_ANSWER_PROVIDER_REGISTRY_KEY] ??= new Map();
  return globalObject[AUTO_ANSWER_PROVIDER_REGISTRY_KEY];
}

export function registerSparkAskAutoAnswerProvider(
  id: string,
  provider: SparkAskAutoAnswerProvider,
): () => void {
  const providers = autoAnswerProviderRegistry();
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) providers.delete(id);
  };
}

export function registerSparkAskActionTool(
  pi: SparkAskActionToolApi,
  options: SparkAskActionToolOptions,
): void {
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Canonical ask capability. Use action=ask for a structured user ask; action=flow forces the fullscreen multi-question ask_flow renderer. autoAnswer=true waits for the user first and lets the host reviewer take over only after that wait times out; ordinary asks do not auto-answer.",
    promptGuidelines: [
      "Use ask as the canonical structured-question tool instead of choosing between ask_user and ask_flow directly. Settlement may be the User or, when toSessionId is set, the asked Session.",
      "Use delivery=blocking when this turn cannot continue without the answer; delivery=async continues only after the host returns a correlated durable acknowledgement.",
      "Ask only context-specific questions whose answers change the next action, plan, dependency, priority, or success criteria.",
      "Set recordAsEvidence=true when a later evidence gate must prove the user answered this ask. Do not combine toSessionId with recordAsEvidence, autoAnswer, or evidenceRequest.",
      'Use ask({ action: "answer", humanRequestId, answers }) only to settle a pending ask addressed to this Session. Do not answer User-addressed asks.',
      "Use freeform questions for notes/context; do not create business options named Other or Type your own.",
      "Do not set autoAnswer unless the active host policy explicitly asks for reviewer fallback after the user wait expires.",
    ],
    policy: {
      effect: "external_write",
      executionMode: "sequential",
      domains: ["interaction", "human-decision"],
      modes: ["plan", "execute", "fleet"],
      approval: "none",
    },
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "ask | flow | answer. Defaults to ask." })),
      toSessionId: Type.Optional(
        Type.String({
          description:
            "Address the ask to this Session instead of User. Incompatible with evidenceRequest, autoAnswer, and recordAsEvidence.",
        }),
      ),
      humanRequestId: Type.Optional(
        Type.String({ description: "Pending ask id for action=answer." }),
      ),
      interactionRequestId: Type.Optional(
        Type.String({ description: "Host correlation id for action=answer." }),
      ),
      answers: Type.Optional(
        Type.Any({
          description: "Answer payload for action=answer keyed by question id.",
        }),
      ),
      autoAnswer: Type.Optional(
        Type.Boolean({
          description:
            "When true, ask the user first, then use the injected reviewer resolver only after the human wait times out.",
        }),
      ),
      recordAsEvidence: Type.Optional(
        Type.Boolean({
          description: "Persist the ask result as canonical evidence for a later decision gate.",
        }),
      ),
      title: Type.Optional(Type.String()),
      mode: Type.Optional(
        Type.String({ description: "clarification | decision | approval | unblock" }),
      ),
      delivery: Type.Optional(
        Type.String({ description: "blocking | async. Defaults to blocking." }),
      ),
      context: Type.Optional(Type.String()),
      approvalBinding: Type.Optional(Type.Any()),
      flow: Type.Optional(Type.String({ description: "Stable flow identifier for ask_flow." })),
      questions: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String(),
            prompt: Type.String(),
            header: Type.Optional(Type.String()),
            type: Type.Optional(
              Type.String({ description: "single | multi | preview | freeform" }),
            ),
            required: Type.Optional(Type.Boolean()),
            defaultValues: Type.Optional(Type.Array(Type.String())),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  value: Type.String(),
                  label: Type.String(),
                  description: Type.Optional(Type.String()),
                  preview: Type.Optional(Type.String()),
                }),
              ),
            ),
          }),
        ),
      ),
      behaviour: Type.Optional(
        Type.Object({
          allowElaborate: Type.Optional(Type.Boolean()),
          allowReplay: Type.Optional(Type.Boolean()),
          preservePriorAnswers: Type.Optional(Type.Boolean()),
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderAskCall(args, theme);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizeAskAction(params.action);
      if (action === "answer") {
        return await executeAskAnswer(params, ctx, options, signal);
      }
      params = canonicalizeMemoryApprovalAsk(params);
      const autoAnswer = normalizeAskAutoAnswerMode(
        params.autoAnswer ?? contextAutoAnswerMode(ctx),
      );
      const autonomous = ctx.sparkAutonomousAsk;
      if (autonomous && (params.delivery !== "async" || autoAnswer)) {
        throw new SparkAutonomousAsyncOnlyError(
          autoAnswer
            ? "autoAnswer/reviewer fallback is forbidden in active Goal/Repro"
            : "delivery must be explicitly async in active Goal/Repro",
        );
      }
      if (params.recordAsEvidence === true && params.delivery === "async" && !autonomous) {
        throw new Error("ask.recordAsEvidence cannot be combined with delivery=async");
      }
      if (params.recordAsEvidence === true && autoAnswer) {
        throw new Error("ask.recordAsEvidence requires a direct user answer, not autoAnswer");
      }
      if (autoAnswer && params.delivery === "async") {
        throw new Error("ask.autoAnswer cannot be combined with delivery=async");
      }
      const toSessionId = typeof params.toSessionId === "string" ? params.toSessionId.trim() : "";
      if (toSessionId) {
        if (autoAnswer) throw new Error("ask.toSessionId cannot be combined with autoAnswer");
        if (params.recordAsEvidence === true) {
          throw new Error("ask.toSessionId cannot be combined with recordAsEvidence");
        }
        if (params.evidenceRequest !== undefined) {
          throw new Error("ask.toSessionId cannot be combined with evidenceRequest");
        }
        if (autonomous) {
          throw new Error("ask.toSessionId cannot be combined with autonomous evidence binding");
        }
      }
      const autoAnswerResolver = options.autoAnswer ?? contextAutoAnswerResolver(ctx);
      if (autoAnswer && !autoAnswerResolver && autoAnswerProviderRegistry().size === 0) {
        return blockedAutoAnswerResult(params, missingAutoAnswerResolverReason());
      }
      const target = selectAskTarget(action, params);
      const tool = options.resolveTool(target);
      if (!tool) throw new Error(`ask action adapter could not find ${target}`);
      let forwarded = stripAdapterOnlyParams(params);
      if (autonomous) {
        const bound = await createAutonomousEvidenceRequest(params, autonomous);
        forwarded = {
          ...forwarded,
          delivery: "async",
          interactionRequestId: bound.interactionRequestId,
          evidenceRequest: bound.evidenceRequest,
        };
      }
      const delivery = forwarded.delivery === "async" ? "async" : "blocking";
      const transport = requireCanonicalAskTransport(ctx, {
        delivery,
        autoAnswer: autoAnswer === true,
      });
      const waitTimeoutMs = contextAskWaitTimeoutMs(ctx);
      const humanParams =
        delivery === "blocking" && transport === "protocol"
          ? { ...forwarded, timeoutMs: waitTimeoutMs }
          : forwarded;
      const dispatchCtx = autonomous
        ? ({ ...ctx, sparkCanonicalAskDispatch: true } as SparkHostContext)
        : ctx;
      if (!autoAnswer) {
        const result = await tool.execute(toolCallId, humanParams, signal, onUpdate, dispatchCtx);
        return autonomous ? result : maybeRecordAskEvidence(params, result, ctx);
      }
      const humanResult = await tool.execute(toolCallId, humanParams, signal, onUpdate, ctx);
      if (!didHumanAskTimeOut(humanResult)) return humanResult;
      const request = decodeAutoAnswerRequest(params);
      const autoAnswered = autoAnswerResolver
        ? await autoAnswerResolver(request, ctx)
        : await resolveAutoAnswerFromProviders(request, ctx);
      if (!autoAnswered) return blockedAutoAnswerResult(params, missingAutoAnswerResolverReason());
      const blocked = validateAutoAnswerResult(request, autoAnswered);
      if (blocked) return blockedAutoAnswerResult(params, blocked);
      const syntheticCtx = withSyntheticAutoAnswerUi(ctx, request, autoAnswered.answers ?? {});
      const result = await tool.execute(toolCallId, forwarded, signal, onUpdate, syntheticCtx);
      return annotateAutoAnswerResult(result, autoAnswered, waitTimeoutMs);
    },
  });
}

async function executeAskAnswer(
  params: Record<string, unknown>,
  ctx: SparkHostContext,
  options: SparkAskActionToolOptions,
  signal: AbortSignal,
) {
  const request = options.request;
  if (!request) throw new Error("ask answer requires a daemon request");
  const sessionId = typeof ctx.sessionId === "string" ? ctx.sessionId.trim() : "";
  if (!sessionId) throw new Error("ask answer requires a current Session");
  const humanRequestId = optionalString(params.humanRequestId)?.trim();
  const interactionRequestId = optionalString(params.interactionRequestId)?.trim();
  if (!humanRequestId && !interactionRequestId) {
    throw new Error("ask answer requires humanRequestId or interactionRequestId");
  }
  if (!isRecord(params.answers) || Array.isArray(params.answers)) {
    throw new Error("ask answer requires answers");
  }
  const result = await request(
    "human.interaction.respond",
    {
      ...(humanRequestId ? { humanRequestId } : {}),
      ...(interactionRequestId ? { interactionRequestId } : {}),
      respondentSessionId: sessionId,
      status: "answered",
      provenance: "session",
      answers: params.answers,
    },
    { signal },
  );
  return {
    content: [{ type: "text" as const, text: "Answered the session ask." }],
    details: { action: "answer" as const, result },
  };
}

function canonicalizeMemoryApprovalAsk(params: Record<string, unknown>): Record<string, unknown> {
  if (params.approvalBinding === undefined) return params;
  const binding = parseSparkMemoryApprovalBinding(params.approvalBinding);
  if (params.recordAsEvidence !== true || params.mode !== "approval") {
    throw new Error("ask.approvalBinding requires mode=approval and recordAsEvidence=true");
  }
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const approvalIndex = questions.findIndex(
    (question) => isRecord(question) && question.id === "approval",
  );
  if (approvalIndex < 0) {
    throw new Error('ask.approvalBinding requires a question with id="approval"');
  }
  const canonicalQuestion = {
    id: "approval",
    prompt: `Approve memory ${binding.operation} for ${binding.recordRef}?`,
    type: "single",
    required: true,
    defaultValues: ["deny"],
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Authorize this exact proposal once before its expiry.",
      },
      {
        value: "deny",
        label: "Deny",
        description: "Do not mutate durable memory.",
      },
    ],
  };
  const canonicalContext = [
    optionalString(params.context)?.trim(),
    "Memory mutation approval",
    `operation=${binding.operation}`,
    `record=${binding.recordRef}`,
    `scope=${binding.scope}`,
    `expectedRevision=${binding.expectedRevision}`,
    `proposal=${binding.proposalId}`,
    `proposalDigest=${binding.proposalDigest}`,
    `expiresAt=${binding.expiresAt}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    ...params,
    context: canonicalContext,
    approvalBinding: binding,
    questions: questions.map((question, index) =>
      index === approvalIndex ? canonicalQuestion : question,
    ),
  };
}

function normalizeAskAction(value: unknown): SparkAskAction {
  if (value === undefined || value === null || value === "ask") return "ask";
  if (value === "flow") return "flow";
  if (value === "answer") return "answer";
  throw new Error("ask.action must be ask, flow, or answer");
}

function normalizeAskAutoAnswerMode(value: unknown): SparkAskAutoAnswerMode | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return true;
  throw new Error("ask.autoAnswer must be a boolean when provided");
}

async function createAutonomousEvidenceRequest(
  params: Record<string, unknown>,
  policy: NonNullable<SparkHostContext["sparkAutonomousAsk"]>,
): Promise<{
  interactionRequestId: string;
  evidenceRequest: ExtensionEvidenceRequestBinding;
}> {
  const resolved = await policy.resolveBinding(params);
  const ownerQuestion = autonomousOwnerQuestion(params);
  const requestHash = createHash("sha256")
    .update(
      canonicalJson({
        request: decodeAutoAnswerRequest(params),
        ownerSessionId: policy.ownerSessionId,
        goalOrReproId: policy.goalOrReproId,
        modeScope: policy.modeScope,
        ...resolved,
      }),
    )
    .digest("hex");
  const evidenceRequest = sparkEvidenceRequestBindingSchema.parse({
    schema: "spark.evidence-request/v1",
    askRef: `ask:${requestHash}`,
    ownerSessionId: policy.ownerSessionId,
    goalOrReproId: policy.goalOrReproId,
    modeScope: policy.modeScope,
    planRevision: resolved.planRevision,
    ownerStepOrUnresolvedId: resolved.ownerStepOrUnresolvedId,
    stepDefinitionDigest: resolved.stepDefinitionDigest,
    requestHash,
    ownerQuestionId: ownerQuestion.id,
    expectedAnswerKind: ownerQuestion.kind,
  }) as ExtensionEvidenceRequestBinding;
  return {
    interactionRequestId: createAutonomousAskInteractionRequestId(requestHash),
    evidenceRequest,
  };
}

function autonomousOwnerQuestion(params: Record<string, unknown>): {
  id: string;
  kind: ExtensionEvidenceRequestBinding["expectedAnswerKind"];
} {
  const questions = Array.isArray(params.questions)
    ? (params.questions as Array<Record<string, unknown>>)
    : [];
  const owner =
    params.mode === "approval"
      ? (questions.find((question) => question.id === "approval") ?? questions[0])
      : questions[0];
  if (!owner || typeof owner.id !== "string" || !owner.id.trim()) {
    throw new Error("AUTONOMOUS_EVIDENCE_BINDING_REQUIRED: owner question is unavailable");
  }
  const type = owner.type ?? "single";
  if (params.mode === "approval") {
    if (type !== "single") {
      throw new Error("AUTONOMOUS_EVIDENCE_BINDING_REQUIRED: approval owner must be single-choice");
    }
    return { id: owner.id.trim(), kind: "approval" };
  }
  if (type === "freeform" || type === "multi") return { id: owner.id.trim(), kind: type };
  if (type === "single" || type === "preview") return { id: owner.id.trim(), kind: "single" };
  throw new Error("AUTONOMOUS_EVIDENCE_BINDING_REQUIRED: owner question type is invalid");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Ask request contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Ask request contains unsupported ${typeof value}`);
}

function contextAutoAnswerMode(ctx: SparkHostContext): unknown {
  return (ctx as { askAutoAnswer?: unknown }).askAutoAnswer;
}

function contextAutoAnswerResolver(ctx: SparkHostContext): SparkAskAutoAnswerResolver | undefined {
  const resolver = (ctx as { askAutoAnswerResolver?: unknown }).askAutoAnswerResolver;
  return typeof resolver === "function" ? (resolver as SparkAskAutoAnswerResolver) : undefined;
}

function contextAskWaitTimeoutMs(ctx: SparkHostContext): number {
  const policy = ctx as {
    askWaitTimeoutMs?: unknown;
    askReviewerFallbackAfterMs?: unknown;
  };
  const value = policy.askWaitTimeoutMs ?? policy.askReviewerFallbackAfterMs;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ASK_WAIT_TIMEOUT_MS;
  }
  return Math.min(MAX_ASK_WAIT_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function didHumanAskTimeOut(result: Awaited<ReturnType<ToolConfig["execute"]>>): boolean {
  return (
    isRecord(result.details) &&
    isRecord(result.details.result) &&
    result.details.result.timedOut === true
  );
}

function describeAskResultStatus(
  result: Awaited<ReturnType<ToolConfig["execute"]>>,
  request?: SparkAskAutoAnswerRequest,
): string {
  const details = isRecord(result.details) ? result.details : undefined;
  const inner = details && isRecord(details.result) ? details.result : undefined;
  const status = typeof inner?.status === "string" ? inner.status : undefined;
  if (status === "pending") return "status=pending (async/inbox request, no answer yet)";
  if (status === "cancelled") return "status=cancelled (no user answer)";
  if (status === "no_selection" && request) {
    return summarizeAskResult(request, {
      status: "no_selection",
      answers: askSummaryAnswers(inner?.answers),
    });
  }
  if (status === "no_selection") return "status=no_selection (no answers submitted)";
  if (status) return `status=${status}`;
  return inner ? "an incomplete ask result" : "no ask result payload";
}

function askSummaryAnswers(value: unknown): Record<string, AskSummaryAnswer> {
  if (!isRecord(value)) return {};
  const answers: Record<string, AskSummaryAnswer> = {};
  for (const [questionId, rawAnswer] of Object.entries(value)) {
    if (!isRecord(rawAnswer)) continue;
    const values = stringArray(rawAnswer.values) ?? [];
    const labels = stringArray(rawAnswer.labels);
    const customText = optionalString(rawAnswer.customText)?.trim();
    if (!values.some((item) => item.trim()) && !customText) continue;
    answers[questionId] = {
      values,
      ...(labels && labels.length > 0 ? { labels } : {}),
      ...(customText ? { customText } : {}),
    };
  }
  return answers;
}

async function resolveAutoAnswerFromProviders(
  request: SparkAskAutoAnswerRequest,
  ctx: SparkHostContext,
): Promise<SparkAskAutoAnswerResult | undefined> {
  for (const provider of autoAnswerProviderRegistry().values()) {
    const answer = await provider(request, ctx);
    if (answer) return answer;
  }
  return undefined;
}

function selectAskTarget(
  action: Exclude<SparkAskAction, "answer">,
  params: Record<string, unknown>,
): "ask_user" | "ask_flow" {
  if (action === "flow") return "ask_flow";
  if (typeof params.flow === "string" && params.flow.trim()) return "ask_flow";
  if (params.behaviour !== undefined) return "ask_flow";
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length !== 1) return "ask_flow";
  const [question] = questions as Array<Record<string, unknown>>;
  if (question?.header !== undefined || question?.type === "preview") return "ask_flow";
  if (Array.isArray(question?.options) && question.options.some((option) => hasPreview(option))) {
    return "ask_flow";
  }
  return "ask_user";
}

function stripAdapterOnlyParams(params: Record<string, unknown>): Record<string, unknown> {
  const {
    action: _action,
    autoAnswer: _autoAnswer,
    recordAsEvidence: _recordAsEvidence,
    timeoutMs: _timeoutMs,
    ...rest
  } = params;
  return rest;
}

async function maybeRecordAskEvidence(
  params: Record<string, unknown>,
  result: Awaited<ReturnType<ToolConfig["execute"]>>,
  ctx: SparkHostContext,
) {
  if (params.recordAsEvidence !== true) return result;
  const cwd = typeof ctx.cwd === "string" ? ctx.cwd : undefined;
  if (!cwd) throw new Error("ask recordAsEvidence requires a workspace cwd");
  const askRequest = decodeAutoAnswerRequest(params);
  const body: SparkAskEvidenceBody = {
    schema: "spark.ask.evidence/v2",
    request: askRequest,
    result: isRecord(result.details) ? (result.details.result ?? null) : null,
    answerSource: "user",
    autoAnswered: false,
    recordedAt: new Date().toISOString(),
  };
  if (!isUserAnsweredAskEvidenceBody(body)) {
    if (didHumanAskTimeOut(result)) return result;
    throw new Error(
      `ask.recordAsEvidence requires a completed user-answered result (observed ${describeAskResultStatus(result, askRequest)}). ` +
        "No evidence was recorded and no decision proof exists. Re-ask the same question when a user can answer, " +
        "or continue with work that does not depend on this decision; never substitute a prior or synthesized approval.",
    );
  }
  if (params.approvalBinding && !isExplicitMemoryApprovalEvidenceBody(body)) {
    throw new Error("ask.approvalBinding requires the user to select approve");
  }
  let evidenceBody: JsonValue;
  try {
    evidenceBody = JSON.parse(JSON.stringify(body)) as JsonValue;
  } catch (error) {
    throw new Error("ask evidence body must be JSON-serializable", { cause: error });
  }
  const evidence = await defaultEvidenceStore(cwd, ctx).put({
    kind: "record",
    title: `Ask evidence: ${optionalString(params.title)?.trim() || "user decision"}`,
    format: "json",
    body: evidenceBody,
    provenance: { producer: "ask" },
  });
  await recordCanonicalAskEvidenceReceipt(cwd, evidence, ctx);
  return {
    ...result,
    details: {
      ...(isRecord(result.details) ? result.details : {}),
      askEvidenceRef: evidence.ref,
    },
  };
}

function hasPreview(value: unknown): boolean {
  return typeof value === "object" && value !== null && "preview" in value;
}

function decodeAutoAnswerRequest(params: Record<string, unknown>): SparkAskAutoAnswerRequest {
  return {
    title: optionalString(params.title),
    mode: optionalString(params.mode),
    context: optionalString(params.context),
    approvalBinding:
      params.approvalBinding === undefined
        ? undefined
        : parseSparkMemoryApprovalBinding(params.approvalBinding),
    flow: optionalString(params.flow),
    questions: Array.isArray(params.questions)
      ? params.questions.map((question) => decodeAutoAnswerQuestion(question))
      : [],
  };
}

function decodeAutoAnswerQuestion(value: unknown): SparkAskAutoAnswerQuestion {
  const raw = isRecord(value) ? value : {};
  return {
    id: optionalString(raw.id) ?? "",
    prompt: optionalString(raw.prompt) ?? "",
    header: optionalString(raw.header),
    type: optionalString(raw.type),
    required: raw.required === true,
    defaultValues: stringArray(raw.defaultValues),
    options: Array.isArray(raw.options)
      ? raw.options.map((option) => decodeAutoAnswerOption(option))
      : undefined,
  };
}

function decodeAutoAnswerOption(value: unknown): SparkAskAutoAnswerOption {
  const raw = isRecord(value) ? value : {};
  return {
    value: optionalString(raw.value) ?? "",
    label: optionalString(raw.label) ?? "",
    description: optionalString(raw.description),
    preview: optionalString(raw.preview),
  };
}

function validateAutoAnswerResult(
  request: SparkAskAutoAnswerRequest,
  result: SparkAskAutoAnswerResult,
): string | undefined {
  if (result.blocked) return result.reason || "reviewer auto-answer blocked";
  const answers = result.answers ?? {};
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  for (const question of request.questions) {
    if (!question.required) continue;
    const answer = answers[question.id];
    if (!answer) return `reviewer auto-answer did not answer required question ${question.id}`;
  }
  for (const [questionId, answer] of Object.entries(answers)) {
    const question = questions.get(questionId);
    if (!question) return `reviewer answered unknown question ${questionId}`;
    const values = answer.values ?? [];
    if ((question.type ?? "single") === "freeform") {
      if (question.required && !answer.customText && !answer.notes && !answer.comment)
        return `reviewer answer for ${questionId} did not provide freeform text`;
      continue;
    }
    const allowed = new Set((question.options ?? []).map((option) => option.value));
    for (const value of values) {
      if (!allowed.has(value))
        return `reviewer answer for ${questionId} used invalid option ${value}`;
    }
    if ((question.type ?? "single") !== "multi" && values.length > 1)
      return `reviewer answer for ${questionId} selected multiple values for a single-choice question`;
    if (values.length === 0 && !answer.customText)
      return `reviewer answer for ${questionId} did not provide a value or custom text`;
  }
  return undefined;
}

function withSyntheticAutoAnswerUi(
  ctx: SparkHostContext,
  _request: SparkAskAutoAnswerRequest,
  answers: Record<string, SparkAskAutoAnswerEntry>,
): SparkHostContext {
  const interaction = async (interactionRequest: { requestId?: unknown }) => ({
    kind: "askFlow" as const,
    requestId:
      typeof interactionRequest.requestId === "string"
        ? interactionRequest.requestId
        : `ask-reviewer:${Date.now().toString(36)}`,
    status: "answered" as const,
    answers,
  });
  const syntheticContext: SparkHostContext & { askAnswerSource: "reviewer" } = {
    ...(isRecord(ctx) ? ctx : {}),
    askAnswerSource: "reviewer",
    ui: {
      ...(isRecord(ctx) && isRecord(ctx.ui) ? ctx.ui : {}),
      interaction,
      custom: undefined,
    },
  };
  return syntheticContext;
}

function missingAutoAnswerResolverReason(): string {
  return [
    "ask autoAnswer=true cannot run because this tool call did not receive a host-provided reviewer auto-answer resolver.",
    "Spark injects that resolver only for active goal turns and deliberately clears it for /implement or ordinary manual asks.",
    "Start or resume a goal and run the goal turn, or omit autoAnswer for a normal user-facing ask.",
    "If a session goal is already active and this still appears, the Spark goal ask-auto-answer policy did not attach its resolver to the current tool context.",
  ].join(" ");
}

function blockedAutoAnswerResult(params: Record<string, unknown>, reason: string) {
  const request = decodeAutoAnswerRequest(params);
  return {
    content: [{ type: "text" as const, text: `Ask auto-answer blocked: ${reason}` }],
    details: {
      request,
      result: { status: "no_selection", cancelled: false, answers: {}, nextAction: "block" },
      autoAnswered: false,
      blocked: true,
      error: "auto_answer_blocked",
      reason,
    },
    isError: true,
  };
}

function annotateAutoAnswerResult(
  result: Awaited<ReturnType<ToolConfig["execute"]>>,
  autoAnswered: SparkAskAutoAnswerResult,
  humanTimeoutMs: number,
) {
  return {
    ...result,
    details: {
      ...(isRecord(result.details) ? result.details : {}),
      answerSource: "reviewer",
      result: isRecord(result.details?.result)
        ? { ...result.details.result, answerSource: "reviewer" }
        : result.details?.result,
      autoAnswered: true,
      autoAnswer: {
        mode: "reviewer",
        reason: autoAnswered.reason,
        takeover: "human_timeout",
        humanTimeoutMs,
      },
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function renderAskCall(args: Record<string, unknown>, theme: ToolRenderTheme): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "ask";
  const title = typeof args.title === "string" ? args.title : undefined;
  const questionCount = Array.isArray(args.questions) ? `${args.questions.length}q` : undefined;
  const autoAnswer = args.autoAnswer === true ? "auto=true" : undefined;
  const text = ["ask", `action=${action}`, autoAnswer, title, questionCount]
    .filter(Boolean)
    .join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
