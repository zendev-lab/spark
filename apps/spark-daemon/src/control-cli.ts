import { readFile } from "node:fs/promises";
import { parseChannelsConfig } from "@zendev-lab/dsh-channel-transports";
import {
  parseSparkModelValue,
  sparkModelValue,
  type SparkInvocationStatus,
  type SparkModelControlSnapshot,
} from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-platform-node";

import { localRpcRequest } from "./local-rpc/client.js";
import { padColumn, shortTimestamp, truncateColumn, yesNo, type CliIo } from "./cli-shared.ts";
import { isRecord } from "./local-rpc/is-record.ts";

type ControlCommand =
  | "model"
  | "invocation"
  | "session"
  | "sessions"
  | "channel"
  | "channels"
  | "run"
  | "runs"
  | "events"
  | "access";

interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | true>;
}

export function isSparkDaemonControlCommand(
  command: string | undefined,
): command is ControlCommand {
  return (
    command === "model" ||
    command === "invocation" ||
    command === "session" ||
    command === "sessions" ||
    command === "channel" ||
    command === "channels" ||
    command === "run" ||
    command === "runs" ||
    command === "events" ||
    command === "access"
  );
}

export async function runSparkDaemonControlCommand(
  paths: SparkPaths,
  command: ControlCommand,
  argv: string[],
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs(argv);
  switch (command) {
    case "model":
      return await modelCommand(paths, parsed, io);
    case "invocation":
      return await invocationCommand(paths, parsed, io);
    case "session":
    case "sessions":
      return await sessionCommand(paths, parsed, io);
    case "channel":
    case "channels":
      return await channelCommand(paths, parsed, io);
    case "run":
    case "runs":
      return await runCommand(paths, parsed, io);
    case "events":
      return eventsCommand(parsed, io);
    case "access":
      return await accessCommand(paths, parsed, io);
  }
}

async function modelCommand(paths: SparkPaths, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const [action = "list", modelValue, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new Error(`unknown spark daemon model argument: ${extra[0]}`);
  const sessionId = option(parsed, "session");
  if (action === "set") {
    if (!modelValue) {
      throw new Error(
        "Usage: spark daemon model set <provider/model> (--session <id>|--default) [--json]",
      );
    }
    const useDefault = flag(parsed, "default");
    if (Boolean(sessionId) === useDefault) {
      throw new Error("spark daemon model set requires exactly one of --session <id> or --default");
    }
    const model = parseSparkModelValue(modelValue);
    if (useDefault) await localRpcRequest(paths, "model.default.set", { model });
    else await localRpcRequest(paths, "session.model.set", { sessionId: sessionId!, model });
  } else if (action !== "list" && action !== "status") {
    throw new Error(`unknown spark daemon model command: ${action}`);
  }

  const snapshot = await localRpcRequest(paths, "model.catalog", sessionId ? { sessionId } : {});
  if (flag(parsed, "json")) return writeJson(io, snapshot);
  if (action === "list") {
    const models = snapshot.providers
      .flatMap((provider) => provider.models)
      .filter((entry) => flag(parsed, "all") || entry.available);
    io.stdout.write(
      models.length === 0
        ? "No matching Spark models.\n"
        : `${models.map((entry) => formatModel(entry, snapshot)).join("\n")}\n`,
    );
    return 0;
  }
  const selected = snapshot.session?.model ?? snapshot.defaultModel;
  const scope = snapshot.session ? `session ${snapshot.session.sessionId}` : "default";
  io.stdout.write(
    selected ? `${scope}: ${sparkModelValue(selected)}\n` : `${scope}: no model selected\n`,
  );
  return 0;
}

function formatModel(
  entry: SparkModelControlSnapshot["providers"][number]["models"][number],
  snapshot: SparkModelControlSnapshot,
): string {
  const selected = snapshot.session?.model ?? snapshot.defaultModel;
  const marker =
    selected?.providerName === entry.model.providerName && selected.modelId === entry.model.modelId
      ? "*"
      : " ";
  const availability = entry.available
    ? "available"
    : `unavailable: ${entry.unavailableReason ?? "authentication required"}`;
  return `${marker} ${sparkModelValue(entry.model)}  ${availability}`;
}

async function invocationCommand(
  paths: SparkPaths,
  parsed: ParsedArgs,
  io: CliIo,
): Promise<number> {
  const [action = "list", invocationArgument] = parsed.positionals;
  let result: unknown;
  if (action === "list") {
    result = await localRpcRequest(paths, "invocation.list", {
      ...(option(parsed, "status") ? { status: invocationStatus(option(parsed, "status")!) } : {}),
      ...(option(parsed, "session") ? { sessionId: option(parsed, "session")! } : {}),
      ...(option(parsed, "since") ? { since: invocationSince(option(parsed, "since")!) } : {}),
      ...(numberOption(parsed, "limit") !== undefined
        ? { limit: numberOption(parsed, "limit") }
        : {}),
      ...(numberOption(parsed, "offset") !== undefined
        ? { offset: numberOption(parsed, "offset") }
        : {}),
    });
  } else if (action === "retention") {
    result = await localRpcRequest(paths, "invocation.retention.preview", {
      before: isoDateOption(parsed, "before"),
      ...(numberOption(parsed, "limit") !== undefined
        ? { limit: numberOption(parsed, "limit") }
        : {}),
    });
  } else {
    const invocationId = option(parsed, "invocation") ?? invocationArgument;
    if (!invocationId) {
      throw new Error(`spark daemon invocation ${action} requires <invocation-id>`);
    }
    switch (action) {
      case "status":
        result = await localRpcRequest(paths, "turn.status", { invocationId });
        break;
      case "result":
        result = await localRpcRequest(paths, "turn.result", { invocationId });
        break;
      case "stream":
        result = await localRpcRequest(paths, "turn.stream", {
          invocationId,
          ...(numberOption(parsed, "after") !== undefined
            ? { after: numberOption(parsed, "after") }
            : {}),
          ...(numberOption(parsed, "limit") !== undefined
            ? { limit: numberOption(parsed, "limit") }
            : {}),
        });
        break;
      case "cancel":
        result = await localRpcRequest(paths, "turn.cancel", {
          invocationId,
          ...(option(parsed, "reason") ? { reason: option(parsed, "reason") } : {}),
        });
        break;
      case "retry":
        result = await localRpcRequest(paths, "invocation.retry", { invocationId });
        break;
      default:
        throw new Error(`unknown spark daemon invocation command: ${action}`);
    }
  }
  return writeResult(io, result, flag(parsed, "json"), renderInvocationValue);
}

async function sessionCommand(paths: SparkPaths, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const [action = "list", sessionArgument, inboxMessageId] = parsed.positionals;
  let result: unknown;
  switch (action) {
    case "list":
      result = await localRpcRequest(paths, "session.list", {
        ...(option(parsed, "workspace")
          ? { scope: { kind: "workspace" as const, workspaceId: option(parsed, "workspace")! } }
          : {}),
        ...(flag(parsed, "include-archived") ? { includeArchived: true } : {}),
        ...(numberOption(parsed, "limit") !== undefined
          ? { limit: numberOption(parsed, "limit") }
          : {}),
      });
      break;
    case "show": {
      const sessionId = option(parsed, "session") ?? sessionArgument;
      if (!sessionId) throw new Error("spark daemon session show requires <session-id>");
      result = await localRpcRequest(paths, "session.get", { sessionId });
      break;
    }
    case "spawn":
    case "fork": {
      if (sessionArgument) {
        throw new Error(`spark daemon session ${action} does not accept a source Session argument`);
      }
      const supervisorSessionId = option(parsed, "supervisor");
      if (!supervisorSessionId) {
        throw new Error(`spark daemon session ${action} requires --supervisor <session-id>`);
      }
      const roleRef = option(parsed, "role-ref");
      if (!roleRef) {
        throw new Error(`spark daemon session ${action} requires --role-ref <RoleRef>`);
      }
      if (!roleRef.startsWith("role:")) {
        throw new Error(`spark daemon session ${action} --role-ref must start with role:`);
      }
      result = await localRpcRequest(paths, `session.${action}`, {
        supervisorSessionId,
        roleRef,
        ...(option(parsed, "name") ? { name: option(parsed, "name") } : {}),
        ...(option(parsed, "cwd") ? { cwd: option(parsed, "cwd") } : {}),
        ...(option(parsed, "cwd-artifact-ref")
          ? { cwdArtifactRef: option(parsed, "cwd-artifact-ref") }
          : {}),
      });
      break;
    }
    case "bind":
    case "unbind": {
      const sessionId = option(parsed, "session") ?? sessionArgument;
      const externalKey = option(parsed, "external-key");
      if (!sessionId || !externalKey) {
        throw new Error(
          `spark daemon session ${action} requires <session-id> --external-key <key>`,
        );
      }
      result = await localRpcRequest(paths, `session.${action}`, { sessionId, externalKey });
      break;
    }
    case "archive": {
      const sessionId = option(parsed, "session") ?? sessionArgument;
      if (!sessionId) throw new Error("spark daemon session archive requires <session-id>");
      result = await localRpcRequest(paths, "session.archive", { sessionId });
      break;
    }
    case "restore":
    case "close": {
      const sessionId = option(parsed, "session") ?? sessionArgument;
      if (!sessionId) throw new Error(`spark daemon session ${action} requires <session-id>`);
      result = await localRpcRequest(paths, `session.${action}`, { sessionId });
      break;
    }
    case "inbox": {
      const inboxAction =
        sessionArgument === "read" || sessionArgument === "ack" ? sessionArgument : "list";
      const sessionId = option(parsed, "session");
      if (!sessionId) throw new Error("spark daemon session inbox requires --session <session-id>");
      if (inboxAction === "list") {
        result = await localRpcRequest(paths, "session.inbox", {
          sessionId,
          includeAcked: flag(parsed, "all"),
        });
      } else {
        const messageId = inboxMessageId ?? option(parsed, "message");
        if (!messageId) {
          throw new Error(`spark daemon session inbox ${inboxAction} requires <message-id>`);
        }
        result = await localRpcRequest(paths, `session.mail.${inboxAction}`, {
          sessionId,
          messageId,
        });
      }
      break;
    }
    default:
      throw new Error(`unknown spark daemon session command: ${action}`);
  }
  return writeResult(io, result, flag(parsed, "json"), renderSessionValue);
}

async function channelCommand(paths: SparkPaths, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const [action = "status"] = parsed.positionals;
  let result: unknown;
  if (action === "status" || action === "list") {
    result = await localRpcRequest(paths, "channel.status", {});
  } else if (action === "configure") {
    const configFile = option(parsed, "file") ?? parsed.positionals[1];
    if (!configFile) {
      throw new Error("Usage: spark daemon channel configure --file <channels.json> [--json]");
    }
    let config;
    try {
      config = parseChannelsConfig(JSON.parse(await readFile(configFile, "utf8")));
    } catch (error) {
      throw new Error(`Cannot read Channel configuration from ${configFile}.`, { cause: error });
    }
    result = await localRpcRequest(paths, "channel.configure", { config });
  } else if (action === "reload") {
    result = await localRpcRequest(paths, "channel.reload", {});
  } else if (action === "notify") {
    const notifyAction = option(parsed, "action") ?? "test";
    if (notifyAction !== "test" && notifyAction !== "send") {
      throw new Error("spark daemon channel notify --action must be test or send");
    }
    result = await localRpcRequest(paths, "channel.notify", {
      action: notifyAction,
      ...(option(parsed, "route") ? { route: option(parsed, "route") } : {}),
      ...(option(parsed, "adapter") ? { adapter: option(parsed, "adapter") } : {}),
      ...(option(parsed, "recipient") ? { recipient: option(parsed, "recipient") } : {}),
      ...(option(parsed, "text") ? { text: option(parsed, "text") } : {}),
      ...(option(parsed, "image-url")
        ? {
            image: {
              url: option(parsed, "image-url"),
              ...(option(parsed, "image-type") ? { mediaType: option(parsed, "image-type") } : {}),
            },
          }
        : {}),
    });
  } else {
    throw new Error(`unknown spark daemon channel command: ${action}`);
  }
  return writeResult(io, result, flag(parsed, "json"), renderChannelValue);
}

async function runCommand(paths: SparkPaths, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const [action = "list", runId] = parsed.positionals;
  if (action === "list") {
    const state = option(parsed, "state");
    const result = await localRpcRequest(paths, "invocation.list", {
      ...(state && state !== "all" ? { status: invocationStatus(state) } : {}),
      ...(numberOption(parsed, "limit") !== undefined
        ? { limit: numberOption(parsed, "limit") }
        : {}),
    });
    return writeResult(io, result, flag(parsed, "json"), renderInvocationValue);
  }
  const invocationId = option(parsed, "run") ?? runId;
  if (!invocationId) throw new Error(`spark daemon run ${action} requires <run-id>`);
  if (action === "show") {
    return writeResult(
      io,
      await localRpcRequest(paths, "turn.status", { invocationId }),
      flag(parsed, "json"),
      renderInvocationValue,
    );
  }
  if (action === "cancel") {
    return writeResult(
      io,
      await localRpcRequest(paths, "turn.cancel", {
        invocationId,
        reason: "spark daemon run cancel",
      }),
      flag(parsed, "json"),
      renderInvocationValue,
    );
  }
  throw new Error(`unknown spark daemon run command: ${action}`);
}

function eventsCommand(parsed: ParsedArgs, io: CliIo): number {
  const [action = "watch"] = parsed.positionals;
  if (action !== "watch") throw new Error(`unknown spark daemon events command: ${action}`);
  const result = {
    plane: "daemon",
    resource: "events",
    events: [],
    text: "Use spark daemon invocation stream <invocation-id> for durable event streams.\n",
  };
  return writeResult(io, result, flag(parsed, "json"));
}

/**
 * Manage the daemon-owned `daemon-user` tokens that authenticate direct
 * browser surfaces on every listener. Plaintext appears once at creation; the
 * daemon persists only hashes.
 */
async function accessCommand(paths: SparkPaths, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const [action = "list", tokenId] = parsed.positionals;
  if (action === "create") {
    const label = option(parsed, "label");
    const expiresAt = option(parsed, "expires-at");
    const result = await localRpcRequest(paths, "daemon.access.create", {
      ...(label ? { label } : {}),
      ...(expiresAt ? { expiresAt: isoAccessDate(expiresAt) } : {}),
    });
    if (flag(parsed, "json")) return writeJson(io, result);
    io.stdout.write(
      `token:   ${result.token}\n` +
        `id:      ${result.record.id}\n` +
        `created: ${result.record.createdAt}\n` +
        (result.record.expiresAt ? `expires: ${result.record.expiresAt}\n` : "") +
        (result.record.label ? `label:   ${result.record.label}\n` : "") +
        "Store the token now; Spark never prints it again.\n",
    );
    return 0;
  }
  if (action === "list") {
    const result = await localRpcRequest(paths, "daemon.access.list", {});
    if (flag(parsed, "json")) return writeJson(io, result);
    if (result.tokens.length === 0) {
      io.stdout.write("No daemon access tokens.\n");
      return 0;
    }
    const lines = result.tokens.map((token) =>
      [
        padColumn(truncateColumn(token.id, 38), 40),
        padColumn(token.revokedAt ? "revoked" : tokenState(token.expiresAt), 9),
        padColumn(truncateColumn(token.label ?? "-", 24), 26),
        shortTimestamp(token.createdAt),
      ].join(""),
    );
    lines.push(`${result.tokens.length} token(s)`);
    io.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }
  if (action === "revoke") {
    const id = option(parsed, "token") ?? tokenId;
    if (!id) throw new Error("spark daemon access revoke requires <token-id>");
    const result = await localRpcRequest(paths, "daemon.access.revoke", { id });
    if (flag(parsed, "json")) return writeJson(io, result);
    io.stdout.write(
      result.revoked
        ? `revoked daemon access token ${result.id}\n`
        : `no daemon access token ${result.id}\n`,
    );
    return 0;
  }
  throw new Error(`unknown spark daemon access command: ${action}`);
}

function tokenState(expiresAt: string | undefined): string {
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return "expired";
  return "active";
}

function isoAccessDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("spark daemon access create --expires-at must be an ISO date-time");
  }
  return new Date(value).toISOString();
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const inline = argument.indexOf("=");
    if (inline > 2) {
      options[argument.slice(2, inline)] = argument.slice(inline + 1);
      continue;
    }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (!BOOLEAN_OPTIONS.has(name) && next && !next.startsWith("--")) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { positionals, options };
}

const BOOLEAN_OPTIONS = new Set(["all", "default", "include-archived", "inherit-role", "json"]);

function option(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name} requires a value`);
  return value.trim() || undefined;
}

function flag(parsed: ParsedArgs, name: string): boolean {
  const value = parsed.options[name];
  if (value === undefined) return false;
  if (value !== true) throw new Error(`--${name} does not accept a value`);
  return true;
}

function numberOption(parsed: ParsedArgs, name: string): number | undefined {
  const value = option(parsed, name);
  if (value === undefined) return undefined;
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsedValue;
}

function invocationStatus(value: string): SparkInvocationStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error(`unknown Spark invocation status: ${value}`);
}

function invocationSince(value: string): string {
  const relative = /^(\d+)([hd])$/u.exec(value);
  if (!relative) return isoDate(value, "--since");
  const count = Number(relative[1]);
  const unitMs = relative[2] === "h" ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
  if (count < 1 || count * unitMs > 365 * 24 * 60 * 60 * 1_000) {
    throw new Error("spark daemon invocation --since must be between 1h and 365d");
  }
  return new Date(Date.now() - count * unitMs).toISOString();
}

function isoDateOption(parsed: ParsedArgs, name: string): string {
  const value = option(parsed, name);
  if (!value) throw new Error(`spark daemon invocation retention requires --${name} <iso>`);
  return isoDate(value, `--${name}`);
}

function isoDate(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`spark daemon invocation ${label} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
}

function writeJson(io: CliIo, value: unknown): number {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

function writeResult(
  io: CliIo,
  value: unknown,
  json: boolean,
  render?: (value: Record<string, unknown>) => string | undefined,
): number {
  if (json) return writeJson(io, value);
  if (isRecord(value) && typeof value.text === "string") {
    io.stdout.write(value.text);
    return 0;
  }
  const rendered = render && isRecord(value) ? render(value) : undefined;
  if (rendered !== undefined) {
    io.stdout.write(rendered);
    return 0;
  }
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

function recordArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => isRecord(entry)) ? value : undefined;
}

function text(value: unknown, fallback = "-"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function countText(value: unknown, fallback: number | string = 0): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return String(fallback);
}

function errorLine(value: Record<string, unknown>): string | undefined {
  return isRecord(value.error) && typeof value.error.message === "string"
    ? `error: ${typeof value.error.code === "string" ? `${value.error.code}: ` : ""}${value.error.message}`
    : undefined;
}

function renderSessionValue(value: Record<string, unknown>): string | undefined {
  const sessions = recordArray(value.sessions);
  if (sessions) return renderSessionList(sessions, value.hasMore === true);
  if (isRecord(value.session)) return renderSessionDetail(value.session);
  const messages = recordArray(value.messages);
  if (messages) return renderInboxList(messages);
  if (isRecord(value.message)) return renderMailMessage(value.message);
  return undefined;
}

function renderSessionList(sessions: Record<string, unknown>[], hasMore: boolean): string {
  if (sessions.length === 0) return "No sessions.\n";
  const lines = sessions.map((session) =>
    [
      padColumn(truncateColumn(text(session.sessionId), 26), 28),
      padColumn(text(session.activity), 9),
      padColumn(text(session.lifecycle), 9),
      padColumn(truncateColumn(text(session.name), 24), 26),
      shortTimestamp(session.updatedAt),
    ].join(""),
  );
  lines.push(`${sessions.length} session(s)${hasMore ? " (more available)" : ""}`);
  return `${lines.join("\n")}\n`;
}

function renderSessionDetail(session: Record<string, unknown>): string {
  const lines = [`session: ${text(session.sessionId)}`];
  if (typeof session.name === "string") lines.push(`name: ${session.name}`);
  if (isRecord(session.scope)) {
    const scope = [text(session.scope.kind), text(session.scope.workspaceId, "")]
      .filter((part) => part !== "-")
      .join(" ");
    lines.push(`scope: ${scope}`);
  }
  lines.push(`lifecycle: ${text(session.lifecycle)}`);
  lines.push(`placement: ${text(session.placement)}`);
  lines.push(`activity: ${text(session.activity)}`);
  if (isRecord(session.roleBinding)) {
    const role =
      session.roleBinding.kind === "explicit" && typeof session.roleBinding.roleRef === "string"
        ? session.roleBinding.roleRef
        : text(session.roleBinding.kind);
    lines.push(`role: ${role}`);
  }
  if (typeof session.purpose === "string") lines.push(`purpose: ${session.purpose}`);
  if (isRecord(session.model)) {
    lines.push(`model: ${text(session.model.providerName)}/${text(session.model.modelId)}`);
  }
  if (typeof session.thinkingLevel === "string") lines.push(`thinking: ${session.thinkingLevel}`);
  if (typeof session.cwd === "string") lines.push(`cwd: ${session.cwd}`);
  if (Array.isArray(session.bindings)) lines.push(`bindings: ${session.bindings.length}`);
  lines.push(`created: ${text(session.createdAt)}`);
  lines.push(`updated: ${text(session.updatedAt)}`);
  return `${lines.join("\n")}\n`;
}

function renderInboxList(messages: Record<string, unknown>[]): string {
  if (messages.length === 0) return "Inbox is empty.\n";
  const lines = messages.map((message) => {
    const state = message.ackedAt ? "acked" : message.readAt ? "read" : "new";
    return [
      padColumn(truncateColumn(text(message.id), 22), 24),
      padColumn(text(message.kind), 14),
      padColumn(truncateColumn(`from ${text(message.fromSessionId)}`, 28), 30),
      padColumn(truncateColumn(text(message.subject ?? message.intent), 28), 30),
      `${shortTimestamp(message.createdAt)}  ${state}`,
    ].join("");
  });
  lines.push(`${messages.length} message(s)`);
  return `${lines.join("\n")}\n`;
}

function renderMailMessage(message: Record<string, unknown>): string {
  const lines = [
    `message: ${text(message.id)}`,
    `from: ${text(message.fromSessionId)}`,
    `kind: ${text(message.kind)}`,
    `intent: ${text(message.intent)}`,
  ];
  if (typeof message.subject === "string" && message.subject.length > 0) {
    lines.push(`subject: ${message.subject}`);
  }
  lines.push(`created: ${text(message.createdAt)}`);
  if (typeof message.ackedAt === "string") lines.push(`acked: ${message.ackedAt}`);
  else if (typeof message.readAt === "string") lines.push(`read: ${message.readAt}`);
  if (typeof message.body === "string" && message.body.length > 0) {
    lines.push("", message.body.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

function renderInvocationValue(value: Record<string, unknown>): string | undefined {
  const invocations = recordArray(value.invocations);
  if (invocations) return renderInvocationList(invocations, value);
  if (Array.isArray(value.invocationIds)) return renderRetentionPreview(value);
  if (typeof value.invocationId !== "string") return undefined;
  if (Array.isArray(value.events)) return renderTurnStream(value);
  if (typeof value.eventCursor === "number") return renderTurnStatus(value);
  if (typeof value.cancelRequested === "boolean") {
    return `invocation ${value.invocationId}: ${text(value.status)}${value.cancelRequested ? " (cancel requested)" : ""}\n`;
  }
  if (typeof value.acceptedAt === "string" && typeof value.retryOfInvocationId === "string") {
    return `queued retry of ${value.retryOfInvocationId} as ${value.invocationId}\n`;
  }
  return renderTurnResult(value);
}

function renderInvocationList(
  invocations: Record<string, unknown>[],
  page: Record<string, unknown>,
): string {
  if (invocations.length === 0) return "No invocations.\n";
  const lines = invocations.map((invocation) =>
    [
      padColumn(truncateColumn(text(invocation.invocationId), 30), 32),
      padColumn(text(invocation.status), 11),
      padColumn(truncateColumn(text(invocation.sessionId), 26), 28),
      padColumn(countText(invocation.attemptCount, 1), 3),
      shortTimestamp(invocation.updatedAt),
    ].join(""),
  );
  const offset = typeof page.offset === "number" ? page.offset : 0;
  const total = typeof page.total === "number" ? page.total : invocations.length;
  lines.push(`showing ${offset + 1}\u2013${offset + invocations.length} of ${total}`);
  return `${lines.join("\n")}\n`;
}

function renderTurnStatus(value: Record<string, unknown>): string {
  const lines = [`invocation: ${text(value.invocationId)}`, `status: ${text(value.status)}`];
  if (typeof value.sessionId === "string") lines.push(`session: ${value.sessionId}`);
  if (typeof value.cancelReason === "string") lines.push(`cancel reason: ${value.cancelReason}`);
  const error = errorLine(value);
  if (error) lines.push(error);
  lines.push(
    [
      `created: ${shortTimestamp(value.createdAt)}`,
      `started: ${shortTimestamp(value.startedAt)}`,
      `finished: ${shortTimestamp(value.finishedAt)}`,
    ].join("  "),
  );
  return `${lines.join("\n")}\n`;
}

function renderTurnResult(value: Record<string, unknown>): string {
  const lines = [`invocation: ${text(value.invocationId)}`, `status: ${text(value.status)}`];
  const error = errorLine(value);
  if (error) lines.push(error);
  if (typeof value.assistantText === "string" && value.assistantText.trim().length > 0) {
    lines.push("", value.assistantText.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

function renderTurnStream(value: Record<string, unknown>): string {
  const events = (value.events as Record<string, unknown>[]).map((event) =>
    [
      padColumn(countText(event.sequence, "-"), 5),
      padColumn(truncateColumn(text(event.kind), 32), 34),
      shortTimestamp(event.createdAt),
    ].join(""),
  );
  if (events.length === 0) events.push("(no new events)");
  events.push(
    `cursor: ${countText(value.nextCursor)}${value.hasMore === true ? " (more available)" : ""}`,
  );
  return `${events.join("\n")}\n`;
}

function renderRetentionPreview(value: Record<string, unknown>): string {
  return (
    `retention preview before ${text(value.before)}: ${(value.invocationIds as unknown[]).length} invocation(s), ` +
    `${countText(value.eventCount)} event(s), ${countText(value.blockedByDeliveryCount)} blocked by delivery\n`
  );
}

function renderChannelValue(value: Record<string, unknown>): string | undefined {
  if (isRecord(value.snapshot)) return renderChannelSnapshot(value.snapshot);
  if (value.action === "send" || value.action === "test") {
    const delivery = isRecord(value.delivery) ? value.delivery : undefined;
    const statusText = text(delivery?.status, "sent");
    const error =
      delivery && typeof delivery.error === "string" && delivery.error.length > 0
        ? ` — ${delivery.error}`
        : "";
    return `channel ${value.action} via ${text(value.adapter)} → ${text(value.recipient)}: ${statusText}${error}\n`;
  }
  if (value.action === "list") {
    const adapters = recordArray(value.adapters) ?? [];
    const routes = recordArray(value.routes) ?? [];
    return `${adapters.length} adapter(s), ${routes.length} route(s)\n`;
  }
  return undefined;
}

function renderChannelSnapshot(snapshot: Record<string, unknown>): string {
  const lines = [
    `daemon channels: configured ${yesNo(snapshot.configured)}, ingress ${snapshot.ingressEnabled === true ? "on" : "off"}, state ${text(snapshot.state)}`,
  ];
  for (const adapter of recordArray(snapshot.adapters) ?? []) {
    lines.push(
      `  ${text(adapter.id)} (${text(adapter.type)}): ${adapter.running === true ? "running" : "stopped"}${typeof adapter.state === "string" && adapter.state.length > 0 ? ` — ${adapter.state}` : ""}${typeof adapter.error === "string" ? " — error" : ""}`,
    );
  }
  if (Array.isArray(snapshot.routes)) lines.push(`routes: ${snapshot.routes.length}`);
  if (typeof snapshot.lastReloadedAt === "string") {
    lines.push(`last reloaded: ${shortTimestamp(snapshot.lastReloadedAt)}`);
  }
  if (typeof snapshot.error === "string") lines.push(`error: ${snapshot.error}`);
  return `${lines.join("\n")}\n`;
}
