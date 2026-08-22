import type { SparkDriverAuthority, SparkHostContext } from "@zendev-lab/spark-core";
import {
  loadSparkSessionWorkspaceState,
  setSparkSessionDriverAuthority,
  type SparkSessionContext,
} from "@zendev-lab/spark-loop";
import {
  SPARK_PROTOCOL_VERSION,
  parseSparkInteractionRequest,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
} from "@zendev-lab/spark-protocol";

export const SPARK_DRIVER_AUTHORITY_QUESTION_ID = "driver_authority";
export const SPARK_DRIVER_AUTHORITY_GRANT = "grant";
export const SPARK_DRIVER_AUTHORITY_DENY = "deny";

function sessionContextFromHost(input: {
  cwd: string;
  sessionId?: string;
  sparkStateRoot?: string;
}): SparkSessionContext {
  return {
    cwd: input.cwd,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.sparkStateRoot ? { sparkStateRoot: input.sparkStateRoot } : {}),
  };
}

export function createDriverAuthorityAskRequest(): SparkInteractionRequest {
  return parseSparkInteractionRequest({
    version: SPARK_PROTOCOL_VERSION,
    kind: "askFlow",
    requestId: `driver-authority:${Date.now().toString(36)}`,
    title: "Allow driver authority for this session?",
    prompt:
      "Starting Goal, Loop, or Repro on this session lets the driver run bounded, low-risk, reversible operations (for example creating or syncing a Draft PR) without asking again. Required operations still need approval. CLI and API starts do not prompt.",
    mode: "approval",
    flow: "spark.driver-authority",
    questions: [
      {
        id: SPARK_DRIVER_AUTHORITY_QUESTION_ID,
        prompt: "Grant this session driver authority for manual_only operations?",
        type: "single",
        required: true,
        options: [
          {
            value: SPARK_DRIVER_AUTHORITY_GRANT,
            label: "Grant for this session",
            description:
              "This session may run bounded Draft submit/sync and other manual_only tools without another approval while a Goal, Loop, or Repro driver is active.",
          },
          {
            value: SPARK_DRIVER_AUTHORITY_DENY,
            label: "Keep per-tool approval",
            description:
              "manual_only tools still require human approval on this session, including while a driver is active.",
          },
        ],
      },
    ],
    metadata: { source: "SparkHostRuntime", flow: "spark.driver-authority" },
  });
}

export function driverAuthorityFromAskResponse(
  response: SparkInteractionResponse,
): SparkDriverAuthority | undefined {
  if (response.kind !== "askFlow") return undefined;
  if (response.status === "cancelled") return "denied";
  if (response.status !== "answered") return undefined;
  const answer = response.answers?.[SPARK_DRIVER_AUTHORITY_QUESTION_ID];
  const values = Array.isArray((answer as { values?: unknown } | undefined)?.values)
    ? (answer as { values: unknown[] }).values
    : [];
  if (values.includes(SPARK_DRIVER_AUTHORITY_GRANT)) return "granted";
  if (values.includes(SPARK_DRIVER_AUTHORITY_DENY)) return "denied";
  return undefined;
}

export async function loadPersistedDriverAuthority(
  cwd: string,
  ctx: SparkSessionContext,
): Promise<SparkDriverAuthority | undefined> {
  return (await loadSparkSessionWorkspaceState(cwd, ctx))?.driverAuthority;
}

export async function persistDriverAuthority(
  cwd: string,
  ctx: SparkSessionContext,
  driverAuthority: SparkDriverAuthority,
): Promise<SparkDriverAuthority> {
  await setSparkSessionDriverAuthority(cwd, ctx, driverAuthority);
  return driverAuthority;
}

export function hostSessionContext(
  ctx: SparkHostContext,
  fallbackCwd: string,
): SparkSessionContext {
  return sessionContextFromHost({
    cwd: ctx.cwd ?? fallbackCwd,
    sessionId: ctx.sessionId,
    sparkStateRoot: ctx.sparkStateRoot,
  });
}
