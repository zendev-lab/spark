import { runHubCompatDatabaseCli } from "./compat-database-cli.ts";
import { runSparkHubCli as runHubCoordinationCli } from "./cli/hub.ts";
import { startHubProductionHost } from "./cli/production-start.ts";
import { helpFlagRequested } from "./cli/shared.ts";
import { runHubWebCli } from "./cli/web-cli.ts";

/** Canonical process entry for `spark-hub`. */
export async function runSparkHubAppCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0) return await startHubProductionHost();

  const [first, ...rest] = argv;
  if (first === "__compat-database") {
    return await runHubCompatDatabaseCli(rest, { stdout: process.stdout });
  }
  if (first === "__compat-product") return await runSparkHubCompatProduct(rest);
  switch (first) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(sparkHubAppHelpText());
      return 0;
    case "start":
      if (helpFlagRequested(rest)) {
        process.stdout.write(sparkHubAppHelpText());
        return 0;
      }
      return await startHubProductionHost(rest);
    case "web":
      return await runHubWebCli(rest);
    default:
      return await runHubCoordinationCli(argv);
  }
}

async function runSparkHubCompatProduct(argv: string[]): Promise<number> {
  const [action, ...args] = argv;
  if (!action || !["prepare", "inspect"].includes(action)) {
    throw new Error("Usage: __compat-product <prepare|inspect> --database <path> --json");
  }
  const databaseIndex = args.indexOf("--database");
  const databasePath = databaseIndex >= 0 ? args[databaseIndex + 1] : undefined;
  if (!databasePath || !args.includes("--json")) {
    throw new Error(` requires --database <path> --json`);
  }
  const unsupported = args.filter(
    (arg, index) => index !== databaseIndex + 1 && arg !== "--json" && arg !== "--database",
  );
  if (unsupported.length > 0)
    throw new Error("Unknown __compat-product " + action + " argument: " + unsupported[0]);
  const { migrate, openDatabase } = await import("@zendev-lab/spark-hub-db");
  const db = openDatabase({ path: databasePath });
  try {
    migrate(db);
    if (action === "prepare") {
      const { createRuntimeEnrollmentToken } =
        await import("@zendev-lab/spark-hub-coordination/runtime-registration");
      const token = createRuntimeEnrollmentToken(db, {
        label: "release compatibility product probe",
        workspaceName: "compat",
        workspaceSlug: "compat",
        ttlMs: 15 * 60 * 1000,
      });
      const origin =
        process.env.ORIGIN ||
        `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "5173"}`;
      process.stdout.write(
        `${JSON.stringify({ product: "@zendev-lab/spark-hub", action, origin, databasePath, registrationToken: token.refreshToken, workspaceName: token.workspaceName, workspaceSlug: token.workspaceSlug, expiresAt: token.expiresAt })}\n`,
      );
      return 0;
    }
    const deadline = Date.now() + 20_000;
    let runtime:
      | {
          id: string;
          status: string;
          protocolVersion: string;
          bindingId: string;
          workspaceId: string;
        }
      | undefined;
    while (Date.now() < deadline) {
      runtime = db
        .prepare(
          `SELECT rc.id, rc.status, rc.protocol_version AS protocolVersion,
                  rwb.id AS bindingId, wob.workspace_id AS workspaceId
             FROM runtime_connections rc
             JOIN runtime_workspace_bindings rwb ON rwb.runtime_id = rc.id
             JOIN workspace_leases wob
               ON wob.runtime_workspace_binding_id = rwb.id AND wob.ended_at IS NULL
            WHERE rc.status = 'online' AND rwb.status != 'archived'
            ORDER BY rc.updated_at DESC LIMIT 1`,
        )
        .get() as typeof runtime;
      if (runtime) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!runtime) throw new Error("runtime registration/projection did not become online");
    const { submitRuntimeControlCommand, waitForRuntimeControlCommand } =
      await import("@zendev-lab/spark-hub-coordination/runtime-control");
    const submitted = submitRuntimeControlCommand(db, {
      runtimeId: runtime.id,
      payload: { kind: "daemon.status.request", scope: "daemon" },
    });
    const terminal = await waitForRuntimeControlCommand(db, submitted.commandId, {
      timeoutMs: 20_000,
    });
    if (terminal.status !== "succeeded")
      throw new Error(`daemon status probe ended ${terminal.status}`);
    process.stdout.write(
      `${JSON.stringify({ product: "@zendev-lab/spark-hub", action, databasePath, runtimeId: runtime.id, runtimeStatus: runtime.status, protocolVersion: runtime.protocolVersion, bindingId: runtime.bindingId, workspaceId: runtime.workspaceId, commandId: terminal.commandId, commandStatus: terminal.status })}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

export function sparkHubAppHelpText(): string {
  return `spark-hub - Spark control plane and embedded management UI

Usage:
  spark-hub
  spark-hub web <start|status|stop|logs> [args...]
  spark-hub status [--json]
  spark-hub workspace list [--json]
  spark-hub delegation <create|list|show|reply|cancel> [args...]
  spark-hub access <create|list|revoke> [args...]
  spark-hub instance <status|backup|restore> [args...]

The top-level "spark hub ..." dispatcher form forwards to this executable.
`;
}

export { sparkHubHelpText } from "./cli/coordination.ts";
