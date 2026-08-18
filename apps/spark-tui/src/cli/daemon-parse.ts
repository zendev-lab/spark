/** `spark daemon ...` argv parsing with one Optique grammar per resource. */

import { object, or } from "@optique/core/constructs";
import { formatMessage, message } from "@optique/core/message";
import { map, multiple, optional, withDefault } from "@optique/core/modifiers";
import { parse } from "@optique/core/parser";
import { argument, command, constant, flag, option, passThrough } from "@optique/core/primitives";
import { string, type ValueParser } from "@optique/core/valueparser";
import { sparkDaemonCliStrings } from "@zendev-lab/spark-i18n/cli";
import { readSparkSessionExportFormat } from "../host/session-navigation.ts";
import { isRecord } from "./shared.ts";
import type { RoleRef } from "@zendev-lab/spark-core";
import { type SparkInvocationStatus, parseSparkModelValue } from "@zendev-lab/spark-protocol";
import type {
  SparkDaemonAskCommand,
  SparkDaemonChannelCommand,
  SparkDaemonCliCommand,
  SparkDaemonEventsCommand,
  SparkDaemonInvocationCommand,
  SparkDaemonModelCommand,
  SparkDaemonRunState,
  SparkDaemonRunsCommand,
  SparkDaemonSessionsCommand,
} from "./daemon-types.ts";

const STRINGS = sparkDaemonCliStrings();

const remainingArgv = () => passThrough({ format: "greedy" });
const helpFlag = () => withDefault(flag("-h", "--help"), false);
const jsonFlag = () => withDefault(flag("--json"), false);
const positionalArgs = () => multiple(argument(string()));
const helpRequestParser = object({
  help: helpFlag(),
  args: positionalArgs(),
  options: passThrough({ format: "nextToken" }),
});

const finiteNumber: ValueParser<"sync", number> = {
  mode: "sync",
  metavar: "NUMBER",
  placeholder: 0,
  parse(input) {
    const value = Number(input);
    return Number.isFinite(value)
      ? { success: true, value }
      : { success: false, error: message`Expected a finite number.` };
  },
  format: String,
};

function numberOption(name: `--${string}`) {
  return optional(
    option(name, finiteNumber, {
      errors: {
        endOfInput: [{ type: "text", text: `${name} requires a value` }],
        invalidValue: [{ type: "text", text: `${name} must be a number` }],
      },
    }),
  );
}

const statusParser = command(
  "status",
  map(
    object({ help: helpFlag(), json: jsonFlag(), args: positionalArgs() }),
    (value): SparkDaemonCliCommand =>
      value.help ? { action: "help" } : { action: "status", json: value.json },
  ),
);

const submitParser = command(
  "submit",
  map(
    object({
      help: helpFlag(),
      json: jsonFlag(),
      session: optional(option("-s", "--session", string())),
      prompt: optional(option("-p", "--prompt", string())),
      idempotencyKey: optional(option("--idempotency-key", string())),
      reset: withDefault(flag("--reset"), false),
      args: positionalArgs(),
    }),
    (value): SparkDaemonCliCommand => {
      if (value.help) return { action: "help" };
      const sessionId = value.session?.trim();
      const prompt = readPrompt(value.prompt, value.args);
      const idempotencyKey = value.idempotencyKey?.trim();
      if (!sessionId) throw new Error(STRINGS.submitRequiresSession);
      if (!prompt) throw new Error(STRINGS.submitRequiresPrompt);
      return {
        action: "submit",
        json: value.json,
        sessionId,
        prompt,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        reset: value.reset,
      };
    },
  ),
);

const invocationParser = command(
  "invocation",
  map(
    object({
      help: helpFlag(),
      json: jsonFlag(),
      status: optional(option("--status", string())),
      session: optional(option("-s", "--session", string())),
      since: optional(option("--since", string())),
      before: optional(option("--before", string())),
      limit: numberOption("--limit"),
      offset: numberOption("--offset"),
      eventLimit: numberOption("--event-limit"),
      confirm: withDefault(flag("--confirm"), false),
      invocation: optional(option("--invocation", string())),
      after: numberOption("--after"),
      reason: optional(option("--reason", string())),
      args: positionalArgs(),
    }),
    (value): SparkDaemonCliCommand =>
      value.help ? { action: "help" } : buildInvocationCommand(value),
  ),
);

const sessionsBody = map(
  object({
    help: helpFlag(),
    json: jsonFlag(),
    session: optional(option("-s", "--session", string())),
    workspace: optional(option("--workspace", string())),
    allWorkspaces: withDefault(flag("--all-workspaces"), false),
    history: withDefault(flag("--history"), false),
    registry: withDefault(flag("--registry"), false),
    includeArchived: withDefault(flag("--include-archived"), false),
    query: optional(option("--query", string())),
    tags: optional(option("--tags", string())),
    supervisor: optional(option("--supervisor", string())),
    roleRef: optional(option("--role-ref", string())),
    name: optional(option("--name", string())),
    cwd: optional(option("--cwd", string())),
    cwdArtifactRef: optional(option("--cwd-artifact-ref", string())),
    externalKey: optional(option("--external-key", string())),
    all: withDefault(flag("--all"), false),
    message: optional(option("--message", string())),
    format: optional(option("--format", string())),
    leaf: optional(option("--leaf", string())),
    args: positionalArgs(),
  }),
  (value): SparkDaemonCliCommand => (value.help ? { action: "help" } : buildSessionsCommand(value)),
);

const askBody = map(
  object({
    help: helpFlag(),
    json: jsonFlag(),
    session: optional(option("-s", "--session", string())),
    invocation: optional(option("--invocation", string())),
    interaction: optional(option("--interaction", string())),
    answers: optional(option("--answers", string())),
    answer: optional(option("--answer", string())),
    args: positionalArgs(),
  }),
  (value): SparkDaemonCliCommand => (value.help ? { action: "help" } : buildAskCommand(value)),
);

const channelBody = map(
  object({
    help: helpFlag(),
    json: jsonFlag(),
    workspace: optional(option("--workspace", string())),
    notifyAction: optional(option("--action", string())),
    route: optional(option("--route", string())),
    adapter: optional(option("--adapter", string())),
    recipient: optional(option("--recipient", string())),
    text: optional(option("--text", string())),
    imageUrl: optional(option("--image-url", string())),
    imageType: optional(option("--image-type", string())),
    args: positionalArgs(),
  }),
  (value): SparkDaemonCliCommand => (value.help ? { action: "help" } : buildChannelCommand(value)),
);

const runsBody = map(
  object({
    help: helpFlag(),
    json: jsonFlag(),
    state: optional(option("--state", string())),
    limit: numberOption("--limit"),
    run: optional(option("--run", string())),
    args: positionalArgs(),
  }),
  (value): SparkDaemonCliCommand => (value.help ? { action: "help" } : buildRunsCommand(value)),
);

const eventsParser = command(
  "events",
  map(
    object({
      help: helpFlag(),
      json: jsonFlag(),
      limit: numberOption("--limit"),
      args: positionalArgs(),
    }),
    (value): SparkDaemonCliCommand => (value.help ? { action: "help" } : buildEventsCommand(value)),
  ),
);

const modelParser = command(
  "model",
  map(
    object({
      help: helpFlag(),
      json: jsonFlag(),
      session: optional(option("-s", "--session", string())),
      useDefault: withDefault(flag("--default"), false),
      all: withDefault(flag("--all"), false),
      args: positionalArgs(),
    }),
    (value): SparkDaemonCliCommand => (value.help ? { action: "help" } : buildModelCommand(value)),
  ),
);

const startParser = command(
  "start",
  map(
    object({ help: helpFlag(), json: jsonFlag(), args: positionalArgs() }),
    (value): SparkDaemonCliCommand =>
      value.help ? { action: "help" } : { action: "start", json: value.json },
  ),
);

function serviceParser(name: string, daemonPrefix = false) {
  return command(
    name,
    map(object({ help: helpFlag(), argv: remainingArgv() }), (value): SparkDaemonCliCommand =>
      value.help
        ? { action: "help" }
        : {
            action: "service",
            argv: daemonPrefix ? ["daemon", name, ...value.argv] : [name, ...value.argv],
          },
    ),
  );
}

const sparkDaemonCommandParser = or(
  or(
    command("help", object({ action: constant("help" as const), argv: remainingArgv() })),
    command("--help", object({ action: constant("help" as const), argv: remainingArgv() })),
    command("-h", object({ action: constant("help" as const), argv: remainingArgv() })),
    statusParser,
    submitParser,
    invocationParser,
    command("queue", object({ action: constant("queue" as const), argv: remainingArgv() })),
  ),
  or(
    command("session", sessionsBody),
    command("sessions", sessionsBody),
    command("ask", askBody),
    command("human", askBody),
    command("channel", channelBody),
    command("channels", channelBody),
    command("run", runsBody),
    command("runs", runsBody),
  ),
  or(
    eventsParser,
    modelParser,
    startParser,
    serviceParser("stop"),
    serviceParser("install"),
    serviceParser("doctor"),
    serviceParser("login"),
    serviceParser("auth"),
    serviceParser("workspace"),
    serviceParser("ws"),
    serviceParser("uplink"),
    serviceParser("restart", true),
    serviceParser("logs", true),
  ),
  object({ action: constant("empty" as const) }),
);

const knownDaemonActions = new Set([
  "help",
  "--help",
  "-h",
  "status",
  "submit",
  "invocation",
  "queue",
  "session",
  "sessions",
  "ask",
  "human",
  "channel",
  "channels",
  "run",
  "runs",
  "events",
  "model",
  "start",
  "stop",
  "install",
  "doctor",
  "login",
  "auth",
  "workspace",
  "ws",
  "uplink",
  "restart",
  "logs",
]);

export function parseSparkDaemonCliArgs(argv: string[]): SparkDaemonCliCommand {
  const helpRequest = parse(helpRequestParser, argv);
  if (helpRequest.success && helpRequest.value.help) return { action: "help" };
  const result = parse(sparkDaemonCommandParser, argv);
  if (!result.success) {
    const action = argv[0] ?? "";
    if (!knownDaemonActions.has(action)) throw new Error(STRINGS.unknownCommand(action));
    if (action === "model") {
      const unknown = findUnknownModelOption(argv.slice(1));
      if (unknown) throw new Error(`unknown spark daemon model option: ${unknown}`);
    }
    throw new Error(formatMessage(result.error));
  }
  if (result.value.action === "empty") return { action: "service", argv: [] };
  if (result.value.action === "queue") throw new Error(STRINGS.unknownCommand("queue"));
  if (result.value.action === "help") return { action: "help" };
  return result.value;
}

function buildInvocationCommand(value: {
  json: boolean;
  status?: string;
  session?: string;
  since?: string;
  before?: string;
  limit?: number;
  offset?: number;
  eventLimit?: number;
  confirm: boolean;
  invocation?: string;
  after?: number;
  reason?: string;
  args: readonly string[];
}): SparkDaemonInvocationCommand {
  const [subcommand = "list", positionalInvocationId] = value.args;
  if (subcommand === "list") {
    return {
      action: "invocation",
      subcommand,
      json: value.json,
      status: readInvocationStatus(value.status),
      sessionId: value.session?.trim(),
      since: readInvocationSince(value.since),
      limit: value.limit,
      offset: value.offset,
    };
  }
  if (subcommand === "retention") {
    const retentionAction = positionalInvocationId ?? "preview";
    if (retentionAction !== "preview" && retentionAction !== "apply") {
      throw new Error(`unknown spark daemon invocation retention command: ${retentionAction}`);
    }
    const before = readIsoDateTime(value.before, "before");
    if (!before) throw new Error("spark daemon invocation retention requires --before <iso>");
    if (retentionAction === "apply" && !value.confirm) {
      throw new Error("spark daemon invocation retention apply requires --confirm");
    }
    return {
      action: "invocation",
      subcommand,
      before,
      limit: value.limit,
      json: value.json,
      ...(retentionAction === "apply"
        ? { retentionAction, eventLimit: value.eventLimit, confirm: true }
        : {}),
    };
  }
  if (
    subcommand !== "status" &&
    subcommand !== "result" &&
    subcommand !== "stream" &&
    subcommand !== "cancel" &&
    subcommand !== "retry"
  ) {
    throw new Error(`unknown spark daemon invocation command: ${subcommand}`);
  }
  const invocationId = value.invocation?.trim() || positionalInvocationId?.trim();
  if (!invocationId) {
    throw new Error(`spark daemon invocation ${subcommand} requires <invocation-id>`);
  }
  return {
    action: "invocation",
    subcommand,
    invocationId,
    json: value.json,
    ...(subcommand === "stream" ? { after: value.after, limit: value.limit } : {}),
    ...(subcommand === "cancel" ? { reason: value.reason?.trim() } : {}),
  };
}

function buildSessionsCommand(value: {
  json: boolean;
  session?: string;
  workspace?: string;
  allWorkspaces: boolean;
  history: boolean;
  registry: boolean;
  includeArchived: boolean;
  query?: string;
  tags?: string;
  supervisor?: string;
  roleRef?: string;
  name?: string;
  cwd?: string;
  cwdArtifactRef?: string;
  externalKey?: string;
  all: boolean;
  message?: string;
  format?: string;
  leaf?: string;
  args: readonly string[];
}): SparkDaemonSessionsCommand {
  const [subcommand = "list", maybeLeaf] = value.args;
  if (subcommand === "list") {
    const query = value.query?.trim();
    const tags = value.tags
      ?.split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    return {
      action: "sessions",
      subcommand,
      json: value.json,
      allWorkspaces: value.allWorkspaces,
      history: value.history || value.allWorkspaces,
      registry: value.registry,
      includeArchived: value.includeArchived,
      ...(query ? { query } : {}),
      ...(tags?.length ? { tags } : {}),
      workspaceId: value.workspace?.trim(),
    };
  }
  if (subcommand === "spawn" || subcommand === "fork") {
    if (maybeLeaf?.trim()) {
      throw new Error(
        `spark daemon session ${subcommand} does not accept a source Session argument`,
      );
    }
    const supervisorSessionId = value.supervisor?.trim();
    if (!supervisorSessionId) {
      throw new Error(`spark daemon session ${subcommand} requires --supervisor <session-id>`);
    }
    const rawRoleRef = value.roleRef?.trim();
    if (!rawRoleRef) {
      throw new Error(`spark daemon session ${subcommand} requires --role-ref <RoleRef>`);
    }
    if (!rawRoleRef.startsWith("role:")) {
      throw new Error(`spark daemon session ${subcommand} --role-ref must start with role:`);
    }
    return {
      action: "sessions",
      subcommand,
      json: value.json,
      name: value.name?.trim(),
      roleRef: rawRoleRef as RoleRef,
      supervisorSessionId,
      cwd: value.cwd?.trim(),
      cwdArtifactRef: value.cwdArtifactRef?.trim(),
    };
  }
  if (subcommand === "bind" || subcommand === "unbind") {
    const sessionId = value.session?.trim() || maybeLeaf?.trim();
    const externalKey = value.externalKey?.trim();
    if (!sessionId) throw new Error(`spark daemon session ${subcommand} requires <session-id>`);
    if (!externalKey)
      throw new Error(`spark daemon session ${subcommand} requires --external-key <key>`);
    return { action: "sessions", subcommand, json: value.json, sessionId, externalKey };
  }
  if (subcommand === "archive" || subcommand === "restore" || subcommand === "close") {
    const sessionId = value.session?.trim() || maybeLeaf?.trim();
    if (!sessionId) throw new Error(`spark daemon session ${subcommand} requires <session-id>`);
    return { action: "sessions", subcommand, json: value.json, sessionId };
  }
  if (subcommand === "inbox") {
    const [inboxActionOrMessageId, maybeMessageId] = value.args.slice(1);
    const inboxAction =
      inboxActionOrMessageId === "read" || inboxActionOrMessageId === "ack"
        ? inboxActionOrMessageId
        : "list";
    const sessionId = value.session?.trim();
    if (!sessionId) throw new Error("spark daemon session inbox requires --session <session-id>");
    return {
      action: "sessions",
      subcommand,
      json: value.json,
      sessionId,
      inboxAction,
      all: value.all,
      ...(inboxAction === "list"
        ? {}
        : { messageId: maybeMessageId?.trim() || value.message?.trim() }),
    };
  }
  if (subcommand === "show" || subcommand === "tree") {
    const sessionId = value.session?.trim() || maybeLeaf?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsReplayRequiresSession);
    return {
      action: "sessions",
      subcommand,
      json: value.json,
      sessionId,
    };
  }
  if (subcommand === "export") {
    const sessionId = value.session?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsExportRequiresSession);
    const format = readSparkSessionExportFormat(value.format ?? "jsonl");
    const leafId = readDaemonLeafArg(value.leaf ?? maybeLeaf);
    return {
      action: "sessions",
      subcommand,
      json: value.json,
      sessionId,
      format,
      ...(leafId !== undefined ? { leafId } : {}),
    };
  }
  if (subcommand === "replay") {
    const sessionId = value.session?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsReplayRequiresSession);
    const leafId = readDaemonLeafArg(value.leaf ?? maybeLeaf);
    return {
      action: "sessions",
      subcommand,
      json: value.json,
      sessionId,
      ...(leafId !== undefined ? { leafId } : {}),
    };
  }
  throw new Error(STRINGS.unknownSessionsCommand(subcommand));
}

function buildAskCommand(value: {
  json: boolean;
  session?: string;
  invocation?: string;
  interaction?: string;
  answers?: string;
  answer?: string;
  args: readonly string[];
}): SparkDaemonAskCommand {
  const [subcommand = "list", positionalInteractionRequestId] = value.args;
  if (subcommand === "list") {
    return { action: "ask", subcommand, json: value.json, sessionId: value.session?.trim() };
  }
  if (subcommand !== "answer" && subcommand !== "cancel") {
    throw new Error(`unknown spark daemon ask command: ${subcommand}`);
  }
  const interactionRequestId = value.interaction?.trim() || positionalInteractionRequestId?.trim();
  if (!interactionRequestId) {
    throw new Error(`spark daemon ask ${subcommand} requires <interaction-request-id>`);
  }
  if (subcommand === "cancel") {
    return {
      action: "ask",
      subcommand,
      json: value.json,
      interactionRequestId,
      sessionId: value.session?.trim(),
      invocationId: value.invocation?.trim(),
    };
  }
  const rawAnswers = value.answers ?? value.answer;
  if (!rawAnswers) throw new Error("spark daemon ask answer requires --answers <json>");
  let parsedAnswers: unknown;
  try {
    parsedAnswers = JSON.parse(rawAnswers);
  } catch (error) {
    throw new Error("spark daemon ask answer requires valid JSON in --answers", { cause: error });
  }
  if (!isRecord(parsedAnswers)) {
    throw new Error("spark daemon ask answer requires a JSON object in --answers");
  }
  return {
    action: "ask",
    subcommand,
    json: value.json,
    interactionRequestId,
    sessionId: value.session?.trim(),
    invocationId: value.invocation?.trim(),
    answers: parsedAnswers,
  };
}

function buildChannelCommand(value: {
  json: boolean;
  workspace?: string;
  notifyAction?: string;
  route?: string;
  adapter?: string;
  recipient?: string;
  text?: string;
  imageUrl?: string;
  imageType?: string;
  args: readonly string[];
}): SparkDaemonChannelCommand {
  const [subcommand = "status"] = value.args;
  const workspaceId = value.workspace?.trim();
  if (subcommand === "list" || subcommand === "status" || subcommand === "reload") {
    if (!workspaceId) {
      throw new Error(`spark daemon channel ${subcommand} requires --workspace <workspaceId>`);
    }
    return { action: "channel", subcommand, json: value.json, workspaceId };
  }
  if (subcommand !== "notify") {
    throw new Error(`unknown spark daemon channel command: ${subcommand}`);
  }
  const notifyAction = value.notifyAction ?? "test";
  if (notifyAction !== "test" && notifyAction !== "send") {
    throw new Error("spark daemon channel notify --action must be test or send");
  }
  if (!workspaceId) {
    throw new Error("spark daemon channel notify requires --workspace <workspaceId>");
  }
  return {
    action: "channel",
    subcommand,
    json: value.json,
    workspaceId,
    notifyAction,
    ...(value.route ? { route: value.route } : {}),
    ...(value.adapter ? { adapter: value.adapter } : {}),
    ...(value.recipient ? { recipient: value.recipient } : {}),
    ...(value.text ? { text: value.text } : {}),
    ...(value.imageUrl ? { imageUrl: value.imageUrl } : {}),
    ...(value.imageType ? { imageType: value.imageType } : {}),
  };
}

function buildRunsCommand(value: {
  json: boolean;
  state?: string;
  limit?: number;
  run?: string;
  args: readonly string[];
}): SparkDaemonRunsCommand {
  const [subcommand = "list", maybeRunId] = value.args;
  if (subcommand === "list") {
    return {
      action: "runs",
      subcommand,
      json: value.json,
      state: readRunState(value.state ?? "all"),
      limit: value.limit,
    };
  }
  if (subcommand === "show" || subcommand === "cancel") {
    const runId = value.run?.trim() || maybeRunId?.trim();
    if (!runId) throw new Error(`${subcommand} requires --run <id> or a run id argument`);
    return { action: "runs", subcommand, json: value.json, runId };
  }
  throw new Error(`unknown daemon run command: ${subcommand}`);
}

function buildEventsCommand(value: {
  json: boolean;
  limit?: number;
  args: readonly string[];
}): SparkDaemonEventsCommand {
  const [subcommand = "watch"] = value.args;
  if (subcommand !== "watch") throw new Error(`unknown daemon events command: ${subcommand}`);
  return { action: "events", subcommand, json: value.json, limit: value.limit };
}

function buildModelCommand(value: {
  json: boolean;
  session?: string;
  useDefault: boolean;
  all: boolean;
  args: readonly string[];
}): SparkDaemonModelCommand {
  const valuedFlag = value.args.find((arg) => /^--(?:all|default)=/u.test(arg));
  if (valuedFlag) throw new Error(`${valuedFlag.split("=", 1)[0]} does not accept a value`);
  const [subcommand = "list", modelValue, ...extraPositionals] = value.args;
  const sessionId = value.session?.trim();
  if (subcommand === "list") {
    if (modelValue || extraPositionals.length > 0 || sessionId || value.useDefault) {
      throw new Error("Usage: spark daemon model list [--all] [--json]");
    }
    return { action: "model", subcommand, json: value.json, all: value.all };
  }
  if (subcommand === "status") {
    if (modelValue || extraPositionals.length > 0 || value.all || value.useDefault) {
      throw new Error("Usage: spark daemon model status [--session <id>] [--json]");
    }
    return { action: "model", subcommand, json: value.json, ...(sessionId ? { sessionId } : {}) };
  }
  if (subcommand === "set") {
    if (!modelValue || extraPositionals.length > 0 || value.all) {
      throw new Error(
        "Usage: spark daemon model set <provider/model> (--session <id>|--default) [--json]",
      );
    }
    if (Boolean(sessionId) === value.useDefault) {
      throw new Error("spark daemon model set requires exactly one of --session <id> or --default");
    }
    return {
      action: "model",
      subcommand,
      json: value.json,
      model: parseSparkModelValue(modelValue),
      target: value.useDefault ? "default" : "session",
      ...(sessionId ? { sessionId } : {}),
    };
  }
  throw new Error(`unknown spark daemon model command: ${subcommand}`);
}

function findUnknownModelOption(argv: readonly string[]): string | undefined {
  const known = new Set(["-h", "--help", "--json", "-s", "--session", "--all", "--default"]);
  for (const arg of argv) {
    if (arg === "--") return undefined;
    if (!arg.startsWith("-")) continue;
    const name = arg.split("=", 1)[0]!;
    if (!known.has(name)) return name;
  }
  return undefined;
}

function readInvocationStatus(value: string | undefined): SparkInvocationStatus | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (
    normalized === "queued" ||
    normalized === "running" ||
    normalized === "succeeded" ||
    normalized === "failed" ||
    normalized === "cancelled"
  ) {
    return normalized;
  }
  throw new Error(
    "spark daemon invocation --status must be queued, running, succeeded, failed, or cancelled",
  );
}

function readInvocationSince(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const relative = normalized.match(/^(\d+)(s|m|h|d)$/iu);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      relative[2]!.toLowerCase() as "s" | "m" | "h" | "d"
    ];
    const durationMs = amount * unitMs;
    if (amount < 1 || !Number.isSafeInteger(durationMs) || durationMs > 365 * 86_400_000) {
      throw new Error("spark daemon invocation --since duration must be between 1s and 365d");
    }
    return new Date(Date.now() - durationMs).toISOString();
  }
  return readIsoDateTime(normalized, "since");
}

function readIsoDateTime(value: string | undefined, name: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`spark daemon invocation --${name} must be an ISO date-time`);
  }
  return new Date(normalized).toISOString();
}

export function sparkDaemonHelpText(): string {
  return STRINGS.helpText;
}

function readPrompt(fromOption: string | undefined, positionals: readonly string[]) {
  const text = fromOption ?? positionals.join(" ");
  return text.trim() || undefined;
}

function readDaemonLeafArg(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === "all") return undefined;
  return raw === "root" ? null : raw;
}

function readRunState(raw: string): SparkDaemonRunState {
  if (
    raw === "queued" ||
    raw === "running" ||
    raw === "succeeded" ||
    raw === "failed" ||
    raw === "cancelled" ||
    raw === "all"
  ) {
    return raw;
  }
  throw new Error(`invalid daemon run state: ${raw}`);
}
