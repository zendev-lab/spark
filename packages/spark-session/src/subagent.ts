/**
 * Role-bound spawn/fork providers for the official DSH subagent HOST.
 *
 * Spark owns the child Session and Role bind. `@deepseek-ai/dsh-subagent`
 * owns `ctx.subagents`. This module registers named providers; it does not
 * provide a second registry or in-process continuation manager.
 */
import { isAbsolute } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "spark-session-subagent";
export const inject = ["subagents"] as const;

export type SparkSubagentMode = "spawn" | "fork";
export type SparkSubagentRoleRef = `role:${string}`;

export type SparkSubagentErrorCode =
  | "invalid_role_ref"
  | "invalid_parent_session"
  | "invalid_mode"
  | "missing_subagent_host";

export class SparkSubagentError extends Error {
  readonly code: SparkSubagentErrorCode;

  constructor(code: SparkSubagentErrorCode, message: string) {
    super(message);
    this.name = "SparkSubagentError";
    this.code = code;
  }
}

export interface SparkSubagentStartRequest {
  parentSessionId: string;
  roleRef: SparkSubagentRoleRef;
  mode: SparkSubagentMode;
  name?: string;
  cwd?: string;
  cwdArtifactRef?: string;
}

export interface SparkSubagentStartResult {
  sessionId: string;
  roleRef: SparkSubagentRoleRef;
  mode: SparkSubagentMode;
}

export interface SparkSubagentHost {
  createChild(input: SparkSubagentStartRequest): Promise<SparkSubagentStartResult>;
}

export interface SparkSubagentCapabilities {
  readonly outputSchema: boolean;
  readonly depthLimit: boolean;
  readonly toolFilter: boolean;
  readonly persona: boolean;
}

export interface SparkDshSubagentStartRequest {
  label?: string;
  description?: string;
  persona?: string;
  roleRef?: string;
  cwd?: string;
  parent?: unknown;
  parentSessionId?: string;
  signal?: AbortSignal;
}

export interface SparkDshContinuableCreateRequest {
  sessionId?: unknown;
  parent?: unknown;
  signal?: AbortSignal;
}

export interface SparkDshSubagentRun {
  id: SessionId;
  localAgent: undefined;
  result: Promise<{
    output: Array<{ type: "text"; text: string }>;
    stopReason: "completed";
  }>;
  dispose(): Promise<void>;
}

export interface SparkSessionSubagentProvider {
  readonly name: SparkSubagentMode;
  readonly inheritsParentContext: boolean;
  readonly capabilities: SparkSubagentCapabilities;
  start(request: SparkDshSubagentStartRequest): Promise<SparkDshSubagentRun>;
  prepareContinuable(request: SparkDshContinuableCreateRequest): Promise<Record<string, never>>;
}

export interface SparkSubagentRegistry {
  registerProvider(provider: SparkSessionSubagentProvider): () => void;
}

export interface SparkSubagentPluginConfig {
  host?: SparkSubagentHost;
}

const HUMAN_ROLE_IDS = new Set(["you", "user", "human", "operator", "你"]);
const BUILTIN_ROLE_IDS = new Set(["administrator", "explorer", "executor", "reviewer"]);
const DEFAULT_ROLE_REF = "role:builtin-executor" as const satisfies SparkSubagentRoleRef;
const PROVIDER_CAPABILITIES: SparkSubagentCapabilities = {
  outputSchema: false,
  depthLimit: true,
  toolFilter: false,
  persona: true,
};

export function createSparkSessionSubagentProviders(
  host: SparkSubagentHost,
): SparkSessionSubagentProvider[] {
  return [createProvider(host, "spawn", false), createProvider(host, "fork", true)];
}

/**
 * Live SessionStore fallback for DSH web. Role policy still runs here; the
 * child is a live `ctx.sessions` entry with `origin: "subagent"`. Daemon must
 * pass `config.host` so Spark registry spawn stays the owner.
 */
export function createSparkSessionStoreSubagentHost(ctx: Context): SparkSubagentHost {
  return {
    async createChild(request) {
      const sessions = ctx.sessions;
      if (sessions === undefined) {
        throw new SparkSubagentError(
          "invalid_parent_session",
          "spark-session-subagent requires ctx.sessions",
        );
      }
      const parent = sessions.get(SessionId(request.parentSessionId));
      if (parent === undefined) {
        throw new SparkSubagentError("invalid_parent_session", "parent session is not live");
      }
      const cwd = absoluteCwd(request.cwd) ?? parent.header.cwd;
      const child =
        request.mode === "fork"
          ? sessions.fork(parent)
          : sessions.create(undefined, {
              meta: {
                origin: "subagent",
                parentSession: parent.id,
                ...(cwd ? { cwd } : {}),
                delegationDepth: (parent.header.delegationDepth ?? 0) + 1,
              },
            });
      return {
        sessionId: String(child.id),
        roleRef: request.roleRef,
        mode: request.mode,
      };
    },
  };
}

export function apply(ctx: Context, config: SparkSubagentPluginConfig = {}): void {
  const host = config.host ?? createSparkSessionStoreSubagentHost(ctx);
  const subagents = ctx.get("subagents") as SparkSubagentRegistry | undefined;
  if (subagents === undefined) {
    throw new SparkSubagentError(
      "missing_subagent_host",
      "spark-session-subagent requires official ctx.subagents",
    );
  }
  for (const provider of createSparkSessionSubagentProviders(host)) {
    subagents.registerProvider(provider);
  }
}

export default { name, inject, apply };

export function roleRefFromDshRequest(request: SparkDshSubagentStartRequest): SparkSubagentRoleRef {
  const explicit = optionalText(request.roleRef) ?? optionalText(request.persona);
  if (!explicit) return DEFAULT_ROLE_REF;
  if (explicit.startsWith("role:")) return normalizeRoleRef(explicit);
  const id = explicit.trim();
  if (BUILTIN_ROLE_IDS.has(id.toLowerCase())) {
    return normalizeRoleRef(`role:builtin-${id.toLowerCase()}`);
  }
  return normalizeRoleRef(`role:${id}`);
}

export function normalizeSparkSubagentStartInput(input: {
  parentSessionId: string;
  roleRef: string;
  mode: SparkSubagentMode;
  name?: string;
  cwd?: string;
  cwdArtifactRef?: string;
}): SparkSubagentStartRequest {
  const parentSessionId = trimRequired(input.parentSessionId, "invalid_parent_session");
  if (input.mode !== "spawn" && input.mode !== "fork") {
    throw new SparkSubagentError("invalid_mode", "subagent start requires spawn or fork");
  }
  const name = optionalText(input.name);
  const cwd = optionalText(input.cwd);
  const cwdArtifactRef = optionalText(input.cwdArtifactRef);
  return {
    parentSessionId,
    roleRef: normalizeRoleRef(input.roleRef),
    mode: input.mode,
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    ...(cwdArtifactRef ? { cwdArtifactRef } : {}),
  };
}

function createProvider(
  host: SparkSubagentHost,
  mode: SparkSubagentMode,
  inheritsParentContext: boolean,
): SparkSessionSubagentProvider {
  return {
    name: mode,
    inheritsParentContext,
    capabilities: PROVIDER_CAPABILITIES,
    async start(request) {
      const started = await host.createChild(
        normalizeSparkSubagentStartInput({
          parentSessionId: parentSessionIdFrom(request),
          roleRef: roleRefFromDshRequest(request),
          mode,
          ...((optionalText(request.label) ?? optionalText(request.description))
            ? { name: optionalText(request.label) ?? optionalText(request.description) }
            : {}),
          ...(optionalText(request.cwd) ? { cwd: optionalText(request.cwd) } : {}),
        }),
      );
      return publishedRun(started);
    },
    async prepareContinuable() {
      // Continuable identity, Agent creation, and prompt delivery stay on the
      // official HOST continuation manager. Spark participates only by being
      // registered as the spawn/fork transport; Role-bound durable spawn is
      // the one-shot `start()` path through `host.createChild`.
      return {};
    },
  };
}

function publishedRun(started: SparkSubagentStartResult): SparkDshSubagentRun {
  return {
    id: SessionId(started.sessionId),
    localAgent: undefined,
    result: Promise.resolve({
      output: [
        {
          type: "text",
          text: `Created Role-bound subagent ${started.sessionId} (${started.roleRef}, ${started.mode}). The child is a Spark Session; send(kind=request) is the execution trigger.`,
        },
      ],
      stopReason: "completed",
    }),
    async dispose() {},
  };
}

function parentSessionIdFrom(request: SparkDshSubagentStartRequest): string {
  if (typeof request.parentSessionId === "string") return request.parentSessionId;
  const parent = request.parent;
  if (parent && typeof parent === "object") {
    const record = parent as Record<string, unknown>;
    const session = record.session;
    if (session && typeof session === "object") {
      const sessionId = (session as { id?: unknown }).id;
      if (typeof sessionId === "string") return sessionId;
      if (sessionId != null) return String(sessionId);
    }
    if (typeof record.sessionId === "string") return record.sessionId;
    if (typeof record.id === "string") return record.id;
  }
  return "";
}

function normalizeRoleRef(value: string): SparkSubagentRoleRef {
  const roleRef = typeof value === "string" ? value.trim() : "";
  if (!/^role:.+/u.test(roleRef)) {
    throw new SparkSubagentError("invalid_role_ref", "subagent start requires a role:* ref");
  }
  const id = roleRef.slice("role:".length).trim();
  if (!id || HUMAN_ROLE_IDS.has(id.toLowerCase()) || HUMAN_ROLE_IDS.has(id)) {
    throw new SparkSubagentError("invalid_role_ref", "human operator is not a Role");
  }
  return roleRef as SparkSubagentRoleRef;
}

function trimRequired(value: string, code: SparkSubagentErrorCode): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new SparkSubagentError(code, "subagent start is missing a required field");
  }
  return trimmed;
}

function optionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function absoluteCwd(value: string | undefined): string | undefined {
  return value !== undefined && isAbsolute(value) ? value : undefined;
}
