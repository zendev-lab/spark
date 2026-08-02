import {
  parseSparkModelValue,
  sparkModelValue,
  type SparkInvocationStatus,
  type SparkModelControlSnapshot,
} from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";

import { localRpcRequest } from "./local-rpc/client.js";
import type { CliIo } from "./cli-shared.ts";

type ControlCommand =
  | "model"
  | "invocation"
  | "session"
  | "sessions"
  | "channel"
  | "channels"
  | "run"
  | "runs"
  | "events";

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
    command === "events"
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
  return writeResult(io, result, flag(parsed, "json"));
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
    case "create": {
      const workspaceId = option(parsed, "workspace") ?? sessionArgument;
      if (!workspaceId) throw new Error("spark daemon session create requires --workspace <id>");
      result = await localRpcRequest(paths, "session.create", {
        scope: { kind: "workspace", workspaceId },
        workspaceId,
        cwd: process.cwd(),
        ...(option(parsed, "id") ? { sessionId: option(parsed, "id") } : {}),
        ...(option(parsed, "title") ? { title: option(parsed, "title") } : {}),
        ...(option(parsed, "role") ? { role: option(parsed, "role") } : {}),
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
      throw new Error(
        `unknown spark daemon session command: ${action}; history tree/fork/export/replay remain TUI-local views`,
      );
  }
  return writeResult(io, result, flag(parsed, "json"));
}

async function channelCommand(paths: SparkPaths, parsed: ParsedArgs, io: CliIo): Promise<number> {
  const [action = "status"] = parsed.positionals;
  const workspaceId = option(parsed, "workspace");
  if (!workspaceId) throw new Error(`spark daemon channel ${action} requires --workspace <id>`);
  let result: unknown;
  if (action === "status" || action === "list") {
    result = await localRpcRequest(paths, "channel.status", { workspaceId });
  } else if (action === "reload") {
    result = await localRpcRequest(paths, "channel.reload", { workspaceId });
  } else if (action === "notify") {
    const notifyAction = option(parsed, "action") ?? "test";
    if (notifyAction !== "test" && notifyAction !== "send") {
      throw new Error("spark daemon channel notify --action must be test or send");
    }
    result = await localRpcRequest(paths, "channel.notify", {
      workspaceId,
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
  return writeResult(io, result, flag(parsed, "json"));
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
    return writeResult(io, result, flag(parsed, "json"));
  }
  const invocationId = option(parsed, "run") ?? runId;
  if (!invocationId) throw new Error(`spark daemon run ${action} requires <run-id>`);
  if (action === "show") {
    return writeResult(
      io,
      await localRpcRequest(paths, "turn.status", { invocationId }),
      flag(parsed, "json"),
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

const BOOLEAN_OPTIONS = new Set(["all", "default", "include-archived", "json"]);

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

function writeResult(io: CliIo, value: unknown, json: boolean): number {
  if (json) return writeJson(io, value);
  if (isRecord(value) && typeof value.text === "string") io.stdout.write(value.text);
  else io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
