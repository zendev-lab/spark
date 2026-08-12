import type { DatabaseSync } from "node:sqlite";
import { parseSparkInteractionRequest } from "@zendev-lab/spark-protocol/presentation";
import type { SparkDaemonHumanInteractionBroker } from "../core/human-interactions.ts";
import type { ExecutionOwnerHandlers } from "./owner-capabilities.ts";
import { createTaskClaimExecutionOwner } from "./task-claim-owner.ts";

export interface DaemonExecutionOwnerOptions {
  db: DatabaseSync;
  humanInteractions: SparkDaemonHumanInteractionBroker;
  scheduleLoop(input: {
    loopId: string;
    generation: number;
    delayMs: number;
    reason: string;
  }): unknown;
  stopLoop(input: { loopId: string; reason: string }): unknown;
}

/** Bind the closed attempt registry to the existing daemon state owners. */
export function createDaemonExecutionOwnerHandlers(
  options: DaemonExecutionOwnerOptions,
): ExecutionOwnerHandlers {
  return {
    taskClaim: createTaskClaimExecutionOwner(options.db),
    humanInteraction: async (request, context) => {
      const interaction = parseSparkInteractionRequest(request.interaction);
      const binding = record(request.binding, "human interaction binding");
      return await options.humanInteractions.interact(interaction, {
        sessionId: string(binding.sessionId, "sessionId"),
        invocationId: context.identity.invocationId,
        ...(optionalString(binding.sessionSource)
          ? { sessionSource: sessionSource(binding.sessionSource) }
          : {}),
        ...(optionalString(binding.workspaceBindingId)
          ? { workspaceBindingId: optionalString(binding.workspaceBindingId) }
          : {}),
        ...(optionalString(binding.workspaceId)
          ? { workspaceId: optionalString(binding.workspaceId) }
          : {}),
        ...(optionalString(binding.projectId)
          ? { projectId: optionalString(binding.projectId) }
          : {}),
        ...(optionalString(binding.toolCallId)
          ? { toolCallId: optionalString(binding.toolCallId) }
          : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    },
    loopSchedule: async (request) => {
      const schedule = record(request.schedule, "loop schedule");
      return options.scheduleLoop({
        loopId: string(request.loopId, "loopId"),
        generation: positiveInteger(request.generation, "generation"),
        delayMs: nonNegativeInteger(schedule.delayMs, "delayMs"),
        reason: string(schedule.reason, "reason"),
      });
    },
    loopStop: async (request) =>
      options.stopLoop({
        loopId: string(request.loopId, "loopId"),
        reason: string(request.reason, "reason"),
      }),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function sessionSource(value: unknown): "tui" | "web" | "channel" | "daemon" | "session" {
  const source = string(value, "sessionSource");
  if (!["tui", "web", "channel", "daemon", "session"].includes(source)) {
    throw new Error("sessionSource is invalid");
  }
  return source as "tui" | "web" | "channel" | "daemon" | "session";
}
