import { createHash, randomUUID } from "node:crypto";
import type {
  ExtensionRoleRunner,
  ExtensionRoleRunRequest,
  ExtensionRoleRunResult,
  RoleRunCompletionOutcome,
} from "@zendev-lab/spark-core";
import type { SparkSessionCloseCandidate } from "@zendev-lab/spark-protocol/session-assignment";
import { parseSparkRoleSpec } from "@zendev-lab/spark-protocol/role-session";
import type { SessionSupervisor } from "./session-supervisor.ts";

export interface SupervisedRoleRunnerOptions {
  supervisor: SessionSupervisor;
  workspaceId: string;
  parentSessionId: string;
  parentInvocationId: string;
  cwd?: string;
}

/**
 * Adapt the compatibility RoleRun port to the canonical
 * RoleSpec -> Session -> Invocation chain. RoleRun records are assembled only
 * after the owned child Session settles; they never own execution lifecycle.
 */
export function createSupervisedRoleRunner(
  options: SupervisedRoleRunnerOptions,
): ExtensionRoleRunner {
  return async (request) => await runSupervisedRole(options, request);
}

async function runSupervisedRole(
  options: SupervisedRoleRunnerOptions,
  request: ExtensionRoleRunRequest,
): Promise<ExtensionRoleRunResult> {
  const startedAt = request.record.startedAt ?? new Date().toISOString();
  const role = parseSparkRoleSpec({
    ref: request.role.ref,
    id: request.role.id,
    source: request.role.source ?? sourceFromRoleRef(request.role.ref),
    revision: request.role.revision,
    description: `Supervised ${request.role.id} Role`,
    systemPrompt: request.role.systemPrompt,
    capabilities: request.role.capabilities ?? [],
    ...(request.role.allowedTools ? { allowedTools: request.role.allowedTools } : {}),
    ...(request.role.allowedToolEffects
      ? { allowedToolEffects: request.role.allowedToolEffects }
      : {}),
    modelType: required(request.role.modelType, "supervised Role modelType"),
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  const model = required(request.model, `model for ${role.modelType}`);
  const invocationId = `inv_${randomUUID().replaceAll("-", "")}`;
  const purpose =
    request.usageExecutionKind === "workflow_agent"
      ? "workflow_agent"
      : role.id.startsWith("skill-agent-")
        ? "skill_agent"
        : "role_call";
  const session = await options.supervisor.instantiateInvocationSession({
    workspaceId: options.workspaceId,
    role,
    invocationId,
    parentSessionId: options.parentSessionId,
    cwd: request.cwd || options.cwd,
    purpose,
    visibility: "internal",
    retention: "discard_on_close",
  });

  let invocation: Awaited<ReturnType<SessionSupervisor["invoke"]>> | undefined;
  let result: ExtensionRoleRunResult | undefined;
  try {
    invocation = await options.supervisor.invoke({
      invocationId,
      sessionId: session.sessionId,
      prompt: request.instruction.instruction,
      parentInvocationId: options.parentInvocationId,
      structured: true,
      model,
      roleRunRef: request.record.ref,
      requireStructuredOutcome: request.requireStructuredOutcome,
      sourceKind: purpose,
      sourceRef: request.record.ref,
      signal: request.signal,
      receiptProfile: {
        effectiveRoleRef: role.ref,
        effectiveRoleRevision: role.revision,
        model: modelRef(model),
        toolPolicyDigest: roleToolPolicyDigest(role),
        inputRefs: [],
        authorizationSource: {
          kind: "parent_invocation",
          ref: options.parentInvocationId,
        },
      },
    });
    result = compatibilityRoleRunResult(request, invocation, startedAt, model);
    return result;
  } finally {
    const closed = await options.supervisor.close({
      sessionId: session.sessionId,
      reason: `supervised ${purpose} settled`,
      ...(invocation && result
        ? { completion: roleCloseCompletion(invocation.invocationId, invocation.result, result) }
        : {}),
      settleTimeoutMs: 5_000,
    });
    if (closed.lifecycle !== "closed") {
      throw new Error(`supervised Role Session ${session.sessionId} did not close`);
    }
  }
}

function roleToolPolicyDigest(role: ReturnType<typeof parseSparkRoleSpec>): string {
  const canonical = JSON.stringify({
    capabilities: role.capabilities,
    allowedTools: role.allowedTools ?? [],
    allowedToolEffects: role.allowedToolEffects ?? [],
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function modelRef(value: string): { providerName: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`supervised Role model must use provider/model syntax: ${value}`);
  }
  return { providerName: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function roleCloseCompletion(
  invocationId: string,
  invocationResult: unknown,
  result: ExtensionRoleRunResult,
): SparkSessionCloseCandidate {
  const reported = roleOutcome(recordValue(invocationResult)?.roleOutcome);
  const outcome = result.outcome ?? {
    kind: result.record.status === "cancelled" ? "cancelled" : "failed",
    code: "role_run_failed",
    reason: result.stderr || "Supervised Role failed without a terminal outcome",
  };
  const summary =
    boundText(result.stdout) ?? boundText(outcome.reason) ?? "Supervised Role settled.";
  const nextAction = boundText(outcome.nextAction, 2_048);
  return {
    source: reported ? "structured_outcome" : "terminal_result",
    status: outcome.kind,
    code: normalizeCloseCode(outcome.code),
    summary,
    ...(nextAction ? { nextAction } : {}),
    evidenceRefs: [],
    artifactRefs: [],
    sourceInvocationIds: [invocationId],
  };
}

function compatibilityRoleRunResult(
  request: ExtensionRoleRunRequest,
  invocation: Awaited<ReturnType<SessionSupervisor["invoke"]>>,
  startedAt: string,
  model: string,
): ExtensionRoleRunResult {
  const payload = recordValue(invocation.result);
  const assistantText = stringValue(payload?.assistantText);
  const reportedOutcome = roleOutcome(payload?.roleOutcome);
  const outcome = terminalOutcome(
    request,
    invocation.status,
    reportedOutcome,
    invocation.errorMessage,
  );
  const status =
    outcome.kind === "completed"
      ? "succeeded"
      : outcome.kind === "cancelled"
        ? "cancelled"
        : "failed";
  const jsonEvents = assistantText
    ? [
        {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
        },
      ]
    : [];
  return {
    record: {
      ...request.record,
      status,
      startedAt,
      finishedAt: invocation.finishedAt ?? new Date().toISOString(),
      model,
      outcome,
    },
    outcome,
    stdout: assistantText ?? "",
    stderr: status === "succeeded" ? "" : (invocation.errorMessage ?? outcome.reason),
    jsonEvents,
  };
}

function terminalOutcome(
  request: ExtensionRoleRunRequest,
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled",
  reported: RoleRunCompletionOutcome | undefined,
  errorMessage: string | undefined,
): RoleRunCompletionOutcome {
  if (status === "cancelled") {
    return { kind: "cancelled", code: "role_run_cancelled", reason: errorMessage ?? "cancelled" };
  }
  if (status !== "succeeded") {
    return { kind: "failed", code: "role_run_failed", reason: errorMessage ?? status };
  }
  if (reported) return reported;
  if (request.requireStructuredOutcome) {
    return {
      kind: "failed",
      code: "missing_structured_outcome",
      reason: "Supervised Role ended without calling role_report_outcome",
    };
  }
  return {
    kind: "completed",
    code: "role_run_completed",
    reason: "Supervised Role Session completed",
  };
}

function roleOutcome(value: unknown): RoleRunCompletionOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "completed" &&
    record.kind !== "blocked" &&
    record.kind !== "failed" &&
    record.kind !== "cancelled"
  ) {
    return undefined;
  }
  const code = stringValue(record.code);
  const reason = stringValue(record.reason);
  if (!code || !reason) return undefined;
  const nextAction = stringValue(record.nextAction);
  return { kind: record.kind, code, reason, ...(nextAction ? { nextAction } : {}) };
}

function sourceFromRoleRef(ref: string): "builtin" | "extension" | "project" | "user" {
  if (ref.startsWith("role:builtin-")) return "builtin";
  if (ref.startsWith("role:project-")) return "project";
  if (ref.startsWith("role:user-")) return "user";
  return "extension";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function boundText(value: string | undefined, maxLength = 4_096): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength).trim() : undefined;
}

function normalizeCloseCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  return (/^[a-z]/u.test(normalized) ? normalized : `role_${normalized || "failed"}`).slice(0, 128);
}
