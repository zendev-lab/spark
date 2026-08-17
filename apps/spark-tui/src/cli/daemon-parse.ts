/** `spark daemon ...` argv parsing: command constructors and option readers. */

import { sparkDaemonCliStrings } from "@zendev-lab/spark-i18n/cli";
import { readSparkSessionExportFormat } from "../host/session-navigation.ts";
import {
  helpFlagRequested,
  isRecord,
  parseSparkCliOptions,
  readBooleanOption,
  readNumberOption,
  readStringOption,
} from "./shared.ts";
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

export function parseSparkDaemonCliArgs(argv: string[]): SparkDaemonCliCommand {
  if (argv.length === 0) {
    return { action: "service", argv: [] };
  }

  const [action, ...rest] = argv;
  if (action === "help" || action === "--help" || action === "-h") {
    return { action: "help" };
  }
  if (helpFlagRequested(argv)) {
    return { action: "help" };
  }

  const parsed = parseSparkCliOptions(rest);
  const json = readBooleanOption(parsed.options, "json");

  switch (action) {
    case "status":
      return { action: "status", json };
    case "submit": {
      const sessionId = readStringOption(parsed.options, "session")?.trim();
      const prompt = readPrompt(parsed);
      const idempotencyKey = readStringOption(parsed.options, "idempotency-key")?.trim();
      if (!sessionId) throw new Error(STRINGS.submitRequiresSession);
      if (!prompt) throw new Error(STRINGS.submitRequiresPrompt);
      return {
        action: "submit",
        json,
        sessionId,
        prompt,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        reset: readBooleanOption(parsed.options, "reset"),
      };
    }
    case "invocation":
      return parseSparkDaemonInvocationCommand(parsed, json);
    case "queue":
      throw new Error(STRINGS.unknownCommand("queue"));
    case "session":
    case "sessions":
      return parseSparkDaemonSessionsCommand(parsed, json);
    case "ask":
    case "human":
      return parseSparkDaemonAskCommand(parsed, json);
    case "channel":
    case "channels":
      return parseSparkDaemonChannelCommand(parsed, json);
    case "run":
    case "runs":
      return parseSparkDaemonRunsCommand(parsed, json);
    case "events":
      return parseSparkDaemonEventsCommand(parsed, json);
    case "model":
      return parseSparkDaemonModelCommand(parsed, json);
    case "start":
      return { action: "start", json };
    case "stop":
    case "install":
    case "doctor":
    case "login":
    case "auth":
    case "workspace":
    case "ws":
    case "uplink":
      return { action: "service", argv };
    case "restart":
    case "logs":
      return { action: "service", argv: ["daemon", ...argv] };
    default:
      throw new Error(STRINGS.unknownCommand(String(action)));
  }
}

function parseSparkDaemonModelCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonModelCommand {
  const [subcommand = "list", modelValue, ...extraPositionals] = parsed.positionals;
  const sessionId = readStringOption(parsed.options, "session")?.trim();
  if (subcommand === "list") {
    assertOnlyModelOptions(parsed.options, ["all", "json"]);
    if (modelValue || extraPositionals.length > 0 || sessionId) {
      throw new Error("Usage: spark daemon model list [--all] [--json]");
    }
    assertBooleanModelOption(parsed.options, "all");
    return {
      action: "model",
      subcommand,
      json,
      all: readBooleanOption(parsed.options, "all"),
    };
  }
  if (subcommand === "status") {
    assertOnlyModelOptions(parsed.options, ["session", "json"]);
    if (modelValue || extraPositionals.length > 0) {
      throw new Error("Usage: spark daemon model status [--session <id>] [--json]");
    }
    return { action: "model", subcommand, json, ...(sessionId ? { sessionId } : {}) };
  }
  if (subcommand === "set") {
    assertOnlyModelOptions(parsed.options, ["session", "default", "json"]);
    assertBooleanModelOption(parsed.options, "default");
    if (!modelValue || extraPositionals.length > 0) {
      throw new Error(
        "Usage: spark daemon model set <provider/model> (--session <id>|--default) [--json]",
      );
    }
    const useDefault = readBooleanOption(parsed.options, "default");
    if (Boolean(sessionId) === useDefault) {
      throw new Error("spark daemon model set requires exactly one of --session <id> or --default");
    }
    return {
      action: "model",
      subcommand,
      json,
      model: parseSparkModelValue(modelValue),
      target: useDefault ? "default" : "session",
      ...(sessionId ? { sessionId } : {}),
    };
  }
  throw new Error(`unknown spark daemon model command: ${subcommand}`);
}

function assertOnlyModelOptions(
  options: Record<string, string | boolean>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(options).find((name) => !allowed.includes(name));
  if (unknown) throw new Error(`unknown spark daemon model option: --${unknown}`);
}

function assertBooleanModelOption(options: Record<string, string | boolean>, name: string): void {
  if (typeof options[name] === "string") {
    throw new Error(`--${name} does not accept a value`);
  }
}

function parseSparkDaemonInvocationCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonInvocationCommand {
  const [subcommand = "list", positionalInvocationId] = parsed.positionals;
  if (subcommand === "list") {
    return {
      action: "invocation",
      subcommand,
      json,
      status: readInvocationStatus(readStringOption(parsed.options, "status")),
      sessionId: readStringOption(parsed.options, "session")?.trim(),
      since: readInvocationSinceOption(parsed.options),
      limit: readNumberOption(parsed.options, "limit"),
      offset: readNumberOption(parsed.options, "offset"),
    };
  }
  if (subcommand === "retention") {
    const retentionAction = positionalInvocationId ?? "preview";
    if (retentionAction !== "preview" && retentionAction !== "apply") {
      throw new Error(`unknown spark daemon invocation retention command: ${retentionAction}`);
    }
    const before = readIsoDateTimeOption(parsed.options, "before");
    if (!before) throw new Error("spark daemon invocation retention requires --before <iso>");
    if (retentionAction === "apply" && !readBooleanOption(parsed.options, "confirm")) {
      throw new Error("spark daemon invocation retention apply requires --confirm");
    }
    return {
      action: "invocation",
      subcommand,
      before,
      limit: readNumberOption(parsed.options, "limit"),
      json,
      ...(retentionAction === "apply"
        ? {
            retentionAction,
            eventLimit: readNumberOption(parsed.options, "event-limit"),
            confirm: true,
          }
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
  const invocationId =
    readStringOption(parsed.options, "invocation")?.trim() || positionalInvocationId?.trim();
  if (!invocationId) {
    throw new Error(`spark daemon invocation ${subcommand} requires <invocation-id>`);
  }
  return {
    action: "invocation",
    subcommand,
    invocationId,
    json,
    ...(subcommand === "stream"
      ? {
          after: readNumberOption(parsed.options, "after"),
          limit: readNumberOption(parsed.options, "limit"),
        }
      : {}),
    ...(subcommand === "cancel"
      ? { reason: readStringOption(parsed.options, "reason")?.trim() }
      : {}),
  };
}

function parseSparkDaemonChannelCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonChannelCommand {
  const [subcommand = "status"] = parsed.positionals;
  if (subcommand === "list" || subcommand === "status" || subcommand === "reload") {
    const workspaceId = readStringOption(parsed.options, "workspace")?.trim();
    if (!workspaceId) {
      throw new Error(`spark daemon channel ${subcommand} requires --workspace <workspaceId>`);
    }
    return { action: "channel", subcommand, json, workspaceId };
  }
  if (subcommand !== "notify") {
    throw new Error(`unknown spark daemon channel command: ${subcommand}`);
  }
  const notifyAction = readStringOption(parsed.options, "action") ?? "test";
  if (notifyAction !== "test" && notifyAction !== "send") {
    throw new Error("spark daemon channel notify --action must be test or send");
  }
  const workspaceId = readStringOption(parsed.options, "workspace")?.trim();
  if (!workspaceId) {
    throw new Error("spark daemon channel notify requires --workspace <workspaceId>");
  }
  const optional = (name: string, key: string) => {
    const value = readStringOption(parsed.options, name);
    return value ? { [key]: value } : {};
  };
  return {
    action: "channel",
    subcommand: "notify",
    json,
    workspaceId,
    notifyAction,
    ...optional("route", "route"),
    ...optional("adapter", "adapter"),
    ...optional("recipient", "recipient"),
    ...optional("text", "text"),
    ...optional("image-url", "imageUrl"),
    ...optional("image-type", "imageType"),
  };
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

function readInvocationSinceOption(
  options: ReturnType<typeof parseSparkCliOptions>["options"],
): string | undefined {
  const value = readStringOption(options, "since")?.trim();
  if (!value) return undefined;
  const relative = value.match(/^(\d+)(s|m|h|d)$/iu);
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
  return readIsoDateTimeOption(options, "since");
}

function readIsoDateTimeOption(
  options: ReturnType<typeof parseSparkCliOptions>["options"],
  name: string,
): string | undefined {
  const value = readStringOption(options, name)?.trim();
  if (!value) return undefined;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`spark daemon invocation --${name} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
}

function parseSparkDaemonSessionsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonSessionsCommand {
  const [subcommand = "list", maybeLeaf] = parsed.positionals;
  if (subcommand === "list") {
    const allWorkspaces = readBooleanOption(parsed.options, "all-workspaces");
    const query = readStringOption(parsed.options, "query")?.trim();
    const tagList = readStringOption(parsed.options, "tags")
      ?.split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    return {
      action: "sessions",
      subcommand,
      json,
      allWorkspaces,
      history: readBooleanOption(parsed.options, "history") || allWorkspaces,
      registry: readBooleanOption(parsed.options, "registry"),
      includeArchived: readBooleanOption(parsed.options, "include-archived"),
      ...(query ? { query } : {}),
      ...(tagList?.length ? { tags: tagList } : {}),
      workspaceId: readStringOption(parsed.options, "workspace")?.trim(),
    };
  }
  if (subcommand === "create") {
    const workspaceId = readStringOption(parsed.options, "workspace")?.trim() || maybeLeaf?.trim();
    if (!workspaceId) throw new Error("spark daemon session create requires --workspace <id>");
    const supervisorSessionId = readStringOption(parsed.options, "supervisor")?.trim();
    if (!supervisorSessionId) {
      throw new Error("spark daemon session create requires --supervisor <session-id>");
    }
    const rawRoleRef = readStringOption(parsed.options, "role-ref")?.trim();
    if (rawRoleRef && !rawRoleRef.startsWith("role:")) {
      throw new Error("spark daemon session create --role-ref must start with role:");
    }
    const inheritRole = readBooleanOption(parsed.options, "inherit-role");
    if (rawRoleRef && inheritRole) {
      throw new Error(
        "spark daemon session create accepts only one of --role-ref and --inherit-role",
      );
    }
    const rawPlacement = readStringOption(parsed.options, "placement")?.trim() ?? "child";
    if (rawPlacement !== "child" && rawPlacement !== "sibling") {
      throw new Error("spark daemon session create --placement must be child or sibling");
    }
    return {
      action: "sessions",
      subcommand,
      json,
      workspaceId,
      name: readStringOption(parsed.options, "name")?.trim(),
      ...(rawRoleRef ? { roleRef: rawRoleRef as RoleRef } : {}),
      inheritRole,
      placement: rawPlacement,
      supervisorSessionId,
      sessionId: readStringOption(parsed.options, "id")?.trim(),
    };
  }
  if (subcommand === "bind" || subcommand === "unbind") {
    const sessionId = readStringOption(parsed.options, "session")?.trim() || maybeLeaf?.trim();
    const externalKey = readStringOption(parsed.options, "external-key")?.trim();
    if (!sessionId) throw new Error(`spark daemon session ${subcommand} requires <session-id>`);
    if (!externalKey)
      throw new Error(`spark daemon session ${subcommand} requires --external-key <key>`);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      externalKey,
    };
  }
  if (subcommand === "archive" || subcommand === "restore" || subcommand === "close") {
    const sessionId = readStringOption(parsed.options, "session")?.trim() || maybeLeaf?.trim();
    if (!sessionId) throw new Error(`spark daemon session ${subcommand} requires <session-id>`);
    return { action: "sessions", subcommand, json, sessionId };
  }
  if (subcommand === "inbox") {
    const [inboxActionOrMessageId, maybeMessageId] = parsed.positionals.slice(1);
    const inboxAction =
      inboxActionOrMessageId === "read" || inboxActionOrMessageId === "ack"
        ? inboxActionOrMessageId
        : "list";
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error("spark daemon session inbox requires --session <session-id>");
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      inboxAction,
      all: readBooleanOption(parsed.options, "all"),
      ...(inboxAction === "list"
        ? {}
        : {
            messageId:
              maybeMessageId?.trim() || readStringOption(parsed.options, "message")?.trim(),
          }),
    };
  }
  if (
    subcommand === "show" ||
    subcommand === "tree" ||
    subcommand === "fork" ||
    subcommand === "clone"
  ) {
    const sessionId = readStringOption(parsed.options, "session")?.trim() || maybeLeaf?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsReplayRequiresSession);
    const newSessionId = readStringOption(parsed.options, "id")?.trim();
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      ...(newSessionId ? { newSessionId } : {}),
    };
  }
  if (subcommand === "export") {
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsExportRequiresSession);
    const format = readSparkSessionExportFormat(
      readStringOption(parsed.options, "format") ?? "jsonl",
    );
    const leafId = readDaemonLeafArg(readStringOption(parsed.options, "leaf") ?? maybeLeaf);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      format,
      ...(leafId !== undefined ? { leafId } : {}),
    };
  }
  if (subcommand === "replay") {
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsReplayRequiresSession);
    const leafId = readDaemonLeafArg(readStringOption(parsed.options, "leaf") ?? maybeLeaf);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      ...(leafId !== undefined ? { leafId } : {}),
    };
  }
  throw new Error(STRINGS.unknownSessionsCommand(subcommand));
}

function parseSparkDaemonRunsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonRunsCommand {
  const [subcommand = "list", maybeRunId] = parsed.positionals;
  if (subcommand === "list") {
    const state = readRunState(readStringOption(parsed.options, "state") ?? "all");
    const limit = readNumberOption(parsed.options, "limit");
    return { action: "runs", subcommand, json, state, limit };
  }
  if (subcommand === "show" || subcommand === "cancel") {
    const runId = readStringOption(parsed.options, "run")?.trim() || maybeRunId?.trim();
    if (!runId) throw new Error(`${subcommand} requires --run <id> or a run id argument`);
    return { action: "runs", subcommand, json, runId };
  }
  throw new Error(`unknown daemon run command: ${subcommand}`);
}

function parseSparkDaemonAskCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonAskCommand {
  const [subcommand = "list", positionalInteractionRequestId] = parsed.positionals;
  if (subcommand === "list") {
    return {
      action: "ask",
      subcommand,
      json,
      sessionId: readStringOption(parsed.options, "session")?.trim(),
    };
  }
  if (subcommand !== "answer" && subcommand !== "cancel") {
    throw new Error(`unknown spark daemon ask command: ${subcommand}`);
  }
  const interactionRequestId =
    readStringOption(parsed.options, "interaction")?.trim() ||
    positionalInteractionRequestId?.trim();
  if (!interactionRequestId) {
    throw new Error(`spark daemon ask ${subcommand} requires <interaction-request-id>`);
  }
  if (subcommand === "cancel") {
    return {
      action: "ask",
      subcommand,
      json,
      interactionRequestId,
      sessionId: readStringOption(parsed.options, "session")?.trim(),
      invocationId: readStringOption(parsed.options, "invocation")?.trim(),
    };
  }
  const rawAnswers =
    readStringOption(parsed.options, "answers") ?? readStringOption(parsed.options, "answer");
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
    json,
    interactionRequestId,
    sessionId: readStringOption(parsed.options, "session")?.trim(),
    invocationId: readStringOption(parsed.options, "invocation")?.trim(),
    answers: parsedAnswers,
  };
}

function parseSparkDaemonEventsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonEventsCommand {
  const [subcommand = "watch"] = parsed.positionals;
  if (subcommand !== "watch") throw new Error(`unknown daemon events command: ${subcommand}`);
  return { action: "events", subcommand, json, limit: readNumberOption(parsed.options, "limit") };
}

export function sparkDaemonHelpText(): string {
  return STRINGS.helpText;
}

function readPrompt(parsed: ReturnType<typeof parseSparkCliOptions>): string | undefined {
  const fromOption = readStringOption(parsed.options, "prompt");
  const text = fromOption ?? parsed.positionals.join(" ");
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
