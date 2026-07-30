export const EVIDENCE_MIGRATION_VERSION = 1 as const;
export const EVIDENCE_METADATA_BODY_THRESHOLD_BYTES = 64 * 1024;
export const EVIDENCE_METADATA_BODY_PREVIEW_CHARS = 4_000;
export const EVIDENCE_BACKUP_ROOT = ".spark/backups/evidence-namespace";
export const EVIDENCE_MIGRATION_TEMPORARY_MARKER = ".evidence-migration.";

export interface EvidenceMigrationWorkspace {
  workspaceId: string;
  rootDir: string;
  displayName?: string;
}

export interface EvidenceMigrationIssue {
  path: string;
  code: string;
  message: string;
  ref?: string;
}

export interface EvidenceMigrationSkipped {
  path: string;
  reason: string;
}

export interface EvidenceMigrationMapping {
  fromRef: string;
  toRef: string;
  kind: string;
  path: string;
  hash?: string;
}

export interface EvidenceWorkspaceMigrationReport {
  workspaceId: string;
  workspaceRoot: string;
  discovered: number;
  migrated: number;
  artifactPreserved: number;
  artifactMisclassified: EvidenceMigrationIssue[];
  dangling: EvidenceMigrationIssue[];
  invalid: EvidenceMigrationIssue[];
  ambiguous: EvidenceMigrationIssue[];
  skipped: EvidenceMigrationSkipped[];
  mapping: EvidenceMigrationMapping[];
  changedFiles: number;
  backupPath: string | null;
  beforeHash: string;
  afterHash: string;
  artifactHashBefore: string;
  artifactHashAfter: string;
  planHash: string;
  blocked: boolean;
}

export interface EvidenceNamespaceMigrationReport {
  version: typeof EVIDENCE_MIGRATION_VERSION;
  dryRun: boolean;
  planHash: string;
  blocked: boolean;
  workspaces: EvidenceWorkspaceMigrationReport[];
  totals: {
    discovered: number;
    migrated: number;
    artifactPreserved: number;
    artifactMisclassified: number;
    dangling: number;
    invalid: number;
    ambiguous: number;
    skipped: number;
    changedFiles: number;
  };
}

export type EvidenceMigrationFaultPoint =
  | "after-backup"
  | "before-write"
  | "before-rename"
  | "before-delete"
  | "after-operation";

export interface EvidenceMigrationFaultContext {
  workspaceId: string;
  workspaceRoot: string;
  relativePath?: string;
  operationIndex?: number;
  phase: "apply" | "backup";
}

export type EvidenceMigrationFaultInjector = (
  point: EvidenceMigrationFaultPoint,
  context: EvidenceMigrationFaultContext,
) => void | Promise<void>;

export interface PlannedWrite {
  kind: "write";
  relativePath: string;
  beforeHash: string | null;
  afterHash: string;
  content: Buffer;
}

export interface PlannedDelete {
  kind: "delete";
  relativePath: string;
  beforeHash: string;
  afterHash: null;
}

export type PlannedOperation = PlannedWrite | PlannedDelete;

export interface WorkspaceMigrationPlan {
  workspace: EvidenceMigrationWorkspace;
  rootDir: string;
  report: EvidenceWorkspaceMigrationReport;
  operations: PlannedOperation[];
}

export interface EvidenceNamespaceMigrationPlan {
  report: EvidenceNamespaceMigrationReport;
  /** Internal apply payload. Reports never serialize operation bodies. */
  readonly workspacePlans: readonly WorkspaceMigrationPlan[];
}

export interface ApplyEvidenceMigrationOptions {
  now?: () => Date;
  faultInjector?: EvidenceMigrationFaultInjector;
}

export interface EvidenceMigrationBackupEntry {
  relativePath: string;
  operation: PlannedOperation["kind"];
  beforeHash: string | null;
  afterHash: string | null;
  existed: boolean;
}

export interface EvidenceMigrationBackupManifest {
  version: typeof EVIDENCE_MIGRATION_VERSION;
  status: "prepared" | "applied" | "rolled_back" | "restored";
  workspaceId: string;
  workspaceRoot: string;
  createdAt: string;
  completedAt?: string;
  planHash: string;
  beforeHash: string;
  afterHash: string;
  entries: EvidenceMigrationBackupEntry[];
}

export interface FileFact {
  hash: string;
  bytes: number;
}

export interface EvidenceMigrationIssueBuckets {
  dangling: EvidenceMigrationIssue[];
  artifactMisclassified: EvidenceMigrationIssue[];
}

export class EvidenceMigrationBlockedError extends Error {
  readonly report: EvidenceNamespaceMigrationReport;

  constructor(report: EvidenceNamespaceMigrationReport) {
    super(
      "evidence namespace migration is blocked by invalid, dangling, ambiguous, or misclassified refs",
    );
    this.name = "EvidenceMigrationBlockedError";
    this.report = report;
  }
}

export class EvidenceMigrationApplyError extends Error {
  readonly workspaceId: string;
  readonly backupPath: string | null;
  readonly rolledBack: boolean;

  constructor(options: {
    workspaceId: string;
    backupPath: string | null;
    rolledBack: boolean;
    cause: unknown;
  }) {
    super(
      `evidence namespace migration failed for ${options.workspaceId}; rollback=${String(options.rolledBack)}: ${errorMessage(options.cause)}`,
      { cause: options.cause },
    );
    this.name = "EvidenceMigrationApplyError";
    this.workspaceId = options.workspaceId;
    this.backupPath = options.backupPath;
    this.rolledBack = options.rolledBack;
  }
}

export function migrationIssue(
  path: string,
  code: string,
  message: string,
  ref?: string,
): EvidenceMigrationIssue {
  return { path, code, message, ...(ref ? { ref } : {}) };
}

export function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
