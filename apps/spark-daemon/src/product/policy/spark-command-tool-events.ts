import type { SparkCommandApi } from "./spark-command-types.ts";

/**
 * Dispatch a trusted runtime-control instruction for /goal, /loop, and /repro.
 *
 * Daemon-managed TUI hosts wire `ctx.sendUserMessage` to `session.submit` so the
 * instruction reaches the daemon turn bridge. Local agent-loop hosts keep the
 * outbox `sendMessage` + `triggerTurn` path.
 */
export async function sendSparkRuntimeInstruction(
  piApi: SparkCommandApi,
  customType: "spark-goal-request" | "spark-loop-request" | "spark-repro-request",
  instruction: string,
  visible: string,
  details: Record<string, unknown> = {},
  options?: { sendUserMessage?: (content: string) => Promise<void> },
): Promise<void> {
  if (options?.sendUserMessage) {
    await options.sendUserMessage(instruction);
    return;
  }
  piApi.sendMessage(
    {
      customType,
      content: instruction,
      display: false,
      authority: "runtime_control",
      trust: "trusted",
      details: { ...details, visible },
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
}

export function isGoalToolDeactivationEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "goal" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  const action = (toolEvent.params as { action?: unknown }).action;
  return action === "pause" || action === "clear" || action === "complete";
}

export function isLoopToolDeactivationEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "loop" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  return (toolEvent.params as { action?: unknown }).action === "clear";
}

export function isLoopToolScheduleEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "loop" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  return (toolEvent.params as { action?: unknown }).action === "schedule";
}
