/** Host-neutral Skill discovery and prompt rendering. */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";
import {
  defaultProjectResourceDirs,
  orderedSparkResourceRoots,
  type SparkResourceLayer,
} from "@zendev-lab/spark-system/resource-paths";
import {
  defaultBuiltinSkillsDir,
  defaultSparkCueSkillsDir,
  parseSkillFrontmatter,
  type SparkSkillFrontmatter,
} from "./builtin-skills.ts";

export { defaultBuiltinSkillsDir, defaultSparkCueSkillsDir, parseSkillFrontmatter };
export type { SparkSkillFrontmatter };

export type SparkSkillLayer = SparkResourceLayer;

export interface SparkSkill {
  name: string;
  description: string;
  /** First Markdown heading, retained as bounded routing metadata. */
  title?: string;
  filePath: string;
  baseDir: string;
  layer: SparkSkillLayer;
  disabled: boolean;
  disableModelInvocation: boolean;
  frontmatter: SparkSkillFrontmatter;
}

export interface SparkLoadedSkill {
  skill: SparkSkill;
  /** Complete SKILL.md source, including frontmatter. */
  content: string;
  /** Skill instructions without frontmatter. */
  body: string;
}

export interface SparkSkillDiagnostic {
  type: "warning" | "collision";
  message: string;
  path?: string;
  winnerPath?: string;
  loserPath?: string;
}

export interface SparkSkillResolverOptions {
  cwd: string;
  sparkHome?: string;
  builtinDirs?: string[];
  workspaceDir?: string;
  workspaceAgentsDirs?: string[];
  cwdDir?: string;
  userDir?: string;
  userAgentsDir?: string;
  skillDirs?: string[];
  /** Repository roots are opt-in for progressive agent focus. */
  repositorySkillDirs?: string[];
}

export interface SparkSkillResolveOptions {
  includeRepository?: boolean;
}

export interface SparkSkillResolveResult {
  skills: SparkSkill[];
  diagnostics: SparkSkillDiagnostic[];
}

export interface SparkSkillPromptMatch {
  skill: SparkSkill;
  /** Full source for explicit loads, or a bounded title for metadata-only matching. */
  content: string;
  /** False when content is routing metadata and must not be rendered as instructions. */
  promptBody?: boolean;
  score: number;
}

export class SparkSkillResolver {
  readonly cwd: string;
  readonly builtinDirs: string[];
  readonly workspaceDir: string;
  readonly workspaceAgentsDirs: string[];
  readonly cwdDir: string;
  readonly userDir: string;
  readonly userDirConfigured: boolean;
  readonly userAgentsDir: string;
  readonly configuredSkillDirs: string[];
  readonly repositorySkillDirs: string[];

  constructor(options: SparkSkillResolverOptions) {
    this.cwd = resolve(options.cwd);
    this.builtinDirs = options.builtinDirs?.map((dir) => resolvePath(dir, this.cwd)) ?? [
      defaultBuiltinSkillsDir(),
      defaultSparkCueSkillsDir(),
    ];
    this.workspaceDir = resolvePath(
      options.workspaceDir ?? join(this.cwd, ".spark", "skills"),
      this.cwd,
    );
    const projectDirs = defaultProjectAgentsSkillsDirs(this.cwd);
    this.workspaceAgentsDirs =
      options.workspaceAgentsDirs?.map((dir) => resolvePath(dir, this.cwd)) ?? [];
    this.cwdDir = resolvePath(
      options.cwdDir ?? projectDirs.at(-1) ?? join(this.cwd, ".agents", "skills"),
      this.cwd,
    );
    this.userDir = resolvePath(options.userDir ?? defaultUserAgentsSkillsDir(), this.cwd);
    this.userDirConfigured = options.userDir !== undefined;
    this.userAgentsDir = resolvePath(
      options.userAgentsDir ?? defaultUserAgentsSkillsDir(),
      this.cwd,
    );
    this.configuredSkillDirs = options.skillDirs?.map((dir) => resolvePath(dir, this.cwd)) ?? [];
    this.repositorySkillDirs =
      options.repositorySkillDirs?.map((dir) => resolvePath(dir, this.cwd)) ??
      projectDirs.slice(0, -1);
  }

  async resolve(options: SparkSkillResolveOptions = {}): Promise<SparkSkillResolveResult> {
    const diagnostics: SparkSkillDiagnostic[] = [];
    const skillsByName = new Map<string, SparkSkill>();
    const scannedDirs = new Set<string>();

    for (const layer of skillLayerSpecs(this, options)) {
      for (const entry of layer.dirs) {
        const dir = resolve(entry.path);
        if (scannedDirs.has(dir)) continue;
        scannedDirs.add(dir);
        const result = await loadSkillsFromDir(dir, layer.layer, {
          rootMarkdownAsSkill: entry.rootMarkdownAsSkill,
        });
        diagnostics.push(...result.diagnostics);
        for (const skill of result.skills) {
          if (skill.disabled) continue;
          const existing = skillsByName.get(skill.name);
          if (existing) {
            diagnostics.push({
              type: "collision",
              message: `skill "${skill.name}" from ${skill.layer} overrides ${existing.layer}`,
              path: skill.filePath,
              winnerPath: skill.filePath,
              loserPath: existing.filePath,
            });
          }
          skillsByName.set(skill.name, skill);
        }
      }
    }

    return { skills: [...skillsByName.values()], diagnostics };
  }

  async formatAvailableSkillsForPrompt(): Promise<string> {
    const { skills } = await this.resolve();
    return formatSparkSkillsForPrompt(skills);
  }

  async loadMatchingSkillsForPrompt(request: string, limit = 3): Promise<SparkSkillPromptMatch[]> {
    const { skills } = await this.resolve({ includeRepository: true });
    return matchSparkSkillsForPrompt(skills, request, limit);
  }

  async loadSkill(name: string): Promise<SparkLoadedSkill | undefined> {
    const { skills } = await this.resolve({ includeRepository: true });
    return loadSparkSkillByName(skills, name);
  }
}

export function defaultSparkSkillsRoot(_sparkHome?: string): string {
  return dirname(defaultUserAgentsSkillsDir());
}

export function defaultUserSkillsDir(_sparkHome?: string): string {
  return defaultUserAgentsSkillsDir();
}

/** Public cross-harness user skills directory; independent of SPARK_HOME. */
export function defaultUserAgentsSkillsDir(): string {
  return resolveSparkUserPaths().userAgentsSkillsDir;
}

/**
 * Project `.agents/skills` directories from `cwd` up to the git repository root
 * (or the filesystem root when not in a repo). Outermost-first ordering lets
 * the directory closest to `cwd` win name collisions.
 */
export function defaultProjectAgentsSkillsDirs(cwd: string): string[] {
  return defaultProjectResourceDirs(cwd, "skills");
}

export async function loadSkillsFromDir(
  dir: string,
  layer: SparkSkillLayer,
  options: { rootMarkdownAsSkill?: boolean } = {},
): Promise<SparkSkillResolveResult> {
  const skills: SparkSkill[] = [];
  const diagnostics: SparkSkillDiagnostic[] = [];
  await scanSkillDir(resolve(dir), layer, options.rootMarkdownAsSkill ?? true, skills, diagnostics);
  return { skills, diagnostics };
}

export function formatSparkSkillsForPrompt(skills: readonly SparkSkill[]): string {
  const visible = modelInvocableSkills(skills);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions or intelligent execution for specific tasks.",
    "When a skill matches, choose exactly one primary path:",
    "- If skill_delegate is active, call it with a self-contained instruction to let a fresh Worker load and execute the Skill without requiring this session to execute it.",
    "- Use read on the listed file only when this session itself must inspect and follow the skill instructions.",
    "Do not explicitly read a Skill before delegating it. Resolve relative references against the listed Skill directory.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function matchSparkSkillsForPrompt(
  skills: readonly SparkSkill[],
  request: string,
  limit = 3,
): SparkSkillPromptMatch[] {
  return modelInvocableSkills(skills)
    .map((skill) => ({
      skill,
      content: skill.title ?? "",
      promptBody: false,
      score: scoreSkillMatch(skill, request),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(0, limit));
}

/** Explicit body-loading variant for callers that intend to follow Skill instructions. */
export async function loadMatchingSparkSkillsForPrompt(
  skills: readonly SparkSkill[],
  request: string,
  limit = 3,
): Promise<SparkSkillPromptMatch[]> {
  return Promise.all(
    matchSparkSkillsForPrompt(skills, request, limit).map(async (match) => ({
      ...match,
      content: await readFile(match.skill.filePath, "utf8"),
      promptBody: true,
    })),
  );
}

export async function loadSparkSkillByName(
  skills: readonly SparkSkill[],
  name: string,
): Promise<SparkLoadedSkill | undefined> {
  const normalized = name.trim();
  const skill = modelInvocableSkills(skills).find((candidate) => candidate.name === normalized);
  if (!skill) return undefined;
  const content = await readFile(skill.filePath, "utf8");
  const { body } = parseSkillFrontmatter(content);
  return { skill, content, body };
}

/**
 * Render request-matched Skill metadata as dynamic routing context. A caller
 * may also pass explicitly loaded bodies, but native request matching remains
 * metadata-only so the parent can choose between read and skill_delegate.
 */
export function formatSelectedSparkSkillsForPrompt(
  matches: readonly SparkSkillPromptMatch[],
): string {
  if (matches.length === 0) return "";
  const hasLoadedBodies = matches.some(
    (match) => match.promptBody !== false && match.content.length > 0,
  );
  const lines = [
    "Dynamic context checkpoint: matching skills for current user request.",
    hasLoadedBodies
      ? "Some Skill bodies were explicitly loaded by the caller. Follow only those loaded instructions when relevant."
      : "Skill bodies are not loaded. Choose one primary path: call skill_delegate for a self-contained unit of work, or read SKILL.md when this session itself must follow it.",
    "Do not explicitly read and delegate the same Skill by default.",
    "<selected_skills>",
  ];
  for (const match of matches) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(match.skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(match.skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(match.skill.filePath)}</location>`);
    if (match.promptBody !== false && match.content.length > 0) {
      lines.push("    <content>");
      for (const contentLine of match.content.replace(/\r\n?/gu, "\n").split("\n")) {
        lines.push(`      ${contentLine}`);
      }
      lines.push("    </content>");
    } else if (match.content.length > 0) {
      lines.push(`    <title>${escapeXml(match.content)}</title>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</selected_skills>");
  return lines.join("\n");
}

function modelInvocableSkills(skills: readonly SparkSkill[]): SparkSkill[] {
  return skills.filter((skill) => !skill.disabled && !skill.disableModelInvocation);
}

async function scanSkillDir(
  dir: string,
  layer: SparkSkillLayer,
  includeRootMarkdownFiles: boolean,
  skills: SparkSkill[],
  diagnostics: SparkSkillDiagnostic[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ type: "warning", message: errorMessage(error), path: dir });
    }
    return;
  }

  const skillFile = entries.find((entry) => entry.name === "SKILL.md");
  if (skillFile) {
    const filePath = join(dir, skillFile.name);
    if (await isFileLike(filePath, skillFile)) {
      const loaded = await loadSkillFromFile(filePath, layer);
      if (loaded.skill) skills.push(loaded.skill);
      diagnostics.push(...loaded.diagnostics);
      return;
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    if (await isDirectoryLike(fullPath, entry)) {
      await scanSkillDir(fullPath, layer, false, skills, diagnostics);
      continue;
    }
    if (!includeRootMarkdownFiles || !entry.name.endsWith(".md")) continue;
    if (!(await isFileLike(fullPath, entry))) continue;
    const loaded = await loadSkillFromFile(fullPath, layer);
    if (loaded.skill) skills.push(loaded.skill);
    diagnostics.push(...loaded.diagnostics);
  }
}

async function loadSkillFromFile(
  filePath: string,
  layer: SparkSkillLayer,
): Promise<{ skill?: SparkSkill; diagnostics: SparkSkillDiagnostic[] }> {
  const diagnostics: SparkSkillDiagnostic[] = [];
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return { diagnostics: [{ type: "warning", message: errorMessage(error), path: filePath }] };
  }

  const { frontmatter, body } = parseSkillFrontmatter(raw);
  const description = stringField(frontmatter.description);
  if (!description) {
    diagnostics.push({ type: "warning", message: "description is required", path: filePath });
    return { diagnostics };
  }

  const baseDir = dirname(filePath);
  const name = stringField(frontmatter.name) ?? basename(baseDir).toLowerCase();
  if (!isValidSkillName(name)) {
    diagnostics.push({
      type: "warning",
      message: `skill name "${name}" should use lowercase letters, digits, and hyphens`,
      path: filePath,
    });
  }

  return {
    skill: {
      name,
      description,
      title: firstMarkdownHeading(body),
      filePath,
      baseDir,
      layer,
      disabled: frontmatter.disabled === true,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      frontmatter,
    },
    diagnostics,
  };
}

function firstMarkdownHeading(body: string): string | undefined {
  for (const line of body.replace(/\r\n?/gu, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (!heading) continue;
    const title = heading[2]?.trim();
    return title ? `${heading[1]} ${title}` : undefined;
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && name.length <= 64;
}

function scoreSkillMatch(skill: SparkSkill, request: string): number {
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  const requestText = request.toLowerCase();
  const requestTerms = skillSearchTerms(requestText);
  const descriptionWords = new Set(asciiSearchWords(description));
  const nameWords = new Set(asciiSearchWords(name));
  let score = 0;

  if (containsDelimitedName(requestText, name)) score += 12;
  for (const word of requestTerms.ascii) {
    if (nameWords.has(word)) score += 4;
    if (!COMMON_ASCII_SKILL_TERMS.has(word) && descriptionWords.has(word)) score += 1;
  }

  const matchedCjkTerms = requestTerms.cjk.filter((term) => description.includes(term.value));
  const longCjkTerms = matchedCjkTerms.filter((term) => term.size >= 3);
  if (longCjkTerms.length > 0) {
    score += Math.max(...longCjkTerms.map((term) => term.size));
  } else {
    const distinctBigrams = new Set(
      matchedCjkTerms
        .filter((term) => term.size === 2 && !COMMON_CJK_SKILL_BIGRAMS.has(term.value))
        .map((term) => term.value),
    );
    if (distinctBigrams.size >= 2) score += distinctBigrams.size;
  }

  return score;
}

interface SkillSearchTerm {
  value: string;
  size: number;
}

interface SkillSearchTerms {
  ascii: Set<string>;
  cjk: SkillSearchTerm[];
}

const COMMON_ASCII_SKILL_TERMS = new Set([
  "app",
  "apps",
  "code",
  "file",
  "files",
  "read",
  "tool",
  "tools",
  "use",
  "user",
  "users",
  "write",
]);

const COMMON_CJK_SKILL_BIGRAMS = new Set([
  "代码",
  "功能",
  "工具",
  "工作",
  "进行",
  "使用",
  "适用",
  "文件",
  "相关",
  "用户",
  "需要",
  "任务",
  "项目",
  "操作",
]);

function skillSearchTerms(request: string): SkillSearchTerms {
  const ascii = new Set<string>();
  const cjkTerms = new Map<string, SkillSearchTerm>();
  let current = "";
  let cjk = "";
  const flushAscii = () => {
    if (current.length >= 3) ascii.add(current);
    current = "";
  };
  const flushCjk = () => {
    const chars = Array.from(cjk);
    if (chars.length >= 2) {
      const maxGram = Math.min(4, chars.length);
      for (let size = 2; size <= maxGram; size += 1) {
        for (let index = 0; index + size <= chars.length; index += 1) {
          const value = chars.slice(index, index + size).join("");
          cjkTerms.set(`${size}:${value}`, { value, size });
        }
      }
    }
    cjk = "";
  };

  for (const char of request.toLowerCase()) {
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-") {
      flushCjk();
      current += char;
    } else if (isCjkSearchCharacter(char)) {
      flushAscii();
      cjk += char;
    } else {
      flushAscii();
      flushCjk();
    }
  }
  flushAscii();
  flushCjk();
  return { ascii, cjk: [...cjkTerms.values()] };
}

function asciiSearchWords(value: string): string[] {
  return value.split(/[^a-z0-9]+/u).filter((word) => word.length >= 3);
}

function containsDelimitedName(request: string, name: string): boolean {
  if (!name) return false;
  const index = request.indexOf(name);
  if (index < 0) return false;
  const before = request[index - 1];
  const after = request[index + name.length];
  return !isAsciiNameCharacter(before) && !isAsciiNameCharacter(after);
}

function isAsciiNameCharacter(value: string | undefined): boolean {
  return value !== undefined && /[a-z0-9-]/u.test(value);
}

function isCjkSearchCharacter(char: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
}

interface SkillDirSpec {
  path: string;
  rootMarkdownAsSkill: boolean;
}

function skillLayerSpecs(
  resolver: SparkSkillResolver,
  options: SparkSkillResolveOptions,
): Array<{ layer: SparkSkillLayer; dirs: SkillDirSpec[] }> {
  const userDirs = resolver.userDirConfigured
    ? [{ path: resolver.userDir, rootMarkdownAsSkill: true }]
    : [{ path: resolver.userAgentsDir, rootMarkdownAsSkill: false }];
  const roots = orderedSparkResourceRoots({
    builtin: resolver.builtinDirs,
    user: userDirs.map((entry) => entry.path),
    workspace: [resolver.workspaceDir, ...resolver.workspaceAgentsDirs],
    cwd: [resolver.cwdDir],
    configured: resolver.configuredSkillDirs,
    repository: options.includeRepository ? resolver.repositorySkillDirs : [],
  });
  const rootMarkdownAsSkill = new Map<string, boolean>([
    ...resolver.builtinDirs.map((path) => [path, true] as const),
    ...userDirs.map((entry) => [entry.path, entry.rootMarkdownAsSkill] as const),
    [resolver.workspaceDir, true],
    ...resolver.workspaceAgentsDirs.map((path) => [path, false] as const),
    [resolver.cwdDir, false],
    ...resolver.configuredSkillDirs.map((path) => [path, true] as const),
    ...resolver.repositorySkillDirs.map((path) => [path, false] as const),
  ]);
  return roots.map(({ layer, path }) => ({
    layer,
    dirs: [{ path, rootMarkdownAsSkill: rootMarkdownAsSkill.get(path) ?? false }],
  }));
}

async function isFileLike(
  path: string,
  entry: { isFile(): boolean; isSymbolicLink(): boolean },
): Promise<boolean> {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectoryLike(
  path: string,
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function resolvePath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
