import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  channelAdapterAccountIdentity,
  parseChannelsConfig,
  type ChannelAdapterConfig,
  type ChannelRouteConfig,
  type ChannelsConfig,
} from "@zendev-lab/dsh-channels";
import {
  channelConfigPath,
  resolveSparkPaths,
  writePrivateFile,
  type ResolveSparkHomeOptions,
} from "@zendev-lab/spark-system";

const CHANNEL_CONFIG_MIGRATION_VERSION = 1;

export interface DaemonChannelsConfigConflict {
  kind: "account" | "adapter" | "route" | "ingress" | "corrupt";
  key: string;
  sources: string[];
}

export type DaemonChannelsConfigMigrationResult =
  | {
      state: "unconfigured";
      path: string;
      conflicts: [];
    }
  | {
      state: "ready";
      path: string;
      config: ChannelsConfig;
      migrated: boolean;
      conflicts: [];
    }
  | {
      state: "conflict";
      path: string;
      conflicts: DaemonChannelsConfigConflict[];
    };

interface ConfigCandidate {
  path: string;
  source: string;
  config: ChannelsConfig;
}

interface MigrationJournal {
  version: typeof CHANNEL_CONFIG_MIGRATION_VERSION;
  state: "staged" | "complete" | "conflict";
  target: string;
  sources: string[];
  targetHash?: string;
  conflicts?: DaemonChannelsConfigConflict[];
}

/**
 * Merge retired global/workspace Channel configs into the daemon-global owner.
 *
 * The migration never guesses when account, adapter, route, secret, or ingress
 * facts disagree. Source files are copied to private backups and otherwise
 * left intact; the journal makes interrupted writes and reruns deterministic.
 */
export async function migrateDaemonChannelsConfig(
  options: ResolveSparkHomeOptions = {},
): Promise<DaemonChannelsConfigMigrationResult> {
  const paths = resolveSparkPaths({ app: "daemon", ...options });
  const target = channelConfigPath(paths);
  const journalPath = `${target}.migration.json`;
  const existing = await readConfig(target);
  if (existing.state === "ready") {
    await chmodPrivate(target);
    return {
      state: "ready",
      path: target,
      config: existing.config,
      migrated: false,
      conflicts: [],
    };
  }
  if (existing.state === "corrupt") {
    const recovered = await recoverTargetBackup(target);
    if (recovered) {
      return { state: "ready", path: target, config: recovered, migrated: true, conflicts: [] };
    }
    const conflicts = [redactedConflict("corrupt", "daemon-global", [target])];
    await writeJournal(journalPath, {
      version: CHANNEL_CONFIG_MIGRATION_VERSION,
      state: "conflict",
      target,
      sources: [target],
      conflicts,
    });
    return { state: "conflict", path: target, conflicts };
  }

  const candidates = await readLegacyCandidates(options);
  if (candidates.length === 0) {
    return { state: "unconfigured", path: target, conflicts: [] };
  }
  const merged = mergeCandidates(candidates);
  if (merged.conflicts.length > 0) {
    await writeJournal(journalPath, {
      version: CHANNEL_CONFIG_MIGRATION_VERSION,
      state: "conflict",
      target,
      sources: candidates.map((candidate) => candidate.source),
      conflicts: merged.conflicts,
    });
    return { state: "conflict", path: target, conflicts: merged.conflicts };
  }

  const serialized = `${JSON.stringify(merged.config, null, 2)}\n`;
  const targetHash = sha256(serialized);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  for (const candidate of candidates) {
    const backup = `${candidate.path}.daemon-global.bak`;
    if (!(await fileExists(backup))) {
      await copyFile(candidate.path, backup);
      await chmodPrivate(backup);
    }
  }
  await writeJournal(journalPath, {
    version: CHANNEL_CONFIG_MIGRATION_VERSION,
    state: "staged",
    target,
    sources: candidates.map((candidate) => candidate.source),
    targetHash,
  });
  await writeAtomicPrivateFile(target, serialized);
  const readback = await readConfig(target);
  if (
    readback.state !== "ready" ||
    sha256(`${JSON.stringify(readback.config, null, 2)}\n`) !== targetHash
  ) {
    throw new Error(`daemon Channel config readback failed: ${target}`);
  }
  await writeJournal(journalPath, {
    version: CHANNEL_CONFIG_MIGRATION_VERSION,
    state: "complete",
    target,
    sources: candidates.map((candidate) => candidate.source),
    targetHash,
  });
  return { state: "ready", path: target, config: readback.config, migrated: true, conflicts: [] };
}

export async function loadDaemonGlobalChannelsConfig(
  options: ResolveSparkHomeOptions = {},
): Promise<DaemonChannelsConfigMigrationResult> {
  return await migrateDaemonChannelsConfig(options);
}

async function readLegacyCandidates(options: ResolveSparkHomeOptions): Promise<ConfigCandidate[]> {
  const paths = resolveSparkPaths({ app: "daemon", ...options });
  const sparkHome = options.sparkHome ?? paths.dataDir;
  const sources: Array<{ path: string; source: string }> = [
    { path: join(sparkHome, "channels", "config.json"), source: "legacy-global" },
  ];
  const workspacesRoot = join(sparkHome, "workspaces");
  try {
    for (const workspaceId of (await readdir(workspacesRoot)).sort()) {
      sources.push({
        path: join(workspacesRoot, workspaceId, "channels", "config.json"),
        source: `workspace:${sha256(workspaceId).slice(0, 12)}`,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const candidates: ConfigCandidate[] = [];
  for (const source of sources) {
    const loaded = await readConfig(source.path);
    if (loaded.state === "missing") continue;
    if (loaded.state === "corrupt") {
      throw new Error(`invalid legacy Channel config: ${source.source}`);
    }
    candidates.push({ ...source, config: loaded.config });
  }
  return candidates;
}

function mergeCandidates(candidates: ConfigCandidate[]): {
  config: ChannelsConfig;
  conflicts: DaemonChannelsConfigConflict[];
} {
  const adapters: Record<string, ChannelAdapterConfig> = {};
  const routes: Record<string, ChannelRouteConfig> = {};
  const adapterOwners = new Map<string, string>();
  const identityOwners = new Map<
    string,
    { adapterId: string; config: ChannelAdapterConfig; source: string }
  >();
  const remaps = new Map<string, string>();
  const conflicts: DaemonChannelsConfigConflict[] = [];
  let ingress: ChannelsConfig["ingress"];
  let ingressSource: string | undefined;

  for (const candidate of candidates) {
    for (const [adapterId, config] of Object.entries(candidate.config.adapters)) {
      const identity = channelAdapterAccountIdentity(config);
      const identityOwner = identityOwners.get(identity);
      const idOwner = adapterOwners.get(adapterId);
      if (identityOwner && stableJson(identityOwner.config) !== stableJson(config)) {
        conflicts.push(
          redactedConflict("account", identity, [identityOwner.source, candidate.source]),
        );
        continue;
      }
      if (
        idOwner &&
        adapters[adapterId] &&
        channelAdapterAccountIdentity(adapters[adapterId]) !== identity
      ) {
        conflicts.push(redactedConflict("adapter", adapterId, [idOwner, candidate.source]));
        continue;
      }
      const canonicalId = identityOwner?.adapterId ?? adapterId;
      remaps.set(`${candidate.source}\0${adapterId}`, canonicalId);
      if (!identityOwner) {
        adapters[canonicalId] = config;
        adapterOwners.set(canonicalId, candidate.source);
        identityOwners.set(identity, { adapterId: canonicalId, config, source: candidate.source });
      }
    }
    if (candidate.config.ingress) {
      if (ingress && stableJson(ingress) !== stableJson(candidate.config.ingress)) {
        conflicts.push(redactedConflict("ingress", "policy", [ingressSource!, candidate.source]));
      } else {
        ingress = candidate.config.ingress;
        ingressSource = candidate.source;
      }
    }
  }

  for (const candidate of candidates) {
    for (const [routeName, route] of Object.entries(candidate.config.routes)) {
      const adapter = remaps.get(`${candidate.source}\0${route.adapter}`) ?? route.adapter;
      const next = { ...route, adapter };
      const existing = routes[routeName];
      if (existing && stableJson(existing) !== stableJson(next)) {
        conflicts.push(redactedConflict("route", routeName, [routeName, candidate.source]));
      } else {
        routes[routeName] = next;
      }
    }
  }
  return {
    config: { adapters, routes, ...(ingress ? { ingress } : {}) },
    conflicts: deduplicateConflicts(conflicts),
  };
}

function redactedConflict(
  kind: DaemonChannelsConfigConflict["kind"],
  key: string,
  sources: string[],
): DaemonChannelsConfigConflict {
  return {
    kind,
    key: `sha256:${sha256(key).slice(0, 16)}`,
    sources: [...new Set(sources)].sort(),
  };
}

function deduplicateConflicts(
  conflicts: DaemonChannelsConfigConflict[],
): DaemonChannelsConfigConflict[] {
  return [...new Map(conflicts.map((conflict) => [stableJson(conflict), conflict])).values()];
}

async function readConfig(
  path: string,
): Promise<
  { state: "missing" } | { state: "corrupt" } | { state: "ready"; config: ChannelsConfig }
> {
  try {
    return {
      state: "ready",
      config: parseChannelsConfig(JSON.parse(await readFile(path, "utf8"))),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "corrupt" };
  }
}

async function recoverTargetBackup(target: string): Promise<ChannelsConfig | undefined> {
  const backup = `${target}.bak`;
  const loaded = await readConfig(backup);
  if (loaded.state !== "ready") return undefined;
  await writeAtomicPrivateFile(target, `${JSON.stringify(loaded.config, null, 2)}\n`);
  return loaded.config;
}

async function writeAtomicPrivateFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp`;
  if (await fileExists(path)) {
    const backup = `${path}.bak`;
    if (!(await fileExists(backup))) {
      await copyFile(path, backup);
      await chmodPrivate(backup);
    }
  }
  writePrivateFile(temporary, contents);
  await rename(temporary, path);
  await chmodPrivate(path);
}

async function writeJournal(path: string, journal: MigrationJournal): Promise<void> {
  await writeAtomicPrivateFile(path, `${JSON.stringify(journal, null, 2)}\n`);
}

async function chmodPrivate(path: string): Promise<void> {
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
