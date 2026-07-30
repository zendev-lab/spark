import {
  EVIDENCE_MIGRATION_VERSION,
  EvidenceMigrationBlockedError,
  type ApplyEvidenceMigrationOptions,
  type EvidenceMigrationWorkspace,
  type EvidenceNamespaceMigrationPlan,
  type EvidenceNamespaceMigrationReport,
  type EvidenceWorkspaceMigrationReport,
} from "./evidence-migration-types.ts";
import {
  workspaceTreeHash,
  hashJson,
  normalizeMigrationWorkspaces,
} from "./evidence-migration-paths.ts";
import { planWorkspaceMigration } from "./evidence-migration-plan.ts";
import {
  applyWorkspaceMigration,
  restoreEvidenceNamespaceMigrationBackup,
} from "./evidence-migration-apply.ts";

export * from "./evidence-migration-types.ts";
export { restoreEvidenceNamespaceMigrationBackup };

export async function planEvidenceNamespaceMigration(
  workspaces: readonly EvidenceMigrationWorkspace[],
): Promise<EvidenceNamespaceMigrationPlan> {
  const unique = await normalizeMigrationWorkspaces(workspaces);
  const workspacePlans = [];
  for (const workspace of unique) workspacePlans.push(await planWorkspaceMigration(workspace));
  workspacePlans.sort((left, right) =>
    left.workspace.workspaceId.localeCompare(right.workspace.workspaceId),
  );
  const plan = {
    report: namespaceReport(
      true,
      workspacePlans.map((workspace) => workspace.report),
    ),
  } as EvidenceNamespaceMigrationPlan;
  Object.defineProperty(plan, "workspacePlans", {
    value: workspacePlans,
    enumerable: false,
    writable: false,
  });
  return plan;
}

export async function applyEvidenceNamespaceMigration(
  plan: EvidenceNamespaceMigrationPlan,
  options: ApplyEvidenceMigrationOptions = {},
): Promise<EvidenceNamespaceMigrationReport> {
  if (plan.report.blocked) throw new EvidenceMigrationBlockedError(plan.report);
  for (const workspacePlan of plan.workspacePlans) {
    const currentHash = await workspaceTreeHash(workspacePlan.rootDir);
    if (currentHash !== workspacePlan.report.beforeHash) {
      throw new Error(
        `stale evidence migration plan for ${workspacePlan.workspace.workspaceId}: expected ${workspacePlan.report.beforeHash}, got ${currentHash}`,
      );
    }
  }
  const reports: EvidenceWorkspaceMigrationReport[] = [];
  try {
    for (const workspacePlan of plan.workspacePlans) {
      reports.push(await applyWorkspaceMigration(workspacePlan, options));
    }
    return namespaceReport(false, reports);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const report of [...reports].reverse()) {
      if (!report.backupPath) continue;
      try {
        await restoreEvidenceNamespaceMigrationBackup(report.backupPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Evidence migration failed and cross-workspace rollback was incomplete",
      );
    }
    throw error;
  }
}

export async function migrateEvidenceNamespaces(
  workspaces: readonly EvidenceMigrationWorkspace[],
  options: ApplyEvidenceMigrationOptions & { dryRun?: boolean } = {},
): Promise<EvidenceNamespaceMigrationReport> {
  const plan = await planEvidenceNamespaceMigration(workspaces);
  if (options.dryRun ?? true) return plan.report;
  return applyEvidenceNamespaceMigration(plan, options);
}

function namespaceReport(
  dryRun: boolean,
  workspaces: EvidenceWorkspaceMigrationReport[],
): EvidenceNamespaceMigrationReport {
  const sorted = [...workspaces].sort((left, right) =>
    left.workspaceId.localeCompare(right.workspaceId),
  );
  const totals = {
    discovered: sum(sorted, (item) => item.discovered),
    migrated: sum(sorted, (item) => item.migrated),
    artifactPreserved: sum(sorted, (item) => item.artifactPreserved),
    artifactMisclassified: sum(sorted, (item) => item.artifactMisclassified.length),
    dangling: sum(sorted, (item) => item.dangling.length),
    invalid: sum(sorted, (item) => item.invalid.length),
    ambiguous: sum(sorted, (item) => item.ambiguous.length),
    skipped: sum(sorted, (item) => item.skipped.length),
    changedFiles: sum(sorted, (item) => item.changedFiles),
  };
  return {
    version: EVIDENCE_MIGRATION_VERSION,
    dryRun,
    planHash: hashJson(sorted.map((workspace) => [workspace.workspaceId, workspace.planHash])),
    blocked: sorted.some((workspace) => workspace.blocked),
    workspaces: sorted,
    totals,
  };
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}
