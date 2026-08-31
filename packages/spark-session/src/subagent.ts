/**
 * Role-bound providers for the official DSH subagent HOST.
 *
 * Spark never executes a child locally here. A daemon host creates the durable
 * child Session, admits its Invocation, and owns cancellation and settlement.
 * The Web-only fallback advertises that it cannot accept AgentOptions and
 * fails starts instead of becoming a second execution owner.
 */
import { Buffer } from "node:buffer";

import type { Context } from "@deepseek-ai/cordis";
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  assertSubagentMaxDepth,
  delegationDepthOf,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from "@deepseek-ai/dsh-subagent";

export const name = "spark-session-subagent";
export const inject = ["subagents"] as const;

export type SparkSubagentMode = "spawn" | "fork";
export type SparkSubagentRoleRef = `role:${string}`;

export type SparkSubagentErrorCode =
  | "invalid_role_ref"
  | "invalid_parent_session"
  | "missing_subagent_host"
  | "subagent_execution_unavailable"
  | "subagent_depth_exceeded";

export class SparkSubagentError extends Error {
  readonly code: SparkSubagentErrorCode;

  constructor(code: SparkSubagentErrorCode, message: string) {
    super(message);
    this.name = "SparkSubagentError";
    this.code = code;
  }
}

export interface SparkSubagentHostStartRequest {
  parentSessionId: string;
  roleRef: SparkSubagentRoleRef;
  mode: SparkSubagentMode;
  name?: string;
  prompt: ContentBlock[];
  /** Official normalized DSH AgentOptions; the daemon validates and freezes them. */
  agentOptions?: AgentOptions;
  delegationDepth: number;
  descriptor: ResolvedSubagentStartRequest["descriptor"];
  signal: AbortSignal;
}

export interface SparkSubagentHostTerminal {
  output: ContentBlock[];
  structured?: unknown;
  diagnostic?: string;
  stopReason: SubagentStopReason;
}

export interface SparkSubagentHostRun {
  sessionId: string;
  result: Promise<SparkSubagentHostTerminal>;
  cancel(reason: string): void | Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface SparkSubagentHost {
  /** True only when a daemon owner can validate and freeze official AgentOptions. */
  readonly agentOptions: boolean;
  start(input: SparkSubagentHostStartRequest): Promise<SparkSubagentHostRun>;
}

export interface SparkSubagentRegistry {
  registerProvider(provider: SubagentProvider): () => void;
}

export interface SparkSubagentPluginConfig {
  host?: SparkSubagentHost;
}

const HUMAN_ROLE_IDS = new Set(["you", "user", "human", "operator", "你"]);
const BUILTIN_ROLE_IDS = new Set(["administrator", "explorer", "executor", "reviewer"]);
const DEFAULT_ROLE_REF = "role:builtin-executor" as const satisfies SparkSubagentRoleRef;

export function createSparkSessionSubagentProviders(host: SparkSubagentHost): SubagentProvider[] {
  return [createProvider(host, "spawn", false), createProvider(host, "fork", true)];
}

/** Web/profile fallback: registration remains truthful but never executes locally. */
export function createUnavailableSparkSubagentHost(): SparkSubagentHost {
  return {
    agentOptions: false,
    async start(): Promise<never> {
      throw new SparkSubagentError(
        "subagent_execution_unavailable",
        "Spark subagent execution requires a daemon-backed host",
      );
    },
  };
}

export function apply(ctx: Context, config: SparkSubagentPluginConfig = {}): void {
  const host = config.host ?? createUnavailableSparkSubagentHost();
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

export function roleRefFromDshRequest(
  request: Pick<ResolvedSubagentStartRequest, "persona"> | { persona?: string },
): SparkSubagentRoleRef {
  const explicit = optionalText(request.persona);
  if (!explicit) return DEFAULT_ROLE_REF;
  if (explicit.startsWith("role:")) return normalizeRoleRef(explicit);
  const id = explicit.trim();
  if (BUILTIN_ROLE_IDS.has(id.toLowerCase())) {
    return normalizeRoleRef(`role:builtin-${id.toLowerCase()}`);
  }
  return normalizeRoleRef(`role:${id}`);
}

function createProvider(
  host: SparkSubagentHost,
  mode: SparkSubagentMode,
  inheritsParentContext: boolean,
): SubagentProvider {
  return {
    name: mode,
    inheritsParentContext,
    capabilities: {
      agentOptions: host.agentOptions,
      outputSchema: false,
      depthLimit: true,
      toolFilter: false,
      persona: true,
    },
    async start(request): Promise<SubagentRun> {
      const parentSessionId = trimRequired(
        String(request.parent.session.id),
        "invalid_parent_session",
      );
      assertSubagentMaxDepth(request.maxDepth);
      const delegationDepth = delegationDepthOf(request.parent) + 1;
      if (request.maxDepth !== undefined && delegationDepth > request.maxDepth) {
        throw new SparkSubagentError(
          "subagent_depth_exceeded",
          `subagent depth ${delegationDepth} exceeds maximum ${request.maxDepth}`,
        );
      }
      const name = optionalText(request.label);
      const run = await host.start({
        parentSessionId,
        roleRef: roleRefFromDshRequest(request),
        mode,
        ...(name ? { name } : {}),
        prompt: request.prompt,
        ...(request.agentOptions ? { agentOptions: request.agentOptions } : {}),
        delegationDepth,
        descriptor: request.descriptor,
        signal: request.signal,
      });
      return publishedRun(run);
    },
  };
}

function publishedRun(run: SparkSubagentHostRun): SubagentRun {
  let disposed: Promise<void> | undefined;
  return {
    id: SessionId(run.sessionId),
    localAgent: undefined,
    result: run.result.then((terminal): SubagentResult =>
      terminal.diagnostic
        ? { ...terminal, diagnostic: boundedDiagnostic(terminal.diagnostic) }
        : terminal,
    ),
    dispose() {
      disposed ??= Promise.resolve(run.cancel("DSH subagent run disposed")).then(
        async () => await run.waitForIdle(),
      );
      return disposed;
    },
  };
}

function normalizeRoleRef(value: string): SparkSubagentRoleRef {
  const roleRef = typeof value === "string" ? value.trim() : "";
  if (!/^role:.+/u.test(roleRef)) {
    throw new SparkSubagentError("invalid_role_ref", "subagent start requires a role:* ref");
  }
  const id = roleRef.slice("role:".length).trim();
  if (!id || HUMAN_ROLE_IDS.has(id.toLowerCase())) {
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

function boundedDiagnostic(value: string): string {
  const bytes = Buffer.from(value);
  return bytes.length <= 4096 ? value : bytes.subarray(0, 4096).toString("utf8");
}
