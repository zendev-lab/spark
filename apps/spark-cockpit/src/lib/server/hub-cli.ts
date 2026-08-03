import {
  cancelHubWorkspaceDelegation,
  createHubWorkspaceDelegation,
  listHubWorkspaceDelegationMessages,
  listHubWorkspaceDelegations,
  listHubWorkspaces,
  loadHubStatus,
  replyHubWorkspaceDelegation,
  requireHubWorkspaceDelegation,
} from "@zendev-lab/spark-cockpit-coordination";
import { migrate, openDatabase } from "@zendev-lab/spark-cockpit-db";
import { createId, wireIdempotencyKey } from "@zendev-lab/spark-protocol";
import {
  consoleSparkCliErrorOutput,
  consoleSparkCliOutput,
  parseSparkCliOptions,
  printSparkCliResult,
  readBooleanOption,
  readNumberOption,
  readStringOption,
  type SparkCliOutput,
} from "../../cli/shared.ts";
import { parseSparkCockpitCliArgs, runSparkCockpitCliCommand } from "../../cli/coordination.ts";

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
    return runSparkCockpitCliCommand(parseSparkCockpitCliArgs([resource, ...rest]), output);
  }
  if (resource === "workspace" && rest[0] === "access") {
    return runSparkCockpitCliCommand(
      parseSparkCockpitCliArgs(["workspace", "access", ...rest.slice(1)]),
      output,
    );
  }

  const parsed = parseSparkCliOptions(rest);
  const json = readBooleanOption(parsed.options, "json");
  const databasePath = readStringOption(parsed.options, "database")?.trim();
  const db = openDatabase(databasePath ? { path: databasePath } : {});
  try {
    migrate(db);
    const result = runHubDatabaseCommand(db, resource, parsed.positionals, parsed.options);
    printSparkCliResult(output, result, { json });
    return 0;
  } catch (error) {
    errorOutput.write(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    db.close();
  }
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

Hub owns workspace registry, delegation state, routing, audit, and receipts. Daemons own execution truth; Cockpit is the Web presentation client.
`;
}

function runHubDatabaseCommand(
  db: ReturnType<typeof openDatabase>,
  resource: string,
  positionals: string[],
  options: Record<string, string | boolean>,
): unknown {
  if (resource === "status") {
    return {
      plane: "hub",
      resource: "status",
      ...loadHubStatus(db),
    };
  }

  if (resource === "workspace") {
    if ((positionals[0] ?? "list") !== "list") {
      throw new Error("Usage: spark hub workspace list");
    }
    return { plane: "hub", resource: "workspace", workspaces: listHubWorkspaces(db) };
  }

  if (resource !== "delegation") {
    throw new Error(`Unknown spark hub resource: ${resource}`);
  }
  const [verb = "list", selector] = positionals;
  if (verb === "list") {
    const workspace = resolveWorkspaceId(db, readStringOption(options, "workspace")?.trim(), false);
    return {
      plane: "hub",
      resource: "delegation",
      delegations: listHubWorkspaceDelegations(db, {
        ...(workspace ? { workspaceId: workspace } : {}),
        limit: readNumberOption(options, "limit"),
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

  const ownerUserId = requireHubOwnerUserId(db, readStringOption(options, "actor")?.trim());
  if (verb === "create") {
    const sourceWorkspaceId = resolveWorkspaceId(
      db,
      readStringOption(options, "source")?.trim(),
      true,
    )!;
    const targetWorkspaceId = resolveWorkspaceId(
      db,
      readStringOption(options, "target")?.trim(),
      true,
    )!;
    const goal = readStringOption(options, "goal")?.trim();
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
        constraints: optionalList(readStringOption(options, "constraints")),
        requestedRole: readStringOption(options, "role")?.trim(),
        actor: { kind: "hub_owner", id: ownerUserId },
        lineage: [],
        hopCount: 1,
        idempotencyKey: wireIdempotencyKey(
          readStringOption(options, "idempotency-key")?.trim() ?? `hub-cli:${delegationId}`,
        ),
        createdAt: new Date().toISOString(),
      }),
    };
  }
  if (verb === "reply") {
    if (!selector) throw new Error("spark hub delegation reply requires a delegation id");
    const text = readStringOption(options, "text")?.trim();
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
        reason: readStringOption(options, "reason")?.trim(),
      }),
    };
  }
  throw new Error(`Unknown spark hub delegation verb: ${verb}`);
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
