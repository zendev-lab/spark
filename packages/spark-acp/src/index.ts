import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  type AgentApp,
  type AgentContext,
  type SessionUpdate,
  type StopReason,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import {
  createSparkDaemonOrpcClient,
  invokeSparkDaemonOrpcLiveMethod,
  type SparkDaemonOrpcClientHandle,
} from "@zendev-lab/spark-daemon-client";
import {
  createId,
  parseSparkSessionRegistryRecord,
  sparkDaemonEventSchema,
  sparkTurnCancelResultSchema,
  sparkTurnResultSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  sparkTurnSubmitResultSchema,
  type SparkDaemonEvent,
  type SparkInvocationStatus,
  type SparkTurnStreamPage,
} from "@zendev-lab/spark-protocol";

export interface SparkAcpSessionRecord {
  /** ACP deliberately reuses the daemon's canonical session id. */
  sparkSessionId: string;
  cwd: string;
  createdAt: string;
  activeInvocationId: string | undefined;
  cursor: number;
  emittedAssistantText: boolean;
  textByMessageId: Map<string, string>;
  toolStateByCallId: Map<string, "in_progress" | "completed">;
}

export interface SparkAcpDaemon {
  resolveWorkspace(input: { cwd: string }): Promise<{
    id: string;
    cwd: string;
    cwdArtifactRef?: string;
  }>;
  createSession(input: {
    cwd: string;
    workspaceId: string;
    cwdArtifactRef?: string;
    title?: string;
  }): Promise<{ sessionId: string; createdAt: string }>;
  submitTurn(input: {
    sessionId: string;
    prompt: string;
    idempotencyKey: string;
  }): Promise<{ invocationId: string }>;
  streamTurn(input: { invocationId: string; after: number }): Promise<SparkTurnStreamPage>;
  statusTurn(input: { invocationId: string }): Promise<{
    invocationId: string;
    status: SparkInvocationStatus;
  }>;
  resultTurn(input: { invocationId: string }): Promise<{
    invocationId: string;
    status: SparkInvocationStatus;
    assistantText?: string | undefined;
    error?: { message: string } | undefined;
  }>;
  cancelTurn(input: { invocationId: string; reason: string }): Promise<void>;
  respondHuman(input: Record<string, unknown>): Promise<void>;
  close(): void;
}

export interface SparkAcpAgentOptions {
  name?: string;
  defaultCwd?: string;
  pollIntervalMs?: number;
  daemon?: SparkAcpDaemon;
  daemonFactory?: () => Promise<SparkAcpDaemon>;
}

export interface SparkAcpAgentHandle {
  app: AgentApp;
  sessions: Map<string, SparkAcpSessionRecord>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export function createSparkAcpAgent(options: SparkAcpAgentOptions = {}): SparkAcpAgentHandle {
  const sessions = new Map<string, SparkAcpSessionRecord>();
  const name = options.name ?? "spark-acp";
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  let daemonPromise: Promise<SparkAcpDaemon> | undefined;
  const daemon = () =>
    options.daemon
      ? Promise.resolve(options.daemon)
      : (daemonPromise ??= (options.daemonFactory ?? createOrpcDaemon)());

  const app = agent({ name })
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name, version: "0.1.0" },
    }))
    .onRequest(methods.agent.authenticate, async () => ({}))
    .onRequest(methods.agent.session.new, async (ctx) => {
      const cwd =
        typeof ctx.params.cwd === "string" && ctx.params.cwd.trim() ? ctx.params.cwd : defaultCwd;
      const control = await daemon();
      const workspace = await control.resolveWorkspace({ cwd });
      const created = await control.createSession({
        cwd: workspace.cwd,
        workspaceId: workspace.id,
        ...(workspace.cwdArtifactRef ? { cwdArtifactRef: workspace.cwdArtifactRef } : {}),
        title: "ACP session",
      });
      const record: SparkAcpSessionRecord = {
        sparkSessionId: created.sessionId,
        cwd: workspace.cwd,
        createdAt: created.createdAt,
        activeInvocationId: undefined,
        cursor: 0,
        emittedAssistantText: false,
        textByMessageId: new Map(),
        toolStateByCallId: new Map(),
      };
      sessions.set(created.sessionId, record);
      return { sessionId: created.sessionId };
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) {
        throw RequestError.invalidParams(undefined, `unknown ACP session: ${ctx.params.sessionId}`);
      }
      if (session.activeInvocationId) {
        throw RequestError.invalidParams(
          undefined,
          `ACP session already has an active turn: ${ctx.params.sessionId}`,
        );
      }
      const prompt = strictPromptText(ctx.params.prompt);
      const control = await daemon();
      const submitted = await control.submitTurn({
        sessionId: session.sparkSessionId,
        prompt,
        idempotencyKey: `acp:${session.sparkSessionId}:${String(ctx.requestId)}`,
      });
      session.activeInvocationId = submitted.invocationId;
      session.cursor = 0;
      session.emittedAssistantText = false;
      session.textByMessageId.clear();
      session.toolStateByCallId.clear();
      try {
        return {
          stopReason: await forwardTurn({
            client: ctx.client,
            daemon: await daemon(),
            session,
            signal: ctx.signal,
            pollIntervalMs,
          }),
        };
      } finally {
        session.activeInvocationId = undefined;
      }
    })
    .onNotification(methods.agent.session.cancel, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session?.activeInvocationId) return;
      const control = await daemon();
      await control.cancelTurn({
        invocationId: session.activeInvocationId,
        reason: "ACP client cancelled the active prompt turn.",
      });
    });

  return {
    app,
    sessions,
    async ready() {
      await daemon();
    },
    async close() {
      if (options.daemon) options.daemon.close();
      else (await daemonPromise)?.close();
      daemonPromise = undefined;
    },
  };
}

async function forwardTurn(input: {
  client: AgentContext;
  daemon: SparkAcpDaemon;
  session: SparkAcpSessionRecord;
  signal: AbortSignal;
  pollIntervalMs: number;
}): Promise<StopReason> {
  const invocationId = input.session.activeInvocationId;
  if (!invocationId) throw new Error("ACP prompt lost its active Spark invocation");
  while (true) {
    if (input.signal.aborted) {
      await input.daemon.cancelTurn({
        invocationId,
        reason: "ACP prompt request was aborted.",
      });
      return "cancelled";
    }
    const page = await input.daemon.streamTurn({
      invocationId,
      after: input.session.cursor,
    });
    for (const event of page.events) {
      await forwardEvent({
        client: input.client,
        daemon: input.daemon,
        session: input.session,
        invocationId,
        payload: event.payload,
      });
    }
    input.session.cursor = page.nextCursor;
    if (page.hasMore) continue;
    const status = await input.daemon.statusTurn({ invocationId });
    if (isTerminal(status.status)) {
      const result = await input.daemon.resultTurn({ invocationId });
      if (result.assistantText && !input.session.emittedAssistantText) {
        await emitTextDelta(input.client, input.session, "spark-result", result.assistantText);
      } else if (status.status === "failed" && result.error?.message) {
        await emitTextDelta(
          input.client,
          input.session,
          "spark-error",
          `Spark turn failed: ${result.error.message}`,
        );
      }
      return stopReason(status.status);
    }
    await sleep(input.pollIntervalMs, input.signal);
  }
}

async function forwardEvent(input: {
  client: AgentContext;
  daemon: SparkAcpDaemon;
  session: SparkAcpSessionRecord;
  invocationId: string;
  payload: unknown;
}): Promise<void> {
  const { client, daemon, session, invocationId } = input;
  const parsed = sparkDaemonEventSchema.safeParse(input.payload);
  if (!parsed.success) return;
  const event = parsed.data;
  if (event.type === "daemon.view_event") {
    await forwardViewEvent(client, session, event);
    return;
  }
  if (event.type !== "daemon.interaction.request") return;
  if (event.request.kind !== "toolApproval") {
    await notifyUpdate(client, session.sparkSessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: event.request.requestId,
      content: {
        type: "text",
        text: "Spark is waiting for this interaction to be answered in TUI or Hub.",
      },
    });
    return;
  }
  const request = event.request;
  const permission = await client.request(methods.client.session.requestPermission, {
    sessionId: session.sparkSessionId,
    toolCall: {
      toolCallId: request.toolCallId ?? request.requestId,
      title: request.title,
      kind: toolKind(request.toolName),
      status: "pending",
      rawInput: request.arguments,
    },
    options: [
      { optionId: "approve", name: request.approveLabel, kind: "allow_once" },
      { optionId: "reject", name: request.rejectLabel, kind: "reject_once" },
    ],
  });
  const selected = permission.outcome.outcome === "selected" ? permission.outcome.optionId : null;
  const cancelled = permission.outcome.outcome === "cancelled";
  const approved = selected === "approve";
  let answers: Record<string, unknown> = {};
  if (!cancelled) {
    const value = approved ? "approve" : "reject";
    const label = approved ? request.approveLabel : request.rejectLabel;
    answers = { approval: { values: [value], labels: [label] } };
  }
  await daemon.respondHuman({
    interactionRequestId: request.requestId,
    sessionId: session.sparkSessionId,
    invocationId,
    humanResponseId: createId("hres"),
    status: cancelled ? "cancelled" : "answered",
    answers,
    responseArtifactRefs: [],
  });
}

async function forwardViewEvent(
  client: AgentContext,
  session: SparkAcpSessionRecord,
  event: Extract<SparkDaemonEvent, { type: "daemon.view_event" }>,
): Promise<void> {
  const view = event.view;
  if (view.type !== "session.message" || view.message.role !== "assistant") return;
  await emitTextDelta(client, session, view.message.id, view.message.text);
  for (const part of view.message.parts ?? []) {
    if (part.type === "thinking" && part.text) {
      await emitThoughtDelta(client, session, part.id, part.text);
    } else if (part.type === "tool-call" && !session.toolStateByCallId.has(part.toolCallId)) {
      await notifyUpdate(client, session.sparkSessionId, {
        sessionUpdate: "tool_call",
        toolCallId: part.toolCallId,
        title: part.summary ?? part.toolName,
        kind: toolKind(part.toolName),
        status: "in_progress",
      });
      session.toolStateByCallId.set(part.toolCallId, "in_progress");
    } else if (
      part.type === "tool-result" &&
      session.toolStateByCallId.get(part.toolCallId) !== "completed"
    ) {
      await notifyUpdate(client, session.sparkSessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: part.toolCallId,
        title: part.summary ?? part.toolName,
        status: "completed",
        rawOutput: part.summary,
      });
      session.toolStateByCallId.set(part.toolCallId, "completed");
    }
  }
}

async function emitTextDelta(
  client: AgentContext,
  session: SparkAcpSessionRecord,
  messageId: string,
  text: string,
): Promise<void> {
  const key = `message:${messageId}`;
  const previous = session.textByMessageId.get(key) ?? "";
  const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
  session.textByMessageId.set(key, text);
  if (!delta) return;
  session.emittedAssistantText = true;
  await notifyUpdate(client, session.sparkSessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text: delta },
  });
}

async function emitThoughtDelta(
  client: AgentContext,
  session: SparkAcpSessionRecord,
  partId: string,
  text: string,
): Promise<void> {
  const key = `thought:${partId}`;
  const previous = session.textByMessageId.get(key) ?? "";
  const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
  session.textByMessageId.set(key, text);
  if (!delta) return;
  await notifyUpdate(client, session.sparkSessionId, {
    sessionUpdate: "agent_thought_chunk",
    messageId: partId,
    content: { type: "text", text: delta },
  });
}

async function notifyUpdate(
  client: AgentContext,
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  await client.notify(methods.client.session.update, { sessionId, update });
}

function strictPromptText(blocks: ReadonlyArray<{ type?: string; text?: string }>): string {
  if (!blocks.length) {
    throw RequestError.invalidParams(undefined, "ACP prompt must contain at least one text block");
  }
  if (blocks.some((block) => block.type !== "text" || typeof block.text !== "string")) {
    throw RequestError.invalidParams(
      undefined,
      "Spark ACP currently accepts text prompt blocks only",
    );
  }
  const text = blocks
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) throw RequestError.invalidParams(undefined, "ACP prompt text must not be empty");
  return text;
}

function isTerminal(status: SparkInvocationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function stopReason(status: SparkInvocationStatus): StopReason {
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "refusal";
  return "end_turn";
}

function toolKind(name: string): ToolKind {
  const lower = name.toLowerCase();
  if (lower.includes("read")) return "read";
  if (lower.includes("edit") || lower.includes("write")) return "edit";
  if (lower.includes("delete")) return "delete";
  if (lower.includes("search") || lower.includes("grep")) return "search";
  if (lower.includes("fetch") || lower.includes("web")) return "fetch";
  if (lower.includes("exec") || lower.includes("shell") || lower.includes("run")) return "execute";
  return "other";
}

async function createOrpcDaemon(): Promise<SparkAcpDaemon> {
  const handle = await createSparkDaemonOrpcClient();
  return orpcDaemon(handle);
}

function orpcDaemon(handle: SparkDaemonOrpcClientHandle): SparkAcpDaemon {
  const invoke = (method: Parameters<typeof invokeSparkDaemonOrpcLiveMethod>[1], params: unknown) =>
    invokeSparkDaemonOrpcLiveMethod(handle.client, method, params);
  return {
    async resolveWorkspace(input) {
      const resolution = await invoke("workspace.resolve-session-cwd", { cwd: input.cwd });
      if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
        throw new Error("Spark daemon returned an invalid workspace.resolve-session-cwd result");
      }
      const record = resolution as Record<string, unknown>;
      const workspace = record.workspace;
      const resolvedCwd = record.cwd;
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
        throw new Error("Spark daemon returned an invalid workspace.resolve-session-cwd result");
      }
      const id = (workspace as Record<string, unknown>).id;
      if (typeof id !== "string" || !id.trim() || typeof resolvedCwd !== "string") {
        throw new Error("Spark daemon returned an invalid workspace.resolve-session-cwd result");
      }
      const cwdArtifactRef = record.cwdArtifactRef;
      return {
        id: id.trim(),
        cwd: resolvedCwd,
        ...(typeof cwdArtifactRef === "string" ? { cwdArtifactRef } : {}),
      };
    },
    async createSession(input) {
      const session = parseSparkSessionRegistryRecord(
        await invoke("session.create", {
          scope: { kind: "workspace", workspaceId: input.workspaceId },
          workspaceId: input.workspaceId,
          cwd: input.cwd,
          ...(input.cwdArtifactRef ? { cwdArtifactRef: input.cwdArtifactRef } : {}),
          roleRef: "role:builtin-administrator",
          purpose: "acp_interactive",
          title: input.title,
        }),
      );
      return { sessionId: session.sessionId, createdAt: session.createdAt };
    },
    async submitTurn(input) {
      const result = sparkTurnSubmitResultSchema.parse(
        await invoke("turn.submit", {
          sessionId: input.sessionId,
          prompt: input.prompt,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      return { invocationId: result.invocationId };
    },
    async streamTurn(input) {
      return sparkTurnStreamPageSchema.parse(
        await invoke("turn.stream", { invocationId: input.invocationId, after: input.after }),
      );
    },
    async statusTurn(input) {
      return sparkTurnStatusResultSchema.parse(await invoke("turn.status", input));
    },
    async resultTurn(input) {
      return sparkTurnResultSchema.parse(await invoke("turn.result", input));
    },
    async cancelTurn(input) {
      sparkTurnCancelResultSchema.parse(await invoke("turn.cancel", input));
    },
    async respondHuman(input) {
      await invoke("human.interaction.respond", input);
    },
    close: () => handle.close(),
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
