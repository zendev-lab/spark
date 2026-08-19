import type { CueClient, CueResolvedTransport, ResourceNeeds } from "../client/cue-client.ts";
import type { SparkCueToolConfig, SparkCueToolContext } from "../tools/host-types.ts";
import { registerCueOperationDefinitions } from "./definitions.ts";

export const CUE_TOOL_NAMES = [
  "cue_exec",
  "cue_run",
  "cue_script",
  "script_run",
  "script_eval",
  "cue_jobs",
  "cue_resources",
  "cue_schedule",
  "cue_scope",
  "cue_history",
] as const;

export type CueToolName = (typeof CUE_TOOL_NAMES)[number];
export type CueScriptLanguage = "cue-shell" | "python";

export interface CueExecArgs {
  command: string;
  background?: boolean;
  timeout?: number;
  cwd?: string;
  pty?: boolean;
  tail_bytes?: number;
  needs?: ResourceNeeds;
}

export interface CueRunArgs {
  path: string;
  timeout?: number;
  tail_bytes?: number;
}

export interface CueScriptArgs {
  script: string;
  pathLabel?: string;
  timeout?: number;
  tail_bytes?: number;
}

export interface ScriptRunArgs extends CueRunArgs {
  language: CueScriptLanguage;
  venv?: string;
}

export interface ScriptEvalArgs extends CueScriptArgs {
  language: CueScriptLanguage;
  venv?: string;
}

export interface CueJobsArgs {
  action: "list" | "status" | "wait" | "stop";
  id?: string;
  status?: string;
  limit?: number;
  timeout?: number;
  tail_bytes?: number;
}

export interface CueResourcesArgs {
  action: "providers" | "resources";
}

export interface CueScheduleArgs {
  action: "add" | "list" | "pause" | "resume" | "remove";
  id?: string;
  schedule?: string;
  command?: string;
  status?: string;
  limit?: number;
}

export interface CueScopeArgs {
  action:
    | "list"
    | "env"
    | "config"
    | "env_set"
    | "env_unset"
    | "path_prepend"
    | "cd"
    | "refresh"
    | "status";
  key?: string;
  value?: string;
  path?: string;
  limit?: number;
  includeEnv?: boolean;
  tail_bytes?: number;
}

export interface CueHistoryArgs {
  id?: string;
  limit?: number;
  tail_bytes?: number;
}

export interface CueToolArgsMap {
  cue_exec: CueExecArgs;
  cue_run: CueRunArgs;
  cue_script: CueScriptArgs;
  script_run: ScriptRunArgs;
  script_eval: ScriptEvalArgs;
  cue_jobs: CueJobsArgs;
  cue_resources: CueResourcesArgs;
  cue_schedule: CueScheduleArgs;
  cue_scope: CueScopeArgs;
  cue_history: CueHistoryArgs;
}

export interface CueTextStream {
  text: string;
  encoding: string;
  truncated: boolean;
  base64?: string;
}

interface CueCanonicalBase {
  tool: CueToolName;
  text: string;
  ok: boolean;
}

export interface CueExecResult extends CueCanonicalBase {
  tool: "cue_exec";
  kind: "foreground" | "background";
  jobId?: string;
  chainId?: string;
  status?: string;
  exitCode?: number | null;
  timedOut: boolean;
  detached: boolean;
  cancelled: boolean;
  stdout: CueTextStream;
  stderr: CueTextStream;
  warnings: string[];
}

export interface CueScriptResult extends CueCanonicalBase {
  tool: "cue_run" | "cue_script";
  scriptId?: string;
  source?: unknown;
  status: string;
  exitCode?: number | null;
  failedItemIndex?: number | null;
  timedOut: boolean;
  cancelled: boolean;
  items: unknown[];
}

export interface CueLanguageResult extends CueCanonicalBase {
  tool: "script_run" | "script_eval";
  language: CueScriptLanguage;
  kind: "cue-shell-script" | "python-job";
  scriptId?: string;
  jobId?: string;
  status: string;
  exitCode?: number | null;
  timedOut: boolean;
  cancelled: boolean;
  items: unknown[];
  stdout: CueTextStream;
  stderr: CueTextStream;
}

export interface CueActionResult extends CueCanonicalBase {
  tool: "cue_jobs" | "cue_resources" | "cue_schedule" | "cue_scope";
  action: string;
  targetId?: string;
  status?: string;
  found?: boolean;
  timedOut: boolean;
  count?: number;
  shown?: number;
  records: unknown[];
  jobId?: string;
  chainId?: string;
  cronId?: string;
  exitCode?: number | null;
  key?: string;
  path?: string;
  cwd?: string;
  scope?: unknown;
  rawChars?: number;
  shownChars?: number;
  truncated?: boolean;
}

export interface CueHistoryResult extends CueCanonicalBase {
  tool: "cue_history";
  targetId?: string;
  rawChars: number;
  shownChars: number;
  lines: number;
  truncated: boolean;
}

export interface CueToolResultMap {
  cue_exec: CueExecResult;
  cue_run: CueScriptResult & { tool: "cue_run" };
  cue_script: CueScriptResult & { tool: "cue_script" };
  script_run: CueLanguageResult & { tool: "script_run" };
  script_eval: CueLanguageResult & { tool: "script_eval" };
  cue_jobs: CueActionResult & { tool: "cue_jobs" };
  cue_resources: CueActionResult & { tool: "cue_resources" };
  cue_schedule: CueActionResult & { tool: "cue_schedule" };
  cue_scope: CueActionResult & { tool: "cue_scope" };
  cue_history: CueHistoryResult;
}

export interface CueExecutionContext {
  sessionId: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  operationId?: string;
  onUpdate?: (text: string) => void;
}

export interface CueToolRuntimeConfig {
  autoStartLocal?: boolean;
  remoteCwd?: string;
  forwardSensitiveEnv?: boolean;
  resolvedTransport?: CueResolvedTransport;
  client?: CueClient;
}

export interface CueToolRuntime {
  execute<Name extends CueToolName>(
    name: Name,
    args: CueToolArgsMap[Name],
    context: CueExecutionContext,
  ): Promise<CueToolResultMap[Name]>;
  releaseSession(sessionId: string): void;
  dispose(): void;
}

function textOf(content: Array<{ type: "text"; text: string }>): string {
  return content.map((part) => part.text).join("\n");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | null | undefined {
  return typeof value === "number" || value === null ? value : undefined;
}

function stream(details: Record<string, unknown>, key: "stdout" | "stderr"): CueTextStream {
  return {
    text: optionalString(details[key]) ?? "",
    encoding: optionalString(details[`${key}Encoding`]) ?? "utf8",
    truncated: details[`${key}Truncated`] === true,
    ...(optionalString(details[`${key}Base64`])
      ? { base64: optionalString(details[`${key}Base64`]) }
      : {}),
  };
}

function recordsOf(details: Record<string, unknown>): unknown[] {
  for (const key of ["jobs", "crons", "scopes", "providers", "resources", "items"]) {
    const value = details[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function validateConditionalArgs<Name extends CueToolName>(
  name: Name,
  args: CueToolArgsMap[Name],
): void {
  if (name === "cue_jobs") {
    const input = args as CueJobsArgs;
    if (input.action !== "list") requireNonEmpty(input.id, `cue_jobs ${input.action} id`);
  } else if (name === "cue_schedule") {
    const input = args as CueScheduleArgs;
    if (input.action === "add") {
      requireNonEmpty(input.schedule, "cue_schedule add schedule");
      requireNonEmpty(input.command, "cue_schedule add command");
    } else if (input.action !== "list") {
      requireNonEmpty(input.id, `cue_schedule ${input.action} id`);
    }
  } else if (name === "cue_scope") {
    const input = args as CueScopeArgs;
    if (input.action === "env_set") {
      requireNonEmpty(input.key, "cue_scope env_set key");
      requireNonEmpty(input.value, "cue_scope env_set value");
    } else if (input.action === "env_unset") {
      requireNonEmpty(input.key, "cue_scope env_unset key");
    } else if (input.action === "path_prepend" || input.action === "cd") {
      requireNonEmpty(input.path, `cue_scope ${input.action} path`);
    }
  }
}

function canonicalize<Name extends CueToolName>(
  name: Name,
  args: CueToolArgsMap[Name],
  text: string,
  details: Record<string, unknown>,
  ok: boolean,
  cancelled = false,
): CueToolResultMap[Name] {
  if (name === "cue_exec") {
    const background = (args as CueExecArgs).background === true;
    return {
      tool: name,
      text,
      ok,
      kind: background ? "background" : "foreground",
      ...(optionalString(details.jobId) ? { jobId: optionalString(details.jobId) } : {}),
      ...(optionalString(details.chainId) ? { chainId: optionalString(details.chainId) } : {}),
      ...(optionalString(details.status) ? { status: optionalString(details.status) } : {}),
      ...(optionalNumber(details.exitCode) !== undefined
        ? { exitCode: optionalNumber(details.exitCode) }
        : {}),
      timedOut: details.timedOut === true,
      detached: background || details.switchedToBackground === true,
      cancelled,
      stdout: stream(details, "stdout"),
      stderr: stream(details, "stderr"),
      warnings: Array.isArray(details.warnings)
        ? details.warnings.filter((item): item is string => typeof item === "string")
        : [],
    } as CueToolResultMap[Name];
  }

  if (name === "cue_run" || name === "cue_script") {
    return {
      tool: name,
      text,
      ok,
      ...(optionalString(details.scriptId) ? { scriptId: optionalString(details.scriptId) } : {}),
      ...(details.source !== undefined ? { source: details.source } : {}),
      status:
        optionalString(details.status) ?? (cancelled ? "cancelled" : ok ? "finished" : "failed"),
      ...(optionalNumber(details.exitCode) !== undefined
        ? { exitCode: optionalNumber(details.exitCode) }
        : {}),
      ...(optionalNumber(details.failedItemIndex) !== undefined
        ? { failedItemIndex: optionalNumber(details.failedItemIndex) }
        : {}),
      timedOut: details.timedOut === true,
      cancelled,
      items: Array.isArray(details.items) ? details.items : [],
    } as CueToolResultMap[Name];
  }

  if (name === "script_run" || name === "script_eval") {
    const language = (args as ScriptRunArgs | ScriptEvalArgs).language;
    return {
      tool: name,
      text,
      ok,
      language,
      kind: language === "python" ? "python-job" : "cue-shell-script",
      ...(optionalString(details.scriptId) ? { scriptId: optionalString(details.scriptId) } : {}),
      ...(optionalString(details.jobId) ? { jobId: optionalString(details.jobId) } : {}),
      status:
        optionalString(details.status) ?? (cancelled ? "cancelled" : ok ? "finished" : "failed"),
      ...(optionalNumber(details.exitCode) !== undefined
        ? { exitCode: optionalNumber(details.exitCode) }
        : {}),
      timedOut: details.timedOut === true,
      cancelled,
      items: Array.isArray(details.items) ? details.items : [],
      stdout: stream(details, "stdout"),
      stderr: stream(details, "stderr"),
    } as CueToolResultMap[Name];
  }

  if (name === "cue_history") {
    return {
      tool: name,
      text,
      ok,
      ...((args as CueHistoryArgs).id ? { targetId: (args as CueHistoryArgs).id } : {}),
      rawChars: typeof details.rawChars === "number" ? details.rawChars : text.length,
      shownChars: typeof details.shownChars === "number" ? details.shownChars : text.length,
      lines: text ? text.split(/\r?\n/u).length : 0,
      truncated: details.truncated === true,
    } as CueToolResultMap[Name];
  }

  const action = (args as CueJobsArgs | CueResourcesArgs | CueScheduleArgs | CueScopeArgs).action;
  const argumentId = (args as CueJobsArgs | CueScheduleArgs).id;
  return {
    tool: name,
    text,
    ok,
    action,
    ...(optionalString(details.targetId) || optionalString(details.id) || argumentId
      ? { targetId: optionalString(details.targetId) ?? optionalString(details.id) ?? argumentId }
      : {}),
    ...(optionalString(details.status) ? { status: optionalString(details.status) } : {}),
    ...(typeof details.found === "boolean" ? { found: details.found } : {}),
    timedOut: details.timedOut === true,
    ...(typeof details.count === "number" ? { count: details.count } : {}),
    ...(typeof details.shown === "number" ? { shown: details.shown } : {}),
    records: recordsOf(details),
    ...(optionalString(details.jobId) ? { jobId: optionalString(details.jobId) } : {}),
    ...(optionalString(details.chainId) ? { chainId: optionalString(details.chainId) } : {}),
    ...(optionalString(details.cronId) ? { cronId: optionalString(details.cronId) } : {}),
    ...(optionalNumber(details.exitCode) !== undefined
      ? { exitCode: optionalNumber(details.exitCode) }
      : {}),
    ...(optionalString(details.key) ? { key: optionalString(details.key) } : {}),
    ...(optionalString(details.path) ? { path: optionalString(details.path) } : {}),
    ...(optionalString(details.cwd) ? { cwd: optionalString(details.cwd) } : {}),
    ...(details.scope !== undefined ? { scope: details.scope } : {}),
    ...(typeof details.rawChars === "number" ? { rawChars: details.rawChars } : {}),
    ...(typeof details.shownChars === "number" ? { shownChars: details.shownChars } : {}),
    ...(typeof details.truncated === "boolean" ? { truncated: details.truncated } : {}),
  } as CueToolResultMap[Name];
}

export function createCueToolRuntime(config: CueToolRuntimeConfig = {}): CueToolRuntime {
  const tools = new Map<CueToolName, SparkCueToolConfig>();
  const registration = registerCueOperationDefinitions({
    registerTool(tool) {
      if ((CUE_TOOL_NAMES as readonly string[]).includes(tool.name)) {
        tools.set(tool.name as CueToolName, tool);
      }
    },
  });
  const sessions = new Map<string, SparkCueToolContext>();
  let disposed = false;

  return {
    async execute(name, args, context) {
      if (disposed) throw new Error("Cue tool runtime is disposed");
      const tool = tools.get(name);
      if (!tool) throw new Error(`Unknown Cue tool: ${name}`);
      validateConditionalArgs(name, args);
      const signal = context.signal ?? new AbortController().signal;
      const toolContext: SparkCueToolContext = {
        sessionId: context.sessionId,
        cwd: context.cwd,
        env: context.env,
        cueRemoteCwd: config.remoteCwd,
        cueAutoStartLocal: config.autoStartLocal ?? true,
        cueForwardSensitiveEnv: config.forwardSensitiveEnv ?? false,
        cueResolvedTransport: config.resolvedTransport,
        cueClient: config.client,
      };
      sessions.set(context.sessionId, toolContext);
      try {
        const result = await tool.execute(
          context.operationId ?? `${context.sessionId}:${name}`,
          args as Record<string, unknown>,
          signal,
          (update) => context.onUpdate?.(textOf(update.content)),
          toolContext,
        );
        return canonicalize(name, args, textOf(result.content), result.details ?? {}, true);
      } catch (error) {
        const details =
          error && typeof error === "object" && "details" in error
            ? ((error as { details?: Record<string, unknown> }).details ?? {})
            : undefined;
        const cancelled = signal.aborted || (error instanceof Error && error.name === "AbortError");
        if (!details && !cancelled) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return canonicalize(name, args, message, details ?? {}, false, cancelled);
      }
    },
    releaseSession(sessionId) {
      const context = sessions.get(sessionId);
      if (!context) return;
      sessions.delete(sessionId);
      registration.releaseSession(context);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sessions.clear();
      registration.dispose();
    },
  };
}
