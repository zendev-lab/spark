import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SUPPORTED_DSH_VERSION = "0.1.0-rc.7";
export const SPARK_CUE_PRESETS = ["spark-standard", "spark-code"] as const;

type SparkCuePreset = (typeof SPARK_CUE_PRESETS)[number];
type UpstreamPreset = "standard" | "code";

const UPSTREAM_FILES = {
  "standard/agent.cordis.yml": "4edeb70bf995a0324f234e2adf8db6b394c3d26e1bcb76821976950fb0237bc9",
  "standard/preset.yml": "3c61b4ce68e5dd5cb2c099693fdcb30b91d5f22bbbef546e233321b0fa68f0e4",
  "code/agent.cordis.yml": "dbab55b31753028956e700223420b586476313045f8527d07ed1e080df223718",
  "code/preset.yml": "ec3e1d288532a96dc35fd96c16c08ea6fd92893323039018f71a37988fc72580",
} as const;

const MANAGED_MARKER = ".spark-managed.json";
const MANAGED_OWNER = "@zendev-lab/spark-web-dsh";
const LEGACY_MANAGED_OWNER = "@zendev-lab/dsh-tool-cue";

interface ManagedMarker {
  owner: typeof MANAGED_OWNER | typeof LEGACY_MANAGED_OWNER;
  dshVersion: string;
  sourceDigest: string;
  contentDigest: string;
}

export interface ManagedPresetResult {
  id: SparkCuePreset;
  path: string;
  updated: boolean;
  contentDigest: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestFiles(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(path).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

export function assertSupportedDshPackage(dshPackageDir: string): void {
  const packagePath = join(dshPackageDir, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`spark web: cannot read installed DSH package metadata at ${packagePath}`, {
      cause: error,
    });
  }
  const record = parsed as { name?: unknown; version?: unknown };
  if (record.name !== "@deepseek-ai/dsh" || record.version !== SUPPORTED_DSH_VERSION) {
    throw new Error(
      `spark web: @zendev-lab/spark-web-dsh supports exactly @deepseek-ai/dsh@${SUPPORTED_DSH_VERSION}; found ${String(record.name)}@${String(record.version)}`,
    );
  }
}

function readVerifiedUpstream(dshPackageDir: string): Record<keyof typeof UPSTREAM_FILES, string> {
  const result = {} as Record<keyof typeof UPSTREAM_FILES, string>;
  for (const [relative, expected] of Object.entries(UPSTREAM_FILES)) {
    const path = join(dshPackageDir, "config", "agent-presets", relative);
    const content = readFileSync(path, "utf8");
    const actual = sha256(content);
    if (actual !== expected) {
      throw new Error(
        `spark web: DSH rc.7 preset source drift at ${path}; expected sha256 ${expected}, got ${actual}. Run the spark-web-dsh preset update workflow before continuing.`,
      );
    }
    result[relative as keyof typeof UPSTREAM_FILES] = content;
  }
  return result;
}

export function removeDshShellAndJobsRows(source: string): string {
  const lines = source.split("\n");
  const result: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const row = /^- id: (tool-bash|tool-pwsh|tool-jobs)$/u.exec(line);
    if (row) {
      skipping = true;
      continue;
    }
    if (skipping && /^- id: /u.test(line)) skipping = false;
    if (!skipping) result.push(line);
  }
  return result.join("\n");
}

export function addSparkCueSkillProvider(source: string, skillDir: string): string {
  const row = "- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'";
  const matches = source.split(row).length - 1;
  if (matches !== 1) {
    throw new Error(
      `spark web: expected one DSH skill-filesystem row while mounting ${skillDir}; found ${matches}`,
    );
  }
  return source.replace(
    row,
    [
      row,
      "",
      "- id: spark-cue-skill",
      "  name: '@deepseek-ai/dsh-skill-filesystem'",
      "  config:",
      "    providerName: spark-web-dsh",
      "    includeDefaultRoots: false",
      `    bundledSkillDir: ${JSON.stringify(skillDir)}`,
      "    watch: false",
    ].join("\n"),
  );
}

function managedMetadata(source: string, id: SparkCuePreset): string {
  const mode = id === "spark-standard" ? "标准" : "PTC";
  const description =
    id === "spark-standard"
      ? "Spark Cue-first 编码 Agent；命令、脚本和后台作业由 Cue 工具提供，不挂载 DSH Bash、Pwsh 或 Jobs 工具。"
      : "Spark Cue-first Code Mode Agent；通过生成的 SDK 使用 Cue 工具，不挂载 DSH Bash、Pwsh 或 Jobs 工具。";
  return source
    .replace(/^name:.*$/mu, `name: Spark ${mode}模式`)
    .replace(/^description:.*$/mu, `description: ${description}`);
}

function generatePreset(
  upstream: Record<keyof typeof UPSTREAM_FILES, string>,
  id: SparkCuePreset,
  skillDir: string,
): Record<"agent.cordis.yml" | "preset.yml", string> {
  const base: UpstreamPreset = id === "spark-standard" ? "standard" : "code";
  const composition = addSparkCueSkillProvider(
    removeDshShellAndJobsRows(upstream[`${base}/agent.cordis.yml`]),
    skillDir,
  );
  for (const forbidden of ["id: tool-bash", "id: tool-pwsh", "id: tool-jobs"]) {
    if (composition.includes(forbidden)) {
      throw new Error(`spark web: preset transformation failed to remove ${forbidden}`);
    }
  }
  return {
    "agent.cordis.yml": composition,
    "preset.yml": managedMetadata(upstream[`${base}/preset.yml`], id),
  };
}

function readMarker(path: string): ManagedMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ManagedMarker>;
    if (
      (value.owner !== MANAGED_OWNER && value.owner !== LEGACY_MANAGED_OWNER) ||
      typeof value.dshVersion !== "string" ||
      typeof value.sourceDigest !== "string" ||
      typeof value.contentDigest !== "string"
    ) {
      return undefined;
    }
    return value as ManagedMarker;
  } catch {
    return undefined;
  }
}

function installedContent(path: string): Record<string, string> {
  const expected = [MANAGED_MARKER, "agent.cordis.yml", "preset.yml"];
  const actual = readdirSync(path).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`managed preset has unexpected files: ${actual.join(", ")}`);
  }
  for (const name of expected) {
    const stats = lstatSync(join(path, name));
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`managed preset entry is not a regular file: ${name}`);
    }
  }
  return {
    "agent.cordis.yml": readFileSync(join(path, "agent.cordis.yml"), "utf8"),
    "preset.yml": readFileSync(join(path, "preset.yml"), "utf8"),
  };
}

function assertManagedTargetSafe(target: string): ManagedMarker | undefined {
  if (!existsSync(target)) return undefined;
  const targetStats = lstatSync(target);
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new Error(`spark web: refusing to overwrite non-directory preset ${target}`);
  }
  const marker = readMarker(join(target, MANAGED_MARKER));
  if (marker === undefined) {
    throw new Error(
      `spark web: refusing to overwrite unmarked preset ${target}; move it aside or migrate it to a different preset id`,
    );
  }
  let actual: string;
  try {
    actual = digestFiles(installedContent(target));
  } catch (error) {
    throw new Error(
      `spark web: refusing to overwrite user-modified managed preset ${target}; move or rename it, then retry`,
      { cause: error },
    );
  }
  if (actual !== marker.contentDigest) {
    throw new Error(
      `spark web: refusing to overwrite user-modified managed preset ${target}; move or rename it, then retry`,
    );
  }
  return marker;
}

function installOne(
  root: string,
  id: SparkCuePreset,
  files: Record<"agent.cordis.yml" | "preset.yml", string>,
  sourceDigest: string,
): ManagedPresetResult {
  const target = join(root, id);
  const contentDigest = digestFiles(files);
  const marker = assertManagedTargetSafe(target);
  if (marker !== undefined) {
    if (
      marker.owner === MANAGED_OWNER &&
      marker.dshVersion === SUPPORTED_DSH_VERSION &&
      marker.sourceDigest === sourceDigest &&
      marker.contentDigest === contentDigest
    ) {
      return { id, path: target, updated: false, contentDigest };
    }
  }

  mkdirSync(root, { recursive: true });
  const nonce = randomUUID();
  const staging = join(root, `.${id}.spark-staging-${process.pid}-${nonce}`);
  const backup = join(root, `.${id}.spark-backup-${process.pid}-${nonce}`);
  mkdirSync(staging);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(staging, name), content);
  const nextMarker: ManagedMarker = {
    owner: MANAGED_OWNER,
    dshVersion: SUPPORTED_DSH_VERSION,
    sourceDigest,
    contentDigest,
  };
  writeFileSync(join(staging, MANAGED_MARKER), `${JSON.stringify(nextMarker, null, 2)}\n`);

  let backedUp = false;
  try {
    if (existsSync(target)) {
      renameSync(target, backup);
      backedUp = true;
    }
    renameSync(staging, target);
    if (backedUp) rmSync(backup, { recursive: true });
  } catch (error) {
    if (!existsSync(target) && backedUp && existsSync(backup)) renameSync(backup, target);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { id, path: target, updated: true, contentDigest };
}

export function installManagedCuePresets(
  dshHome: string,
  dshPackageDir: string,
  skillDir: string,
): ManagedPresetResult[] {
  assertSupportedDshPackage(dshPackageDir);
  const skillPath = join(skillDir, "spark-cue", "SKILL.md");
  const skillStats = lstatSync(skillPath, { throwIfNoEntry: false });
  if (skillStats === undefined || !skillStats.isFile() || skillStats.isSymbolicLink()) {
    throw new Error(`spark web: bundled spark-cue Skill is not a regular file at ${skillPath}`);
  }
  const upstream = readVerifiedUpstream(dshPackageDir);
  const sourceDigest = digestFiles(upstream);
  const generated = SPARK_CUE_PRESETS.map((id) => ({
    id,
    files: generatePreset(upstream, id, skillDir),
  }));
  const root = join(dshHome, ".agent-presets");
  // Validate both targets before changing either one.
  for (const { id } of generated) assertManagedTargetSafe(join(root, id));
  return generated.map(({ id, files }) => installOne(root, id, files, sourceDigest));
}

export function verifyDshPresetSources(dshPackageDir: string): string {
  assertSupportedDshPackage(dshPackageDir);
  return digestFiles(readVerifiedUpstream(dshPackageDir));
}
