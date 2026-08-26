/**
 * Spark-managed DSH agent presets.
 *
 * The preset compositions are static files versioned with this package under
 * `presets/agent-presets/<id>/` — no upstream snapshot digest, no runtime
 * transform. Boot installs them into the DSH user preset root
 * (`$DSH_HOME/.agent-presets`) with exactly one machine-local substitution:
 * the absolute path of the package-owned `cue` Skill directory, which only
 * exists after the package manager lays down `@zendev-lab/cue`.
 *
 * Why the user root and not a package root: the supported DSH release's
 * `composeProfile` force-appends `roots: [<dsh package>/config/agent-presets]`
 * after every patch overlay, so an overlay can set `default` and
 * `includeUserRoot` but never replace the discovery roots. The shipped root
 * is shared with the `dsh` CLI profile and must not be mutated, and a
 * user-root preset cannot shadow a shipped id (earlier root wins), which is
 * why the Spark presets keep their `spark-` prefix.
 *
 * Installed presets carry a `.spark-managed.json` marker recording the owner,
 * the DSH release, and the source/content digests. A directory without a
 * valid marker, or whose content drifted from its marker, is user data: it is
 * never overwritten or deleted, only reported.
 */
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MANAGED_CUE_PRESETS = ["spark-standard", "spark-ptc"] as const;

/** Retired Spark-managed ids, removed from the user root once provably untouched. */
export const LEGACY_MANAGED_CUE_PRESETS = ["spark-code"] as const;

type ManagedCuePreset = (typeof MANAGED_CUE_PRESETS)[number];

const MANAGED_MARKER = ".spark-managed.json";
const MANAGED_OWNER = "@zendev-lab/spark-web-dsh";
const LEGACY_MANAGED_OWNER = "@zendev-lab/dsh-tool-cue";

/** The one machine-local value substituted at install time. */
const SKILL_DIR_PLACEHOLDER = 'bundledSkillDir: ""';

/** Display names the packaged metadata must publish, keyed by preset id. */
const EXPECTED_PRESET_NAMES: Record<ManagedCuePreset, string> = {
  "spark-standard": "Spark Standard",
  "spark-ptc": "Spark PTC",
};

/** Rows the Cue-first compositions must never carry. */
const FORBIDDEN_ROWS = ["id: tool-bash", "id: tool-pwsh", "id: tool-jobs"] as const;

/** The Spark file-tool adapter the preset's tool-fs row must name. */
const TOOL_FS_SPECIFIER = "../../profiles/web/plugins/spark-files/index.mjs";

interface ManagedMarker {
  owner: typeof MANAGED_OWNER | typeof LEGACY_MANAGED_OWNER;
  dshVersion: string;
  sourceDigest: string;
  contentDigest: string;
}

export interface ManagedPresetResult {
  id: ManagedCuePreset;
  path: string;
  updated: boolean;
  contentDigest: string;
}

export interface RetiredPresetResult {
  id: string;
  path: string;
  removed: boolean;
  /** Why a surviving directory was left alone. */
  reason?: "unmarked" | "modified" | "not-a-directory";
}

/** The packaged preset source root versioned with this package. */
export function sparkPresetSourceRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "presets", "agent-presets");
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

export function readDshPackageVersion(dshPackageDir: string): string {
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
  if (record.name !== "@deepseek-ai/dsh") {
    throw new Error(
      `spark web: expected installed @deepseek-ai/dsh package metadata; found ${String(record.name)}`,
    );
  }
  if (typeof record.version !== "string" || record.version.trim() === "") {
    throw new Error("spark web: installed @deepseek-ai/dsh package has no version");
  }
  return record.version;
}

/** Read one packaged preset, filling in the machine-local cue Skill directory. */
function readPackagedPreset(
  root: string,
  id: ManagedCuePreset,
  skillDir: string,
): { files: Record<"agent.cordis.yml" | "preset.yml", string>; sourceDigest: string } {
  const dir = join(root, id);
  let composition: string;
  let metadata: string;
  try {
    composition = readFileSync(join(dir, "agent.cordis.yml"), "utf8");
    metadata = readFileSync(join(dir, "preset.yml"), "utf8");
  } catch (error) {
    throw new Error(`spark web: packaged preset ${id} is incomplete under ${dir}`, {
      cause: error,
    });
  }
  const placeholders = composition.split(SKILL_DIR_PLACEHOLDER).length - 1;
  if (placeholders !== 1) {
    throw new Error(
      `spark web: expected one cue Skill placeholder in ${dir}/agent.cordis.yml; found ${placeholders}`,
    );
  }
  // The source digest identifies the package revision alone; the installed
  // content additionally carries the machine-local Skill directory.
  const sourceDigest = digestFiles({
    "agent.cordis.yml": composition,
    "preset.yml": metadata,
  });
  return {
    files: {
      "agent.cordis.yml": composition.replace(
        SKILL_DIR_PLACEHOLDER,
        `bundledSkillDir: ${JSON.stringify(skillDir)}`,
      ),
      "preset.yml": metadata,
    },
    sourceDigest,
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

/**
 * The marker-owned-and-unmodified verdict shared by install and retirement.
 * Returns the marker when the directory is a provably untouched Spark-managed
 * install, and `undefined` for anything that could be user data.
 */
function untouchedManagedMarker(target: string): ManagedMarker | undefined {
  if (!existsSync(target)) return undefined;
  const targetStats = lstatSync(target);
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) return undefined;
  const marker = readMarker(join(target, MANAGED_MARKER));
  if (marker === undefined) return undefined;
  let actual: string;
  try {
    actual = digestFiles(installedContent(target));
  } catch {
    return undefined;
  }
  return actual === marker.contentDigest ? marker : undefined;
}

function assertManagedTargetSafe(target: string): ManagedMarker | undefined {
  if (!existsSync(target)) return undefined;
  const marker = untouchedManagedMarker(target);
  if (marker !== undefined) return marker;
  const targetStats = lstatSync(target);
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new Error(`spark web: refusing to overwrite non-directory preset ${target}`);
  }
  if (readMarker(join(target, MANAGED_MARKER)) === undefined) {
    throw new Error(
      `spark web: refusing to overwrite unmarked preset ${target}; move it aside or migrate it to a different preset id`,
    );
  }
  throw new Error(
    `spark web: refusing to overwrite user-modified managed preset ${target}; move or rename it, then retry`,
  );
}

function installOne(
  root: string,
  id: ManagedCuePreset,
  files: Record<"agent.cordis.yml" | "preset.yml", string>,
  dshVersion: string,
  sourceDigest: string,
): ManagedPresetResult {
  const target = join(root, id);
  const contentDigest = digestFiles(files);
  const marker = assertManagedTargetSafe(target);
  if (marker !== undefined) {
    if (
      marker.owner === MANAGED_OWNER &&
      marker.dshVersion === dshVersion &&
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
    dshVersion,
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
  const dshVersion = readDshPackageVersion(dshPackageDir);
  const skillPath = join(skillDir, "cue", "SKILL.md");
  const skillStats = lstatSync(skillPath, { throwIfNoEntry: false });
  if (skillStats === undefined || !skillStats.isFile() || skillStats.isSymbolicLink()) {
    throw new Error(`spark web: bundled cue Skill is not a regular file at ${skillPath}`);
  }
  const sourceRoot = sparkPresetSourceRoot();
  const generated = MANAGED_CUE_PRESETS.map((id) => ({
    id,
    ...readPackagedPreset(sourceRoot, id, skillDir),
  }));
  const root = join(dshHome, ".agent-presets");
  // Validate both targets before changing either one.
  for (const { id } of generated) assertManagedTargetSafe(join(root, id));
  return generated.map(({ id, files, sourceDigest }) =>
    installOne(root, id, files, dshVersion, sourceDigest),
  );
}

/**
 * Remove generated preset ids retired by Spark. Only a directory carrying a
 * valid Spark marker AND byte-identical content is deleted; an unmarked,
 * modified, or non-directory entry is user data and is reported, not touched.
 * Session logs are separate state and are never read here.
 */
export function retireLegacyManagedCuePresets(dshHome: string): RetiredPresetResult[] {
  const root = join(dshHome, ".agent-presets");
  const results: RetiredPresetResult[] = [];
  for (const id of LEGACY_MANAGED_CUE_PRESETS) {
    const path = join(root, id);
    if (!existsSync(path)) continue;
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      results.push({ id, path, removed: false, reason: "not-a-directory" });
      continue;
    }
    if (readMarker(join(path, MANAGED_MARKER)) === undefined) {
      results.push({ id, path, removed: false, reason: "unmarked" });
      continue;
    }
    if (untouchedManagedMarker(path) === undefined) {
      results.push({ id, path, removed: false, reason: "modified" });
      continue;
    }
    rmSync(path, { recursive: true });
    results.push({ id, path, removed: true });
  }
  return results;
}

/**
 * Structurally verify the packaged preset sources: both managed ids are
 * present with complete metadata, the compositions carry the Cue-first deltas
 * (no DSH shell or job rows, one-shot delegation, the Spark file-tool row,
 * exactly one cue Skill placeholder), and every referenced `@deepseek-ai/*`
 * plugin also appears in the packaged upstream fixture for the supported DSH
 * release. Returns the source digest for logging.
 */
export function verifySparkPresetSources(root: string = sparkPresetSourceRoot()): string {
  const actual = existsSync(root)
    ? readdirSync(root).filter((name) => {
        const stats = lstatSync(join(root, name));
        return stats.isDirectory() && !stats.isSymbolicLink();
      })
    : [];
  const expected = [...MANAGED_CUE_PRESETS].sort();
  if (actual.sort().join(",") !== expected.join(",")) {
    throw new Error(
      `spark web: packaged preset root ${root} must hold exactly ${expected.join(", ")}; found ${actual.join(", ") || "none"}`,
    );
  }
  const fixtureNames = new Set<string>();
  const fixtureRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "presets",
    "upstream-package",
    "config",
    "agent-presets",
  );
  for (const fixture of readdirSync(fixtureRoot)) {
    const composition = readFileSync(join(fixtureRoot, fixture, "agent.cordis.yml"), "utf8");
    for (const match of composition.matchAll(/name: ["'](@deepseek-ai\/[^"']+)["']/gu)) {
      fixtureNames.add(match[1]!);
    }
  }
  const sources: Record<string, string> = {};
  for (const id of MANAGED_CUE_PRESETS) {
    const dir = join(root, id);
    const composition = readFileSync(join(dir, "agent.cordis.yml"), "utf8");
    const metadata = readFileSync(join(dir, "preset.yml"), "utf8");
    if (!new RegExp(`^name: ${EXPECTED_PRESET_NAMES[id]}$`, "mu").test(metadata)) {
      throw new Error(`spark web: preset ${id} must publish name "${EXPECTED_PRESET_NAMES[id]}"`);
    }
    if (!/^description: .+$/mu.test(metadata)) {
      throw new Error(`spark web: preset ${id} must publish a description`);
    }
    for (const forbidden of FORBIDDEN_ROWS) {
      if (composition.includes(forbidden)) {
        throw new Error(`spark web: preset ${id} must not mount ${forbidden}`);
      }
    }
    if (composition.includes("backgroundMode: continuable")) {
      throw new Error(`spark web: preset ${id} must map delegation tools to one-shot`);
    }
    if (!composition.includes(`name: "${TOOL_FS_SPECIFIER}"`)) {
      throw new Error(`spark web: preset ${id} must name the Spark file-tool adapter`);
    }
    const placeholders = composition.split(SKILL_DIR_PLACEHOLDER).length - 1;
    if (placeholders !== 1) {
      throw new Error(
        `spark web: preset ${id} must carry exactly one cue Skill placeholder; found ${placeholders}`,
      );
    }
    if (!composition.includes("providerName: spark-web-dsh")) {
      throw new Error(`spark web: preset ${id} must mount the package-owned cue Skill`);
    }
    for (const match of composition.matchAll(/name: ["'](@deepseek-ai\/[^"']+)["']/gu)) {
      if (!fixtureNames.has(match[1]!)) {
        throw new Error(
          `spark web: preset ${id} references ${match[1]}, which the supported DSH release's presets never reference; verify the plugin exists in the installed DSH package`,
        );
      }
    }
    sources[`${id}/agent.cordis.yml`] = composition;
    sources[`${id}/preset.yml`] = metadata;
  }
  return digestFiles(sources);
}
