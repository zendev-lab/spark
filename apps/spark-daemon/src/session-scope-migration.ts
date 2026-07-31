import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  SPARK_SESSION_REGISTRY_VERSION,
  defaultSparkSessionRegistryRoot,
} from "@zendev-lab/spark-session";
import {
  parseSparkSessionRegistryRecords,
  type SparkSessionRegistryRecord,
} from "@zendev-lab/spark-protocol/session-assignment";

const MIGRATABLE_REGISTRY_VERSIONS = new Set([1, 2, 3]);

export interface SessionScopeMigrationWorkspace {
  id: string;
  localPath: string;
}

export interface MigrateDaemonGlobalSessionsOptions {
  sparkHome: string;
  workspaces: SessionScopeMigrationWorkspace[];
  now?: Date;
}

export interface SessionScopeMigrationResult {
  changed: boolean;
  registryPath: string;
  backupPath: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  migratedSessions: number;
  archivedSessions: number;
}

interface SessionScopeMigrationManifest {
  version: 1;
  createdAt: string;
  sourcePath: string;
  beforeHash: string;
  afterHash: string;
  migratedSessions: number;
  archivedSessions: number;
  backupFile: "registry.json";
}

/**
 * Hard-cut legacy daemon-global top-level sessions into workspace ownership.
 *
 * The migration plans every record before writing, preserves an exact backup,
 * CAS-checks the active registry, and replaces the one active file atomically.
 * Daemon records whose cwd cannot identify exactly one registered workspace are
 * archived in place so their transcript pointers remain recoverable.
 */
export async function migrateDaemonGlobalSessions(
  options: MigrateDaemonGlobalSessionsOptions,
): Promise<SessionScopeMigrationResult> {
  const rootDir = defaultSparkSessionRegistryRoot(options.sparkHome);
  const registryPath = join(rootDir, "registry.json");
  let source: Buffer;
  let sourceMode: number;
  try {
    const sourceStat = await lstat(registryPath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`session registry must be a regular non-symlink file: ${registryPath}`);
    }
    sourceMode = sourceStat.mode & 0o777;
    source = await readFile(registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        changed: false,
        registryPath,
        backupPath: null,
        beforeHash: null,
        afterHash: null,
        migratedSessions: 0,
        archivedSessions: 0,
      };
    }
    throw error;
  }

  const raw = parseRegistryJson(source, registryPath);
  if (raw.version === SPARK_SESSION_REGISTRY_VERSION) {
    const sessions = parseSparkSessionRegistryRecords(raw.sessions);
    const activeDaemonSession = sessions.find(
      (session) => session.scope.kind === "daemon" && session.status !== "archived",
    );
    if (activeDaemonSession) {
      throw new Error(
        `session registry v4 contains active daemon-global session: ${activeDaemonSession.sessionId}`,
      );
    }
    const hash = sha256(source);
    return {
      changed: false,
      registryPath,
      backupPath: null,
      beforeHash: hash,
      afterHash: hash,
      migratedSessions: 0,
      archivedSessions: 0,
    };
  }
  if (!MIGRATABLE_REGISTRY_VERSIONS.has(raw.version)) {
    throw new Error(`unsupported session registry version: ${String(raw.version)}`);
  }

  const sessions = parseSparkSessionRegistryRecords(raw.sessions);
  const workspaces = normalizeWorkspaces(options.workspaces);
  const migratedAt = (options.now ?? new Date()).toISOString();
  let migratedSessions = 0;
  let archivedSessions = 0;
  const migrated = sessions.map((session) => {
    if (session.scope.kind !== "daemon") return session;
    const workspace = inferWorkspace(session.cwd, workspaces);
    if (!workspace) {
      archivedSessions += 1;
      return session.status === "archived"
        ? session
        : { ...session, status: "archived" as const, updatedAt: migratedAt };
    }
    migratedSessions += 1;
    const { scope: _scope, workspaceId: _workspaceId, ...rest } = session;
    return {
      ...rest,
      scope: { kind: "workspace" as const, workspaceId: workspace.id },
      workspaceId: workspace.id,
    };
  });
  const canonicalSessions = parseSparkSessionRegistryRecords(migrated);
  const output = Buffer.from(
    `${JSON.stringify(
      { version: SPARK_SESSION_REGISTRY_VERSION, sessions: canonicalSessions },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const beforeHash = sha256(source);
  const afterHash = sha256(output);
  const backupPath = await createMigrationBackup({
    rootDir,
    registryPath,
    source,
    output,
    sourceMode,
    migratedAt,
    migratedSessions,
    archivedSessions,
  });

  const current = await readFile(registryPath);
  if (sha256(current) !== beforeHash) {
    throw new Error(`session registry changed after migration planning: ${registryPath}`);
  }
  await atomicReplace(registryPath, output, sourceMode);
  const readback = await readFile(registryPath);
  if (sha256(readback) !== afterHash) {
    throw new Error(`session registry readback hash mismatch: ${registryPath}`);
  }
  const readbackJson = parseRegistryJson(readback, registryPath);
  if (readbackJson.version !== SPARK_SESSION_REGISTRY_VERSION) {
    throw new Error(`session registry readback version mismatch: ${registryPath}`);
  }
  parseSparkSessionRegistryRecords(readbackJson.sessions);

  return {
    changed: true,
    registryPath,
    backupPath,
    beforeHash,
    afterHash,
    migratedSessions,
    archivedSessions,
  };
}

function parseRegistryJson(
  bytes: Buffer,
  registryPath: string,
): { version: number; sessions: unknown[] } {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`invalid session registry JSON: ${registryPath}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session registry root must be an object: ${registryPath}`);
  }
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.version) || !Array.isArray(record.sessions)) {
    throw new Error(`session registry must contain integer version and sessions: ${registryPath}`);
  }
  return { version: record.version as number, sessions: record.sessions };
}

function normalizeWorkspaces(
  workspaces: SessionScopeMigrationWorkspace[],
): SessionScopeMigrationWorkspace[] {
  return workspaces
    .map((workspace) => ({ id: workspace.id.trim(), localPath: resolve(workspace.localPath) }))
    .filter((workspace) => workspace.id && workspace.localPath !== "/");
}

function inferWorkspace(
  cwd: string | undefined,
  workspaces: SessionScopeMigrationWorkspace[],
): SessionScopeMigrationWorkspace | undefined {
  if (!cwd?.trim()) return undefined;
  const resolvedCwd = resolve(cwd);
  const candidates = workspaces.filter((workspace) =>
    pathContains(workspace.localPath, resolvedCwd),
  );
  if (candidates.length === 0) return undefined;
  const longestPath = Math.max(...candidates.map((workspace) => workspace.localPath.length));
  const mostSpecific = candidates.filter((workspace) => workspace.localPath.length === longestPath);
  return mostSpecific.length === 1 ? mostSpecific[0] : undefined;
}

function pathContains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

async function createMigrationBackup(input: {
  rootDir: string;
  registryPath: string;
  source: Buffer;
  output: Buffer;
  sourceMode: number;
  migratedAt: string;
  migratedSessions: number;
  archivedSessions: number;
}): Promise<string> {
  const beforeHash = sha256(input.source);
  const afterHash = sha256(input.output);
  const backupRoot = join(input.rootDir, "backups", "workspace-session-scope");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupPath = join(
    backupRoot,
    `${input.migratedAt.replaceAll(":", "-")}-${beforeHash.slice(0, 12)}`,
  );
  await mkdir(backupPath, { mode: 0o700 });
  await writeDurableExclusive(join(backupPath, "registry.json"), input.source, input.sourceMode);
  const manifest: SessionScopeMigrationManifest = {
    version: 1,
    createdAt: input.migratedAt,
    sourcePath: input.registryPath,
    beforeHash,
    afterHash,
    migratedSessions: input.migratedSessions,
    archivedSessions: input.archivedSessions,
    backupFile: "registry.json",
  };
  await writeDurableExclusive(
    join(backupPath, "manifest.json"),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    0o600,
  );
  await syncDirectory(backupPath);
  await syncDirectory(backupRoot);
  return backupPath;
}

async function atomicReplace(path: string, bytes: Buffer, mode: number): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.registry.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeDurableExclusive(temporaryPath, bytes, mode);
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeDurableExclusive(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
