import { Type } from "typebox";
import type { SparkDaemonReproControl } from "./spark-daemon-repro-client.ts";
import type { SparkToolRegistrar } from "./spark-tool-registration.ts";

export function registerSparkReproTool(
  registerSparkTool: SparkToolRegistrar,
  deps: { reproControl: SparkDaemonReproControl },
): void {
  registerSparkTool({
    name: "repro",
    label: "Spark Repro",
    description:
      "Start, inspect, or stop the daemon-owned three-Session Repro v10 checkpoint workflow.",
    policy: {
      effect: "local_write",
      executionMode: "sequential",
      domains: ["repro"],
      approval: "none",
    },
    resolvePolicy(args) {
      const status = args.action === undefined || args.action === "status";
      return {
        effect: status ? "read" : "local_write",
        executionMode: status ? "parallel" : "sequential",
        domains: ["repro"],
        approval: "none",
      };
    },
    promptGuidelines: [
      "Use repro action=start once with an explicit objective. The daemon creates and advances Implementation, Exactness, and Formalize child Sessions.",
      "Use repro action=status for checkpoint state. Transcript text and compacted context are not continuation authority.",
      "Use repro action=stop only when the user asks to terminate the active run.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")], {
          default: "status",
        }),
      ),
      objective: Type.Optional(Type.String({ minLength: 1 })),
      reproId: Type.Optional(Type.String({ minLength: 1 })),
      reason: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ownerSessionId = ctx.sessionId?.trim();
      if (!ownerSessionId) throw new Error("repro requires a persistent owner Session");
      const action = normalizeAction(params.action);
      if (action === "status") {
        const result = await deps.reproControl.status({ ownerSessionId }, signal);
        return result.repro
          ? {
              content: [{ type: "text" as const, text: renderStatus(result.repro) }],
              details: result.repro,
            }
          : {
              content: [
                {
                  type: "text" as const,
                  text: 'No Repro is owned by this Session. Use repro({ action: "start", objective: "..." }).',
                },
              ],
              details: { active: false },
            };
      }
      if (action === "stop") {
        const result = await deps.reproControl.stop(
          {
            ownerSessionId,
            ...(typeof params.reason === "string" && params.reason.trim()
              ? { reason: params.reason.trim() }
              : {}),
          },
          signal,
        );
        return {
          content: [{ type: "text" as const, text: renderStatus(result.repro) }],
          details: result.repro,
        };
      }
      const objective = typeof params.objective === "string" ? params.objective.trim() : "";
      if (!objective) throw new Error("repro start requires objective");
      const result = await deps.reproControl.start(
        {
          ownerSessionId,
          objective,
          ...(typeof params.reproId === "string" && params.reproId.trim()
            ? { reproId: params.reproId.trim() }
            : {}),
        },
        signal,
      );
      return {
        content: [{ type: "text" as const, text: renderStatus(result.repro) }],
        details: result.repro,
      };
    },
  });
}

function normalizeAction(value: unknown): "start" | "status" | "stop" {
  if (value === undefined || value === "status") return "status";
  if (value === "start" || value === "stop") return value;
  throw new Error("repro action must be start, status, or stop");
}

function renderStatus(repro: {
  reproId: string;
  status: string;
  objective: string;
  checkpoint?: { kind: string; status: string; attempt: number };
  progress: { accepted: number; total: number };
}): string {
  const checkpoint = repro.checkpoint
    ? ` · ${repro.checkpoint.kind}:${repro.checkpoint.status} attempt=${repro.checkpoint.attempt}`
    : "";
  return `Repro ${repro.reproId} [${repro.status}] ${repro.progress.accepted}/${repro.progress.total}${checkpoint}\n${repro.objective}`;
}
