import {
  applyEvidenceNamespaceMigration,
  planEvidenceNamespaceMigration,
  type EvidenceNamespaceMigrationReport,
} from "@zendev-lab/spark-artifacts/evidence-migration";
import type { SparkPaths } from "@zendev-lab/spark-platform-node";
import { parseFlags, type CliIo } from "./cli-shared.ts";
import { discoverRegisteredEvidenceMigrationWorkspaces } from "./evidence-migration.js";
import { readRunningPid } from "./service.js";
import { openSparkDaemonDatabase } from "./store/schema.js";

export async function migrateEvidenceWorkspaceCommand(
  paths: SparkPaths,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const apply = flags.apply === "true";
  if (apply) {
    const daemonPid = readRunningPid(paths);
    if (daemonPid !== null) {
      throw new Error(
        `stop the Spark daemon before applying Evidence migration (running pid ${daemonPid})`,
      );
    }
  }

  const db = openSparkDaemonDatabase(paths);
  let discovery;
  try {
    discovery = await discoverRegisteredEvidenceMigrationWorkspaces(db, {
      workspace: flags.workspace,
    });
  } finally {
    db.close();
  }
  if (flags.workspace && discovery.workspaces.length === 0) {
    throw new Error(`registered workspace is unavailable: ${flags.workspace}`);
  }

  const plan = await planEvidenceNamespaceMigration(discovery.workspaces);
  const migration = apply ? await applyEvidenceNamespaceMigration(plan) : plan.report;
  const result = {
    registry: {
      discovered: discovery.workspaces.length + discovery.skipped.length,
      selected: discovery.workspaces.length,
      skipped: discovery.skipped,
    },
    migration,
  };
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout.write(renderEvidenceMigrationSummary(migration, discovery.skipped.length));
  }
  return apply && migration.blocked ? 2 : 0;
}

function renderEvidenceMigrationSummary(
  report: EvidenceNamespaceMigrationReport,
  registrySkipped: number,
): string {
  const mode = report.dryRun ? "dry-run" : "applied";
  const lines = [
    `Evidence migration ${mode}: ${report.workspaces.length} workspace(s), plan ${report.planHash}`,
    `  discovered=${report.totals.discovered} migrated=${report.totals.migrated} artifactPreserved=${report.totals.artifactPreserved}`,
    `  changedFiles=${report.totals.changedFiles} dangling=${report.totals.dangling} invalid=${report.totals.invalid} ambiguous=${report.totals.ambiguous} artifactMisclassified=${report.totals.artifactMisclassified}`,
  ];
  if (registrySkipped > 0) lines.push(`  registrySkipped=${registrySkipped}`);
  for (const workspace of report.workspaces) {
    lines.push(
      `  ${workspace.workspaceId}: migrated=${workspace.migrated} artifact=${workspace.artifactPreserved} changed=${workspace.changedFiles} blocked=${String(workspace.blocked)}`,
    );
    if (workspace.backupPath) lines.push(`    backup=${workspace.backupPath}`);
  }
  if (report.dryRun) lines.push("Dry-run only. Re-run with --apply after stopping the daemon.");
  return `${lines.join("\n")}\n`;
}
