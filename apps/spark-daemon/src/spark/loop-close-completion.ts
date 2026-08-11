import type { SparkSessionCloseCandidate } from "@zendev-lab/spark-protocol/session-assignment";
import type { CompleteSparkInvocationInput } from "../store/invocations.ts";
import type { SparkLoopRecord } from "../store/loops.ts";

export function loopTickCloseCandidate(
  invocationId: string,
  completion: CompleteSparkInvocationInput,
): SparkSessionCloseCandidate {
  const assistantSummary = assistantText(completion.result);
  const status =
    completion.status === "succeeded"
      ? "completed"
      : completion.status === "cancelled"
        ? "cancelled"
        : "failed";
  return {
    source: assistantSummary ? "terminal_result" : "domain_completion",
    status,
    code: normalizeCode(completion.errorCode ?? `loop_tick_${status}`),
    summary: assistantSummary ?? `Loop tick ${status}.`,
    evidenceRefs: [],
    artifactRefs: [],
    sourceInvocationIds: [invocationId],
  };
}

export function loopDriverCloseCandidate(
  loop: SparkLoopRecord,
  input: {
    status?: SparkSessionCloseCandidate["status"];
    code?: string;
    summary?: string;
  } = {},
): SparkSessionCloseCandidate | undefined {
  const latestReceipt = loop.checkpoint?.receipts.at(-1);
  const sourceInvocationId =
    loop.checkpoint?.tick?.invocationId ??
    (loop.cycleStep === "invoke" ? loop.lastInvocationId : undefined);
  if (!sourceInvocationId) return undefined;
  const status = input.status ?? loopCloseStatus(loop.status);
  const summary =
    boundText(input.summary) ??
    boundText(latestReceipt?.reason) ??
    boundText(loop.reason) ??
    `Loop ${loop.loopId} ${status}.`;
  const nextAction = boundText(latestReceipt?.remainingWork, 2_048);
  return {
    source: "domain_completion",
    status,
    code: normalizeCode(input.code ?? `loop_${loop.status}`),
    summary,
    ...(nextAction ? { nextAction } : {}),
    evidenceRefs: [
      ...new Set(loop.checkpoint?.receipts.flatMap((receipt) => receipt.evidenceRefs) ?? []),
    ].slice(0, 64),
    artifactRefs: [],
    sourceInvocationIds: [sourceInvocationId],
  };
}

function loopCloseStatus(status: SparkLoopRecord["status"]): SparkSessionCloseCandidate["status"] {
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  return "cancelled";
}

function assistantText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return boundText((value as Record<string, unknown>).assistantText);
}

function boundText(value: unknown, maxLength = 4_096): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength).trim() : undefined;
}

function normalizeCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  return (/^[a-z]/u.test(normalized) ? normalized : `loop_${normalized || "settled"}`).slice(
    0,
    128,
  );
}
