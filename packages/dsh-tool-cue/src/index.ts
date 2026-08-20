import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolResult,
  type ValueSchemaSpec,
} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import {
  CUE_TOOL_NAMES,
  createCueToolRuntime,
  type CueToolRuntime,
  type CueToolArgsMap,
  type CueToolName,
  type CueToolResultMap,
} from "@zendev-lab/spark-cue/operations";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-shell-env";
import type {} from "@deepseek-ai/dsh-system-prompt";

export const name = "dsh-tool-cue";
export const inject = ["tools", "systemPrompt", "sandboxPolicy", "shellEnv"];

export interface Config {
  autoStartLocal?: boolean;
  remoteCwd?: string;
  forwardSensitiveEnv?: boolean;
}

export const Config = z.object({
  autoStartLocal: z.boolean().default(true),
  remoteCwd: z.string(),
  forwardSensitiveEnv: z.boolean().default(false),
}) as z<Config>;

/**
 * Shared "not bash" guidance appended to every cue-* tool description so the
 * LLM sees it before the first call. Keep this in one place; the DSH adapter
 * owns only the host ABI, spark-cue remains the semantic owner.
 */
const CUE_BASH_NOTICE =
  "cue-shell is direct-exec (execvp), not bash — do not use raw '|', ';', '<', '>', '$()' or backticks. " +
  "Composition operators: '|>' pipes stdout in one job, '&&'/'||' are job-internal logic, " +
  "'->' serial-on-success, '~>' serial ignoring failure, '|||' parallel, '|?|' any-success race. " +
  "Example: 'cargo build |> grep error -> cargo test'. Rewrite bash-style pipes/redirection before calling.";

const streamSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", required: true },
    encoding: { type: "string", required: true },
    truncated: { type: "boolean", required: true },
    base64: { type: "string" },
  },
} as const;

function baseProperties<const Name extends CueToolName>(tool: Name) {
  return {
    tool: { type: "string", const: tool, required: true },
    text: { type: "string", required: true },
    ok: { type: "boolean", required: true },
  } as const;
}

const execOutput = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...baseProperties("cue_exec"),
    kind: { type: "string", enum: ["foreground", "background"], required: true },
    jobId: { type: "string" },
    chainId: { type: "string" },
    status: { type: "string" },
    exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
    timedOut: { type: "boolean", required: true },
    detached: { type: "boolean", required: true },
    cancelled: { type: "boolean", required: true },
    stdout: { ...streamSchema, required: true },
    stderr: { ...streamSchema, required: true },
    warnings: { type: "array", items: { type: "string" }, required: true },
  },
} as const;

function scriptOutput<const Name extends "cue_run" | "cue_script">(tool: Name) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...baseProperties(tool),
      scriptId: { type: "string" },
      source: { type: "json" },
      status: { type: "string", required: true },
      exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
      failedItemIndex: { oneOf: [{ type: "integer" }, { type: "null" }] },
      timedOut: { type: "boolean", required: true },
      cancelled: { type: "boolean", required: true },
      items: { type: "array", items: { type: "json" }, required: true },
    },
  } as const;
}

function languageOutput<const Name extends "script_run" | "script_eval">(tool: Name) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...baseProperties(tool),
      language: { type: "string", enum: ["cue-shell", "python"], required: true },
      kind: { type: "string", enum: ["cue-shell-script", "python-job"], required: true },
      scriptId: { type: "string" },
      jobId: { type: "string" },
      status: { type: "string", required: true },
      exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
      timedOut: { type: "boolean", required: true },
      cancelled: { type: "boolean", required: true },
      items: { type: "array", items: { type: "json" }, required: true },
      stdout: { ...streamSchema, required: true },
      stderr: { ...streamSchema, required: true },
    },
  } as const;
}

function actionBranch<
  const Name extends "cue_jobs" | "cue_resources" | "cue_schedule" | "cue_scope",
  const Action extends string,
>(tool: Name, action: Action) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...baseProperties(tool),
      action: { type: "string", const: action, required: true },
      targetId: { type: "string" },
      status: { type: "string" },
      found: { type: "boolean" },
      timedOut: { type: "boolean", required: true },
      count: { type: "integer" },
      shown: { type: "integer" },
      records: { type: "array", items: { type: "json" }, required: true },
      jobId: { type: "string" },
      chainId: { type: "string" },
      cronId: { type: "string" },
      exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
      key: { type: "string" },
      path: { type: "string" },
      cwd: { type: "string" },
      scope: { type: "json" },
      rawChars: { type: "integer" },
      shownChars: { type: "integer" },
      truncated: { type: "boolean" },
    },
  } as const;
}

const jobsOutput = {
  oneOf: [
    actionBranch("cue_jobs", "list"),
    actionBranch("cue_jobs", "status"),
    actionBranch("cue_jobs", "wait"),
    actionBranch("cue_jobs", "stop"),
  ],
} as const;
const resourcesOutput = {
  oneOf: [actionBranch("cue_resources", "providers"), actionBranch("cue_resources", "resources")],
} as const;
const scheduleOutput = {
  oneOf: [
    actionBranch("cue_schedule", "add"),
    actionBranch("cue_schedule", "list"),
    actionBranch("cue_schedule", "pause"),
    actionBranch("cue_schedule", "resume"),
    actionBranch("cue_schedule", "remove"),
  ],
} as const;
const scopeOutput = {
  oneOf: [
    actionBranch("cue_scope", "list"),
    actionBranch("cue_scope", "env"),
    actionBranch("cue_scope", "config"),
    actionBranch("cue_scope", "env_set"),
    actionBranch("cue_scope", "env_unset"),
    actionBranch("cue_scope", "path_prepend"),
    actionBranch("cue_scope", "cd"),
    actionBranch("cue_scope", "refresh"),
    actionBranch("cue_scope", "status"),
  ],
} as const;

const historyOutput = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...baseProperties("cue_history"),
    targetId: { type: "string" },
    rawChars: { type: "integer", required: true },
    shownChars: { type: "integer", required: true },
    lines: { type: "integer", required: true },
    truncated: { type: "boolean", required: true },
  },
} as const;

const definitions = {
  cue_exec: {
    description:
      "Execute a direct command or Cue composition through cued; timeout detaches rather than killing the job. " +
      CUE_BASH_NOTICE,
    parameters: {
      command: { type: "string", required: true },
      background: { type: "boolean" },
      timeout: { type: "number" },
      cwd: { type: "string" },
      pty: { type: "boolean" },
      tail_bytes: { type: "number" },
      needs: { type: "object", additionalProperties: true },
    },
    output: execOutput,
  },
  cue_run: {
    description: "Run a .cue file through cued with fail-fast script semantics.",
    parameters: {
      path: { type: "string", required: true },
      timeout: { type: "number" },
      tail_bytes: { type: "number" },
    },
    output: scriptOutput("cue_run"),
  },
  cue_script: {
    description: "Run an inline cue-shell script through cued.",
    parameters: {
      script: { type: "string", required: true },
      pathLabel: { type: "string" },
      timeout: { type: "number" },
      tail_bytes: { type: "number" },
    },
    output: scriptOutput("cue_script"),
  },
  script_run: {
    description: "Run a cue-shell or Python script file through cued.",
    parameters: {
      path: { type: "string", required: true },
      language: { type: "string", enum: ["cue-shell", "python"], required: true },
      timeout: { type: "number" },
      tail_bytes: { type: "number" },
      venv: { type: "string" },
    },
    output: languageOutput("script_run"),
  },
  script_eval: {
    description: "Evaluate an inline cue-shell or Python script through cued.",
    parameters: {
      script: { type: "string", required: true },
      language: { type: "string", enum: ["cue-shell", "python"], required: true },
      pathLabel: { type: "string" },
      timeout: { type: "number" },
      tail_bytes: { type: "number" },
      venv: { type: "string" },
    },
    output: languageOutput("script_eval"),
  },
  cue_jobs: {
    description: "List, inspect, wait for, or stop cued jobs and chains.",
    parameters: {
      action: { type: "string", enum: ["list", "status", "wait", "stop"], required: true },
      id: { type: "string" },
      status: { type: "string" },
      limit: { type: "number" },
      timeout: { type: "number" },
      tail_bytes: { type: "number" },
    },
    output: jobsOutput,
  },
  cue_resources: {
    description: "Inspect cued providers and resource availability.",
    parameters: {
      action: { type: "string", enum: ["providers", "resources"], required: true },
    },
    output: resourcesOutput,
  },
  cue_schedule: {
    description: "Add, list, pause, resume, or remove cued schedules.",
    parameters: {
      action: {
        type: "string",
        enum: ["add", "list", "pause", "resume", "remove"],
        required: true,
      },
      id: { type: "string" },
      schedule: { type: "string" },
      command: { type: "string" },
      status: { type: "string" },
      limit: { type: "number" },
    },
    output: scheduleOutput,
  },
  cue_scope: {
    description: "Inspect or mutate the current cued scope.",
    parameters: {
      action: {
        type: "string",
        enum: [
          "list",
          "env",
          "config",
          "env_set",
          "env_unset",
          "path_prepend",
          "cd",
          "refresh",
          "status",
        ],
        required: true,
      },
      key: { type: "string" },
      value: { type: "string" },
      path: { type: "string" },
      limit: { type: "number" },
      includeEnv: { type: "boolean" },
      tail_bytes: { type: "number" },
    },
    output: scopeOutput,
  },
  cue_history: {
    description: "Read bounded cued command, job, chain, or script history.",
    parameters: {
      id: { type: "string" },
      limit: { type: "number" },
      tail_bytes: { type: "number" },
    },
    output: historyOutput,
  },
} as const;

function rawText(result: ToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function presentCueCall(name: CueToolName, args: Record<string, unknown>) {
  if (name === "cue_exec" && args.background !== true && typeof args.command === "string") {
    return {
      card: "terminal" as const,
      title: args.command,
      ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
    };
  }
  const action = typeof args.action === "string" ? ` ${args.action}` : "";
  return {
    card: "generic" as const,
    title: `${name}${action}`,
    kind:
      name === "cue_resources" || name === "cue_history" ? ("read" as const) : ("execute" as const),
    rawInput: args,
  };
}

export function presentCueResult(name: CueToolName, result: ToolResult) {
  const text = rawText(result);
  if (name === "cue_exec") {
    return { card: "terminal" as const, output: text };
  }
  return {
    card: "generic" as const,
    title: result.isError ? `${name} failed` : `${name} completed`,
    content: result.content,
  };
}

function registerDefinition<Name extends CueToolName>(
  ctx: Context,
  runtime: Pick<CueToolRuntime, "execute">,
  toolName: Name,
): void {
  const spec = definitions[toolName];
  ctx.tools.register(
    defineTool({
      name: toolName,
      description: spec.description,
      parameters: spec.parameters as ParameterSchemaSpec,
      output: {
        schema: spec.output as ValueSchemaSpec,
        render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }],
      },
      presentCall: (args) => presentCueCall(toolName, args as Record<string, unknown>),
      presentResult: (_args, result) => presentCueResult(toolName, result),
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === undefined) {
          throw new Error(`${toolName} requires a DSH Agent and Session`);
        }
        const cwd = agent.session.header.cwd;
        if (cwd === undefined) {
          throw new Error(`${toolName} requires an immutable session cwd`);
        }
        const env = { ...process.env, ...ctx.shellEnv.collect(exec) };
        return runtime.execute(toolName, args as unknown as CueToolArgsMap[Name], {
          sessionId: `dsh:${agent.session.id}`,
          cwd,
          env,
          signal: exec.signal,
          operationId: String(exec.callId),
        }) as Promise<CueToolResultMap[Name]> as never;
      },
    }) as ToolDefinition,
  );
}

/** Register the ten supported definitions against an operation executor. */
export function registerCueToolDefinitions(
  ctx: Context,
  runtime: Pick<CueToolRuntime, "execute">,
): void {
  for (const toolName of CUE_TOOL_NAMES) registerDefinition(ctx, runtime, toolName);
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = createCueToolRuntime({
    autoStartLocal: config.autoStartLocal ?? true,
    remoteCwd: config.remoteCwd,
    forwardSensitiveEnv: config.forwardSensitiveEnv ?? false,
  });

  ctx.tools.guard((exec) => {
    if (!(CUE_TOOL_NAMES as readonly string[]).includes(exec.name)) return undefined;
    return exec.agent === undefined ? `${exec.name} requires a DSH Agent and Session` : undefined;
  });

  ctx.on("tools/pre-execute", (exec, next) => {
    if (!(CUE_TOOL_NAMES as readonly string[]).includes(exec.name)) return next();
    if (exec.agent === undefined) return next();
    const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session });
    if (policy.mode !== "danger-full-access") {
      return Promise.resolve({
        kind: "deny" as const,
        reason: `${exec.name} requires danger-full-access because external cued execution is not confined by the DSH file sandbox (current mode: ${policy.mode})`,
      });
    }
    return next();
  });

  ctx.systemPrompt.section({
    name: "tool:cue",
    order: 105,
    text:
      "Use Cue tools for command, script, job, resource, schedule, scope, and history operations. " +
      "Cue is direct-exec rather than Bash; use Cue composition operators. " +
      "If a command contains bash-style pipe/redirection/semicolon, rewrite it to Cue operators first — never retry raw bash syntax. " +
      "A foreground timeout detaches the durable job instead of killing it.",
  });

  registerCueToolDefinitions(ctx, runtime);
  ctx.on("agent/disposed", ({ agent }) => runtime.releaseSession(`dsh:${agent.session.id}`));
  ctx.effect(() => () => runtime.dispose(), "dsh-tool-cue runtime teardown");
}
