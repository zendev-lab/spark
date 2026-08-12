import type { ExecutionAttemptIdentity } from "./contract.ts";
import {
  ExecutionCapabilityRegistry,
  objectRequest,
  type ExecutionCapabilityDefinition,
} from "./capability-registry.ts";

export interface ExecutionOwnerContext {
  identity: ExecutionAttemptIdentity;
  signal?: AbortSignal;
}

export interface ExecutionOwnerHandlers {
  taskClaim(request: Record<string, unknown>, context: ExecutionOwnerContext): Promise<unknown>;
  humanInteraction(
    request: Record<string, unknown>,
    context: ExecutionOwnerContext,
  ): Promise<unknown>;
  loopSchedule(request: Record<string, unknown>, context: ExecutionOwnerContext): Promise<unknown>;
  loopStop(request: Record<string, unknown>, context: ExecutionOwnerContext): Promise<unknown>;
}

/**
 * Compose only daemon-owned operations that a future isolated attempt may call.
 * Tools, models, files, search/edit, external commands, stores, and environment
 * access intentionally have no registration path here.
 */
export function createInProcessExecutionCapabilityRegistry(input: {
  currentAttempt(
    invocationId: string,
  ): (ExecutionAttemptIdentity & { correlationId: string }) | undefined;
  owners: ExecutionOwnerHandlers;
}): ExecutionCapabilityRegistry {
  const registry = new ExecutionCapabilityRegistry({
    currentAttempt: (invocationId) => input.currentAttempt(invocationId),
  });
  const definitions: ExecutionCapabilityDefinition[] = [
    {
      operation: "task.claim",
      validate: objectRequest,
      handle: async (request, context) => await input.owners.taskClaim(request, context),
    },
    {
      operation: "human.interaction",
      validate: objectRequest,
      handle: async (request, context) => await input.owners.humanInteraction(request, context),
    },
    {
      operation: "loop.schedule",
      validate: objectRequest,
      handle: async (request, context) => await input.owners.loopSchedule(request, context),
    },
    {
      operation: "loop.stop",
      validate: objectRequest,
      handle: async (request, context) => await input.owners.loopStop(request, context),
    },
  ];
  for (const definition of definitions) registry.register(definition);
  return registry;
}
