import type { SparkAskAnswerSource } from "./answer-source.ts";
import type { SparkAskFlowAnswerEntry, SparkAskFlowRequest, SparkAskFlowResult } from "./schema.ts";
import { formatAskAnswerForDisplay, missingRequiredAskAnswerIds } from "./shared-semantics.ts";

export interface AskSummaryAnswer {
  values: string[];
  labels?: string[];
  customText?: string;
  preview?: string;
}

export interface AskSummaryResult {
  status: "answered" | "pending" | "cancelled" | "no_selection";
  humanRequestId?: string;
  answerSource?: SparkAskAnswerSource;
  answers: Record<string, AskSummaryAnswer>;
  nextAction?: "resume" | "clarify_then_reask" | "block";
  mode?: string;
}

export interface AskSummaryRequest {
  title?: string;
  flow?: string;
  mode?: string;
  questions?: ReadonlyArray<{
    id: string;
    prompt?: string;
    required?: boolean;
  }>;
}

export interface AskEvidenceBody<Req = AskSummaryRequest, Res = AskSummaryResult> {
  request: Req;
  result: Res;
  summary: string;
}

export function summarizeAskResult(
  request: AskSummaryRequest,
  result: AskSummaryResult,
  options: { prefix?: string; blocked?: boolean } = {},
): string {
  const title = request.title ?? request.flow ?? options.prefix ?? "ask";
  const answerText = summarizeAskAnswers(result.answers);
  const blockedPrefix = options.blocked ? " blocked" : "";
  if (result.status === "pending") {
    return `${title}: pending${result.humanRequestId ? `; request=${result.humanRequestId}` : ""}`;
  }
  if (result.status !== "answered") {
    if (result.status !== "no_selection") {
      return `${title}${blockedPrefix}: ${result.status}; ${answerText}`;
    }
    const partialPrefix = answerText === "no selection" ? "" : "partial answers: ";
    const missing = missingRequiredAskAnswerIds(
      {
        mode: request.mode,
        questions: request.questions?.map(({ id, required }) => ({ id, required })) ?? [],
      },
      result.answers,
    );
    const missingText =
      missing.length > 0
        ? `; missing required: ${missing.map((id) => formatMissingQuestion(request, id)).join(", ")}`
        : "";
    return `${title}${blockedPrefix}: ${result.status}; ${partialPrefix}${answerText}${missingText}`;
  }
  const nextAction =
    result.nextAction && result.nextAction !== "resume" ? `; next=${result.nextAction}` : "";
  const source = result.answerSource ? `; source=${result.answerSource}` : "";
  return `${title}${blockedPrefix}: answered; ${answerText}${nextAction}${source}`;
}

export function summarizeAskAnswers(answers: Record<string, AskSummaryAnswer>): string {
  const entries = Object.entries(answers);
  if (entries.length === 0) return "no selection";
  if (entries.length === 1 && entries[0]?.[0] === "answer") {
    return formatAskAnswerForDisplay(entries[0][1]);
  }
  return entries.map(([id, answer]) => `${id}=${formatAskAnswerForDisplay(answer)}`).join("; ");
}

function formatMissingQuestion(request: AskSummaryRequest, id: string): string {
  const prompt = request.questions?.find((question) => question.id === id)?.prompt?.trim();
  return prompt ? `${id} (${prompt})` : id;
}

export function createAskEvidenceBody<Req extends AskSummaryRequest, Res extends AskSummaryResult>(
  request: Req,
  result: Res,
  options: { blocked?: boolean } = {},
): AskEvidenceBody<Req, Res> {
  return omitUndefinedFields({
    request,
    result,
    summary: summarizeAskResult(request, result, options),
  }) as AskEvidenceBody<Req, Res>;
}

export function createSparkAskFlowEvidenceBody(
  request: SparkAskFlowRequest,
  result: SparkAskFlowResult,
  options: { blocked?: boolean } = {},
): AskEvidenceBody<SparkAskFlowRequest, SparkAskFlowResult> {
  return createAskEvidenceBody(request, result, options);
}

export function isAskEvidenceBody(value: unknown): value is AskEvidenceBody {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { request?: unknown }).request === "object" &&
    typeof (value as { result?: unknown }).result === "object" &&
    typeof (value as { summary?: unknown }).summary === "string",
  );
}

export function answerEntriesFromFlow(
  answers: Record<string, SparkAskFlowAnswerEntry>,
): Record<string, AskSummaryAnswer> {
  return answers;
}

function omitUndefinedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : omitUndefinedFields(item)));
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = omitUndefinedFields(child);
  }
  return result;
}
