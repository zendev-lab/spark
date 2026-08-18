import { object, or } from "@optique/core/constructs";
import { formatMessage, message } from "@optique/core/message";
import { map, optional, withDefault } from "@optique/core/modifiers";
import { parse } from "@optique/core/parser";
import { argument, command, constant, flag, option, passThrough } from "@optique/core/primitives";
import { string, type ValueParser } from "@optique/core/valueparser";
import {
  cancelHubWorkspaceDelegation,
  createHubWorkspaceDelegation,
  listHubWorkspaceDelegationMessages,
  listHubWorkspaceDelegations,
  listHubWorkspaces,
  loadHubStatus,
  replyHubWorkspaceDelegation,
  requireHubWorkspaceDelegation,
} from "@zendev-lab/spark-hub-coordination";
import { migrate, openDatabase } from "@zendev-lab/spark-hub-db";
import { createId, wireIdempotencyKey } from "@zendev-lab/spark-protocol";
import {
  consoleSparkCliErrorOutput,
  consoleSparkCliOutput,
  printSparkCliResult,
  type SparkCliOutput,
} from "../../cli/shared.ts";
import { parseSparkHubCliArgs, runSparkHubCliCommand } from "../../cli/coordination.ts";

interface HubDatabaseCliCommand {
  resource: "help" | "status" | "workspace" | "delegation";
  verb?: "list" | "create" | "show" | "reply" | "cancel";
  selector?: string;
  json?: boolean;
  databasePath?: string;
  workspace?: string;
  limit?: number;
  actor?: string;
  source?: string;
  target?: string;
  goal?: string;
  constraints?: string;
  role?: string;
  idempotencyKey?: string;
  text?: string;
  reason?: string;
}

const remainingArgv = () => passThrough({ format: "greedy" });
const helpFlag = () => withDefault(flag("-h", "--help"), false);
const jsonFlag = () => withDefault(flag("--json"), false);
const databaseOption = () => optional(option("--database", string()));

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

const databaseStatusParser = command(
  "status",
  map(
    object({ help: helpFlag(), json: jsonFlag(), database: databaseOption() }),
    (value): HubDatabaseCliCommand =>
      value.help
        ? { resource: "help" }
        : {
            resource: "status",
            json: value.json,
            databasePath: value.database?.trim(),
          },
  ),
);

const databaseWorkspaceListOptions = () =>
  object({ help: helpFlag(), json: jsonFlag(), database: databaseOption() });

const databaseWorkspaceParser = command(
  "workspace",
  or(
    command(
      "list",
      map(databaseWorkspaceListOptions(), (value): HubDatabaseCliCommand =>
        value.help
          ? { resource: "help" }
          : {
              resource: "workspace",
              verb: "list",
              json: value.json,
              databasePath: value.database?.trim(),
            },
      ),
    ),
    map(databaseWorkspaceListOptions(), (value): HubDatabaseCliCommand =>
      value.help
        ? { resource: "help" }
        : {
            resource: "workspace",
            verb: "list",
            json: value.json,
            databasePath: value.database?.trim(),
          },
    ),
  ),
);

const delegationListOptions = () =>
  object({
    help: helpFlag(),
    json: jsonFlag(),
    database: databaseOption(),
    workspace: optional(option("--workspace", string())),
    limit: optional(
      option("--limit", finiteNumber, {
        errors: {
          endOfInput: message`--limit requires a value`,
          invalidValue: message`--limit must be a number`,
        },
      }),
    ),
  });

function parseDelegationListValue(value: {
  help: boolean;
  json: boolean;
  database?: string;
  workspace?: string;
  limit?: number;
}): HubDatabaseCliCommand {
  return value.help
    ? { resource: "help" }
    : {
        resource: "delegation",
        verb: "list",
        json: value.json,
        databasePath: value.database?.trim(),
        workspace: value.workspace?.trim(),
        limit: value.limit,
      };
}

const delegationParser = command(
  "delegation",
  or(
    command(
      "create",
      map(
        object({
          help: helpFlag(),
          json: jsonFlag(),
          database: databaseOption(),
          actor: optional(option("--actor", string())),
          source: optional(option("--source", string())),
          target: optional(option("--target", string())),
          goal: optional(option("--goal", string())),
          constraints: optional(option("--constraints", string())),
          role: optional(option("--role", string())),
          idempotencyKey: optional(option("--idempotency-key", string())),
        }),
        (value): HubDatabaseCliCommand =>
          value.help
            ? { resource: "help" }
            : {
                resource: "delegation",
                verb: "create",
                json: value.json,
                databasePath: value.database?.trim(),
                actor: value.actor?.trim(),
                source: value.source?.trim(),
                target: value.target?.trim(),
                goal: value.goal?.trim(),
                constraints: value.constraints,
                role: value.role?.trim(),
                idempotencyKey: value.idempotencyKey?.trim(),
              },
      ),
    ),
    command("list", map(delegationListOptions(), parseDelegationListValue)),
    command(
      "show",
      map(
        object({
          help: helpFlag(),
          json: jsonFlag(),
          database: databaseOption(),
          selector: optional(argument(string())),
        }),
        (value): HubDatabaseCliCommand =>
          value.help
            ? { resource: "help" }
            : {
                resource: "delegation",
                verb: "show",
                selector: value.selector,
                json: value.json,
                databasePath: value.database?.trim(),
              },
      ),
    ),
    command(
      "reply",
      map(
        object({
          help: helpFlag(),
          json: jsonFlag(),
          database: databaseOption(),
          actor: optional(option("--actor", string())),
          text: optional(option("--text", string())),
          selector: optional(argument(string())),
        }),
        (value): HubDatabaseCliCommand =>
          value.help
            ? { resource: "help" }
            : {
                resource: "delegation",
                verb: "reply",
                selector: value.selector,
                json: value.json,
                databasePath: value.database?.trim(),
                actor: value.actor?.trim(),
                text: value.text?.trim(),
              },
      ),
    ),
    command(
      "cancel",
      map(
        object({
          help: helpFlag(),
          json: jsonFlag(),
          database: databaseOption(),
          actor: optional(option("--actor", string())),
          reason: optional(option("--reason", string())),
          selector: optional(argument(string())),
        }),
        (value): HubDatabaseCliCommand =>
          value.help
            ? { resource: "help" }
            : {
                resource: "delegation",
                verb: "cancel",
                selector: value.selector,
                json: value.json,
                databasePath: value.database?.trim(),
                actor: value.actor?.trim(),
                reason: value.reason?.trim(),
              },
      ),
    ),
    map(delegationListOptions(), parseDelegationListValue),
  ),
);

const hubDatabaseCliParser = or(
  command("help", object({ resource: constant("help" as const), argv: remainingArgv() })),
  command("--help", object({ resource: constant("help" as const), argv: remainingArgv() })),
  command("-h", object({ resource: constant("help" as const), argv: remainingArgv() })),
  databaseStatusParser,
  databaseWorkspaceParser,
  delegationParser,
  object({ resource: constant("empty" as const) }),
);

export async function runSparkHubCli(
  argv: string[],
  output: SparkCliOutput = consoleSparkCliOutput,
  errorOutput: SparkCliOutput = consoleSparkCliErrorOutput,
): Promise<number> {
  const [resource = "status", ...rest] = argv;
  if (resource === "help" || resource === "--help" || resource === "-h") {
    output.write(sparkHubHelpText());
    return 0;
  }
  if (resource === "access" || resource === "instance") {
    return runSparkHubCliCommand(parseSparkHubCliArgs([resource, ...rest]), output);
  }
  if (resource === "workspace" && rest[0] === "access") {
    return runSparkHubCliCommand(
      parseSparkHubCliArgs(["workspace", "access", ...rest.slice(1)]),
      output,
    );
  }

  const command = parseHubDatabaseCliArgs(argv);
  if (command.resource === "help") {
    output.write(sparkHubHelpText());
    return 0;
  }
  const db = openDatabase(command.databasePath ? { path: command.databasePath } : {});
  try {
    migrate(db);
    const result = runHubDatabaseCommand(db, command);
    printSparkCliResult(output, result, { json: command.json });
    return 0;
  } catch (error) {
    errorOutput.write(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    db.close();
  }
}

function parseHubDatabaseCliArgs(argv: string[]): HubDatabaseCliCommand {
  const result = parse(hubDatabaseCliParser, argv);
  if (!result.success) {
    const [resource = "status", verb] = argv;
    if (!new Set(["help", "--help", "-h", "status", "workspace", "delegation"]).has(resource)) {
      throw new Error(`Unknown spark hub resource: ${resource}`);
    }
    if (resource === "workspace" && verb && verb !== "list") {
      throw new Error("Usage: spark hub workspace list");
    }
    if (
      resource === "delegation" &&
      verb &&
      !new Set(["create", "list", "show", "reply", "cancel"]).has(verb) &&
      !verb.startsWith("-")
    ) {
      throw new Error(`Unknown spark hub delegation verb: ${verb}`);
    }
    throw new Error(formatMessage(result.error));
  }
  if (result.value.resource === "empty") {
    return { resource: "status", json: false };
  }
  if (result.value.resource === "help") return { resource: "help" };
  return result.value;
}

export function sparkHubHelpText(): string {
  return `spark hub - Spark logical coordination plane

Usage:
  spark hub status [--json]
  spark hub workspace list [--json]
  spark hub delegation create --source <workspace> --target <workspace> --goal <text> [--role <role>]
  spark hub delegation list [--workspace <workspace>] [--limit <count>] [--json]
  spark hub delegation show <delegation-id> [--json]
  spark hub delegation reply <delegation-id> --text <answer>
  spark hub delegation cancel <delegation-id> [--reason <text>]
  spark hub access <create|list|revoke> [...]
  spark hub workspace access <create|list|revoke> [...]
  spark hub instance <status|backup|restore> [...]

Hub owns workspace registry, delegation state, routing, audit, and receipts. Daemons own execution truth; Hub is the Web presentation client.
`;
}

function runHubDatabaseCommand(
  db: ReturnType<typeof openDatabase>,
  command: Exclude<HubDatabaseCliCommand, { resource: "help" }>,
): unknown {
  if (command.resource === "status") {
    return {
      plane: "hub",
      resource: "status",
      ...loadHubStatus(db),
    };
  }

  if (command.resource === "workspace") {
    return { plane: "hub", resource: "workspace", workspaces: listHubWorkspaces(db) };
  }

  if (command.resource !== "delegation") {
    throw new Error(`Unknown spark hub resource: ${command.resource}`);
  }
  const verb = command.verb ?? "list";
  const selector = command.selector;
  if (verb === "list") {
    const workspace = resolveWorkspaceId(db, command.workspace, false);
    return {
      plane: "hub",
      resource: "delegation",
      delegations: listHubWorkspaceDelegations(db, {
        ...(workspace ? { workspaceId: workspace } : {}),
        limit: command.limit,
      }),
    };
  }
  if (verb === "show") {
    if (!selector) throw new Error("spark hub delegation show requires a delegation id");
    return {
      plane: "hub",
      resource: "delegation",
      delegation: requireHubWorkspaceDelegation(db, selector),
      messages: listHubWorkspaceDelegationMessages(db, selector),
    };
  }

  const ownerUserId = requireHubOwnerUserId(db, command.actor);
  if (verb === "create") {
    const sourceWorkspaceId = resolveWorkspaceId(db, command.source, true)!;
    const targetWorkspaceId = resolveWorkspaceId(db, command.target, true)!;
    const goal = command.goal;
    if (!goal) throw new Error("spark hub delegation create requires --goal");
    const delegationId = createId("dlg");
    return {
      plane: "hub",
      resource: "delegation",
      delegation: createHubWorkspaceDelegation(db, {
        delegationId,
        sourceWorkspaceId,
        targetWorkspaceId,
        goal,
        constraints: optionalList(command.constraints),
        requestedRole: command.role,
        actor: { kind: "hub_owner", id: ownerUserId },
        lineage: [],
        hopCount: 1,
        idempotencyKey: wireIdempotencyKey(command.idempotencyKey ?? `hub-cli:${delegationId}`),
        createdAt: new Date().toISOString(),
      }),
    };
  }
  if (verb === "reply") {
    if (!selector) throw new Error("spark hub delegation reply requires a delegation id");
    const text = command.text;
    if (!text) throw new Error("spark hub delegation reply requires --text");
    return {
      plane: "hub",
      resource: "delegation",
      delegation: replyHubWorkspaceDelegation(db, {
        delegationId: selector,
        ownerUserId,
        text,
      }),
    };
  }
  if (verb === "cancel") {
    if (!selector) throw new Error("spark hub delegation cancel requires a delegation id");
    return {
      plane: "hub",
      resource: "delegation",
      delegation: cancelHubWorkspaceDelegation(db, {
        delegationId: selector,
        ownerUserId,
        reason: command.reason,
      }),
    };
  }
  const exhaustive: never = verb;
  return exhaustive;
}

function requireHubOwnerUserId(
  db: ReturnType<typeof openDatabase>,
  requested: string | undefined,
): string {
  const row = db
    .prepare(
      `SELECT id FROM users
       WHERE role = 'owner' AND status = 'active' AND (? IS NULL OR id = ?)
       ORDER BY created_at, id LIMIT 1`,
    )
    .get(requested ?? null, requested ?? null) as { id: string } | undefined;
  if (!row) throw new Error("No active Hub Owner is available for this command");
  return row.id;
}

function resolveWorkspaceId(
  db: ReturnType<typeof openDatabase>,
  selector: string | undefined,
  required: boolean,
): string | undefined {
  if (!selector) {
    if (required) throw new Error("Workspace selector is required");
    return undefined;
  }
  const row = db
    .prepare("SELECT id FROM workspaces WHERE id = ? OR slug = ? LIMIT 1")
    .get(selector, selector) as { id: string } | undefined;
  if (!row) throw new Error(`Unknown Hub workspace: ${selector}`);
  return row.id;
}

function optionalList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}
