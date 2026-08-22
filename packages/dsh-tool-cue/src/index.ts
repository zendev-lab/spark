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
  ESCALATION_TARGETS,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  type SandboxMode,
  type SandboxPolicy,
} from "@deepseek-ai/dsh-sandbox";
import {
  CUE_TOOL_NAMES,
  createCueToolRuntime,
  type CueToolRuntime,
  type CueToolArgsMap,
  type CueToolName,
  type CueToolResultMap,
} from "@zendev-lab/spark-cue/operations";
import { resolveCueTransport } from "@zendev-lab/spark-cue";
import type { CueResolvedTransport } from "@zendev-lab/spark-cue";
import {
  startSpawnAdapterBroker,
  type SandboxSpawnFact,
  type SpawnAdapterBroker,
} from "./spawn-adapter-broker.ts";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-shell-env";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-user-approval";

export const name = "dsh-tool-cue";
export const inject = ["tools", "systemPrompt", "sandboxPolicy", "sandbox", "approval", "shellEnv"];

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
  "Cue is direct-exec (execvp), not bash — do not use raw '|', ';', '<', '>', '$()' or backticks. " +
  "Composition operators compile one ExecutionPlan: '|>' pipeline, '&&'/'->' on-success, " +
  "'||' on-failure, '~>' always, '|||' parallel-all, '|?|' any-success. " +
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
    sandbox: { type: "json" },
  } as const;
}

const escalationProperties = {
  sandbox_permissions: {
    type: "string",
    enum: [...ESCALATION_TARGETS],
    description: "Request a one-call wider DSH sandbox mode; requires justification.",
  },
  justification: {
    type: "string",
    description: "One sentence explaining why this call needs wider sandbox access.",
  },
} as const;

const execOutput = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...baseProperties("cue_exec"),
    kind: { type: "string", enum: ["foreground", "background"], required: true },
    executionId: { type: "string" },
    stepIds: { type: "array", items: { type: "string" }, required: true },
    status: { type: "string" },
    exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
    timedOut: { type: "boolean", required: true },
    detached: { type: "boolean", required: true },
    cancelled: { type: "boolean", required: true },
    cancelReason: { type: "string", enum: ["user", "forced"] },
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
      executionId: { type: "string" },
      stepIds: { type: "array", items: { type: "string" }, required: true },
      source: { type: "json" },
      status: { type: "string", required: true },
      exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
      failedStepIndex: { oneOf: [{ type: "integer" }, { type: "null" }] },
      timedOut: { type: "boolean", required: true },
      cancelled: { type: "boolean", required: true },
      cancelReason: { type: "string", enum: ["user", "forced"] },
      stdout: { ...streamSchema, required: true },
      stderr: { ...streamSchema, required: true },
    },
  } as const;
}

function languageOutput<const Name extends "script_run" | "script_eval">(tool: Name) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...baseProperties(tool),
      language: { type: "string", enum: ["cue", "python"], required: true },
      kind: { type: "string", enum: ["cue-script", "python-execution"], required: true },
      executionId: { type: "string" },
      stepIds: { type: "array", items: { type: "string" }, required: true },
      status: { type: "string", required: true },
      exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
      timedOut: { type: "boolean", required: true },
      cancelled: { type: "boolean", required: true },
      cancelReason: { type: "string", enum: ["user", "forced"] },
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
      executionId: { type: "string" },
      stepIds: { type: "array", items: { type: "string" } },
      scheduleId: { type: "string" },
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
      "Execute a direct command or Cue composition through cued; timeout detaches rather than cancelling the execution. " +
      CUE_BASH_NOTICE,
    parameters: {
      command: { type: "string", required: true },
      background: { type: "boolean" },
      timeout: { type: "number" },
      cwd: { type: "string" },
      pty: { type: "boolean" },
      tail_bytes: { type: "number" },
      needs: { type: "object", additionalProperties: true },
      ...escalationProperties,
    },
    output: execOutput,
  },
  cue_run: {
    description: "Run a .cue file through cued with fail-fast script semantics.",
    parameters: {
      path: { type: "string", required: true },
      timeout: { type: "number" },
      tail_bytes: { type: "number" },
      ...escalationProperties,
    },
    output: scriptOutput("cue_run"),
  },
  cue_script: {
    description: "Run an inline Cue script through cued.",
    parameters: {
      script: { type: "string", required: true },
      pathLabel: { type: "string" },
      timeout: { type: "number" },
      tail_bytes: { type: "number" },
      ...escalationProperties,
    },
    output: scriptOutput("cue_script"),
  },
  script_run: {
    description: "Run a Cue or Python script file through cued.",
    parameters: {
      path: { type: "string", required: true },
      language: { type: "string", enum: ["cue", "python"], required: true },
      timeout: { type: "number" },
      tail_bytes: { type: "number" },
      venv: { type: "string" },
      ...escalationProperties,
    },
    output: languageOutput("script_run"),
  },
  script_eval: {
    description: "Evaluate an inline Cue or Python script through cued.",
    parameters: {
      script: { type: "string", required: true },
      language: { type: "string", enum: ["cue", "python"], required: true },
      pathLabel: { type: "string" },
      timeout: { type: "number" },
      tail_bytes: { type: "number" },
      venv: { type: "string" },
      ...escalationProperties,
    },
    output: languageOutput("script_eval"),
  },
  cue_jobs: {
    description: "List, inspect, wait for, or cancel cued executions.",
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
    description: "Read bounded cued execution history.",
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

const EXECUTION_TOOLS = new Set<CueToolName>([
  "cue_exec",
  "cue_run",
  "cue_script",
  "script_run",
  "script_eval",
]);

interface BrokerRegistry {
  retain(sessionId: string, broker: SpawnAdapterBroker, mode: SandboxMode): void;
  bindExecution(sessionId: string, executionId: string, broker: SpawnAdapterBroker): void;
  sandboxFor(
    sessionId: string,
    executionId: string,
  ): { mode: SandboxMode; facts: SandboxSpawnFact[]; pending: boolean } | undefined;
  release(sessionId: string, broker: SpawnAdapterBroker): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

function createBrokerRegistry(): BrokerRegistry {
  const maxCompletedExecutions = 256;
  const sessions = new Map<string, Set<SpawnAdapterBroker>>();
  const metadata = new Map<
    SpawnAdapterBroker,
    { sessionId: string; mode: SandboxMode; executionId?: string }
  >();
  const completed = new Map<
    string,
    { sessionId: string; executionId: string; mode: SandboxMode; facts: SandboxSpawnFact[] }
  >();
  const completedKey = (sessionId: string, executionId: string) =>
    `${sessionId.length}:${sessionId}${executionId}`;
  return {
    retain(sessionId, broker, mode) {
      const brokers = sessions.get(sessionId) ?? new Set<SpawnAdapterBroker>();
      brokers.add(broker);
      sessions.set(sessionId, brokers);
      metadata.set(broker, { sessionId, mode });
    },
    bindExecution(sessionId, executionId, broker) {
      const entry = metadata.get(broker);
      if (!entry || entry.sessionId !== sessionId) {
        throw new Error("sandbox broker is not owned by this Cue session");
      }
      entry.executionId = executionId;
    },
    sandboxFor(sessionId, executionId) {
      for (const [broker, entry] of metadata) {
        if (entry.sessionId === sessionId && entry.executionId === executionId) {
          return { mode: entry.mode, facts: broker.facts(), pending: true };
        }
      }
      const entry = completed.get(completedKey(sessionId, executionId));
      return entry ? { mode: entry.mode, facts: entry.facts, pending: false } : undefined;
    },
    async release(sessionId, broker) {
      const entry = metadata.get(broker);
      if (entry?.executionId) {
        const key = completedKey(sessionId, entry.executionId);
        completed.delete(key);
        completed.set(key, {
          sessionId,
          executionId: entry.executionId,
          mode: entry.mode,
          facts: broker.facts(),
        });
        while (completed.size > maxCompletedExecutions) {
          const oldest = completed.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          completed.delete(oldest);
        }
      }
      metadata.delete(broker);
      const brokers = sessions.get(sessionId);
      brokers?.delete(broker);
      if (brokers?.size === 0) sessions.delete(sessionId);
      await broker.close();
    },
    async releaseSession(sessionId) {
      const brokers = sessions.get(sessionId);
      sessions.delete(sessionId);
      for (const [key, entry] of completed) {
        if (entry.sessionId === sessionId) completed.delete(key);
      }
      for (const broker of brokers ?? []) metadata.delete(broker);
      await Promise.all([...(brokers ?? [])].map(async (broker) => broker.close()));
    },
    async dispose() {
      const brokers = [...sessions.values()].flatMap((items) => [...items]);
      sessions.clear();
      metadata.clear();
      completed.clear();
      await Promise.all(brokers.map(async (broker) => broker.close()));
    },
  };
}

function sandboxSummary(mode: SandboxMode, facts: SandboxSpawnFact[], pending: boolean) {
  return {
    mode,
    enforcement:
      mode === "danger-full-access"
        ? "not_applicable"
        : facts.some((fact) => fact.enforcement === "partial")
          ? "partial"
          : facts.length > 0
            ? "full"
            : "pending",
    segments: facts.length,
    denied: facts.some((fact) => fact.denied),
    runnerFailure: facts.some((fact) => fact.runnerFailure),
    pending,
    facts,
  };
}

function resultExecutionId(result: Record<string, unknown>): string | undefined {
  const value = result.executionId;
  return typeof value === "string" && /^E\d+$/u.test(value) ? value : undefined;
}

function resultDetached(result: Record<string, unknown>): boolean {
  return result.detached === true || result.timedOut === true;
}

async function waitForExecutionAndRelease(
  runtime: Pick<CueToolRuntime, "execute">,
  executionId: string,
  context: {
    sessionId: string;
    cwd: string;
    env: Record<string, string | undefined>;
  },
  registry: BrokerRegistry,
  broker: SpawnAdapterBroker,
): Promise<void> {
  try {
    while (true) {
      const result = await runtime.execute(
        "cue_jobs",
        { action: "wait", id: executionId, timeout: 3600 },
        { ...context, operationId: `${executionId}:sandbox-lease` },
      );
      if (!result.timedOut) return;
    }
  } finally {
    await registry.release(context.sessionId, broker);
  }
}

function registerDefinition<Name extends CueToolName>(
  ctx: Context,
  runtime: Pick<CueToolRuntime, "execute">,
  toolName: Name,
  brokerRegistry: BrokerRegistry,
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
        const sessionId = `dsh:${agent.session.id}`;
        const basePolicy = ctx.sandboxPolicy.resolve({ session: agent.session });
        if (
          toolName === "cue_schedule" &&
          ((args as Record<string, unknown>).action === "add" ||
            (args as Record<string, unknown>).action === "resume") &&
          basePolicy.mode !== "danger-full-access"
        ) {
          throw new Error(
            `cue_schedule ${(args as Record<string, unknown>).action as string} requires the current DSH session to have persistent danger-full-access; one-call escalation cannot authorize future execution`,
          );
        }

        let mode = basePolicy.mode;
        let broker: SpawnAdapterBroker | undefined;
        let resolvedTransport: CueResolvedTransport | undefined;
        if (EXECUTION_TOOLS.has(toolName)) {
          const raw = args as Record<string, unknown>;
          const sandboxPermissions =
            typeof raw.sandbox_permissions === "string" ? raw.sandbox_permissions : undefined;
          const justification =
            typeof raw.justification === "string" ? raw.justification : undefined;
          validateEscalationArgs(sandboxPermissions, justification);
          if (sandboxPermissions && justification) {
            mode = await approveEscalation(
              {
                requestedMode: sandboxPermissions,
                justification,
                effectiveMode: basePolicy.mode,
                subject: "command",
              },
              {
                approver: ctx.approval,
                agent,
                callId: exec.callId,
                toolName,
                signal: exec.signal,
              },
            );
          }
          if (mode !== "danger-full-access") {
            resolvedTransport = await resolveCueTransport();
            if (resolvedTransport.transport === "ssh") {
              throw new Error(
                `confined Cue execution over SSH is not supported; use a local Cue target or a persistent danger-full-access session`,
              );
            }
            const policy = ctx.sandboxPolicy.resolve({
              session: agent.session,
              mode,
            }) as SandboxPolicy;
            broker = await startSpawnAdapterBroker({ sandbox: ctx.sandbox, policy });
            brokerRegistry.retain(sessionId, broker, mode);
          }
        }

        try {
          const result = (await runtime.execute(toolName, args as unknown as CueToolArgsMap[Name], {
            sessionId,
            cwd,
            env,
            signal: exec.signal,
            operationId: String(exec.callId),
            spawnAdapter: broker?.handle,
            resolvedTransport,
          })) as CueToolResultMap[Name] & Record<string, unknown>;
          const detached = broker !== undefined && resultDetached(result);
          const executionId = resultExecutionId(result);
          if (broker && executionId) {
            brokerRegistry.bindExecution(sessionId, executionId, broker);
          }
          const tracked =
            broker !== undefined
              ? { mode, facts: broker.facts(), pending: detached }
              : toolName === "cue_jobs" && typeof (args as Record<string, unknown>).id === "string"
                ? brokerRegistry.sandboxFor(
                    sessionId,
                    (args as Record<string, unknown>).id as string,
                  )
                : undefined;
          const sandbox = tracked
            ? sandboxSummary(tracked.mode, tracked.facts, tracked.pending)
            : undefined;
          let text = result.text;
          if (sandbox?.runnerFailure) text += `\n\n[sandbox runner failure]`;
          if (sandbox?.denied) {
            text += `\n\n${sandboxDenialMarker(tracked?.mode ?? mode)}\n${escalationHintMarker("command")}`;
          }
          const enriched = { ...result, text, ...(sandbox ? { sandbox } : {}) };
          if (broker) {
            if (detached && executionId) {
              void waitForExecutionAndRelease(
                runtime,
                executionId,
                { sessionId, cwd, env },
                brokerRegistry,
                broker,
              ).catch((error) => {
                console.error(
                  `[dsh-tool-cue] failed to settle sandbox lease for ${executionId}`,
                  error,
                );
              });
            } else {
              await brokerRegistry.release(sessionId, broker);
            }
          }
          return enriched as never;
        } catch (error) {
          if (broker) await brokerRegistry.release(sessionId, broker);
          throw error;
        }
      },
    }) as ToolDefinition,
  );
}

/** Register the ten supported definitions against an operation executor. */
export function registerCueToolDefinitions(
  ctx: Context,
  runtime: Pick<CueToolRuntime, "execute">,
  brokerRegistry = createBrokerRegistry(),
): void {
  for (const toolName of CUE_TOOL_NAMES) registerDefinition(ctx, runtime, toolName, brokerRegistry);
}

export function apply(ctx: Context, config: Config = {}): void {
  const brokerRegistry = createBrokerRegistry();
  const runtime = createCueToolRuntime({
    autoStartLocal: config.autoStartLocal ?? true,
    remoteCwd: config.remoteCwd,
    forwardSensitiveEnv: config.forwardSensitiveEnv ?? false,
  });

  ctx.tools.guard((exec) => {
    if (!(CUE_TOOL_NAMES as readonly string[]).includes(exec.name)) return undefined;
    return exec.agent === undefined ? `${exec.name} requires a DSH Agent and Session` : undefined;
  });

  ctx.systemPrompt.section({
    name: "tool:cue",
    order: 105,
    text:
      "Use Cue tools for command, script, execution, resource, schedule, scope, and history operations. " +
      "Cue is direct-exec rather than Bash; use Cue composition operators. " +
      "If a command contains bash-style pipe/redirection/semicolon, rewrite it to Cue operators first — never retry raw bash syntax. " +
      "A foreground timeout detaches the durable execution instead of cancelling it.",
  });

  registerCueToolDefinitions(ctx, runtime, brokerRegistry);
  ctx.on("agent/disposed", ({ agent }) => {
    const sessionId = `dsh:${agent.session.id}`;
    runtime.releaseSession(sessionId);
    void brokerRegistry.releaseSession(sessionId).catch((error) => {
      console.error(`[dsh-tool-cue] failed to release sandbox session ${sessionId}`, error);
    });
  });
  ctx.effect(
    () => () => {
      runtime.dispose();
      void brokerRegistry.dispose().catch((error) => {
        console.error("[dsh-tool-cue] failed to dispose sandbox brokers", error);
      });
    },
    "dsh-tool-cue runtime teardown",
  );
}
