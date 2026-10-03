import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "../..");
export const suiteRoot = join(repositoryRoot, "experiments/strategy-v1");

export interface Task {
  id: string;
  split: "development" | "holdout";
  sourceCommit: string;
  repository: string;
  path: string;
  prompt: string;
  regressions: Array<{ fixed: string; broken: string }>;
}

export interface TestCase {
  id: string;
  visibility: "public" | "hidden";
  input: Record<string, unknown>;
  expected: unknown;
}

export interface Budget {
  modelCalls: number;
  toolCalls: number;
  totalTokens: number;
  maxOutputTokens: number;
  maxRequestBytes: number;
  wallTimeMs: number;
  maxEstimatedCostUsd: number;
}

export interface Protocol {
  schema: "spark.strategy-protocol/v1";
  model: string;
  reasoning: "low";
  temperature: number | null;
  maxRetries: number;
  repetitions: number;
  maxCandidates: number;
  budget: Budget;
  generatorBudget: Budget;
  maxExperimentEstimatedCostUsd: number;
  baselineStrategy: string;
  candidateMaxChars: number;
  selection: Record<string, string>;
  isolation: Record<string, string>;
  scope: string;
  cost: string;
}

export interface Suite {
  baseCommit: string;
  tasks: Task[];
  cases: Record<string, TestCase[]>;
  protocol: Protocol;
  digest: string;
}

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

export async function loadSuite(): Promise<Suite> {
  const paths = ["tasks.json", "cases.json", "protocol.json"];
  const contents = await Promise.all(paths.map((path) => readFile(join(suiteRoot, path), "utf8")));
  const tasks = JSON.parse(contents[0]!) as { baseCommit: string; tasks: Task[] };
  const cases = JSON.parse(contents[1]!) as Record<string, TestCase[]>;
  const protocol = JSON.parse(contents[2]!) as Protocol;
  if (protocol.schema !== "spark.strategy-protocol/v1") throw new Error("Unsupported protocol");
  if (!/^[0-9a-f]{40}$/u.test(tasks.baseCommit))
    throw new Error("Task base must be an exact commit");
  if (new Set(tasks.tasks.map((task) => task.id)).size !== tasks.tasks.length)
    throw new Error("Duplicate task identity");
  for (const task of tasks.tasks) {
    if (
      !cases[task.id]?.some((entry) => entry.visibility === "public") ||
      !cases[task.id]?.some((entry) => entry.visibility === "hidden")
    )
      throw new Error(`Task ${task.id} needs public and independent hidden cases`);
    if (new Set(cases[task.id]!.map((entry) => entry.id)).size !== cases[task.id]!.length)
      throw new Error(`Duplicate case in ${task.id}`);
  }
  return { ...tasks, cases, protocol, digest: digest(JSON.stringify(contents)) };
}

export function git(...args: string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  }).trimEnd();
}

/** The task snapshot has no Git history, tests, runtime state, or experiment files. */
export function isTaskSource(path: string): boolean {
  return (
    /^(?:apps|packages)\//u.test(path) &&
    !/(?:^|\/)(?:test|tests|__tests__|testing|test-support|fixtures|snapshots|node_modules)\//u.test(
      path,
    ) &&
    !/\.(?:test|spec)\.[cm]?[jt]s$/u.test(path) &&
    /\.(?:[cm]?[jt]s|json|md|svelte)$/u.test(path)
  );
}

export function isEditableSource(path: string): boolean {
  return (
    isTaskSource(path) &&
    /\/src\/.*\.ts$/u.test(path) &&
    !/\.d\.ts$/u.test(path) &&
    !/\.config\.ts$/u.test(path)
  );
}

export function applyRegressions(content: string, task: Task): string {
  for (const { fixed, broken } of task.regressions) {
    if (content.indexOf(fixed) < 0 || content.indexOf(fixed) !== content.lastIndexOf(fixed))
      throw new Error(`Regression no longer applies uniquely: ${task.id}`);
    content = content.replace(fixed, broken);
  }
  return content;
}

export async function materializeSources(root: string, suite: Suite, fixed = false) {
  await mkdir(root, { recursive: false });
  const files = git("ls-tree", "-r", "--name-only", suite.baseCommit)
    .split("\n")
    .filter(isTaskSource);
  const entries: Array<[string, string]> = [];
  for (const path of files) {
    // Git object reads, not the implementation worktree, own benchmark source identity.
    let content = execFileSync(
      "git",
      ["-C", repositoryRoot, "show", `${suite.baseCommit}:${path}`],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (!fixed)
      for (const task of suite.tasks.filter((entry) => entry.path === path))
        content = applyRegressions(content, task);
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    entries.push([path, digest(content)]);
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  entries.push(["package.json", digest('{"type":"module"}\n')]);
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

export async function fileInventory(root: string): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  async function visit(path: string) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) entries.push([child, digest(await readFile(join(root, child)))]);
      else throw new Error(`Nonregular snapshot entry: ${child}`);
    }
  }
  await visit("");
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

export function within(root: string, path: string): boolean {
  const local = relative(root, path);
  return (
    local === "" ||
    (!isAbsolute(local) &&
      local !== ".." &&
      !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

export async function fencedPath(root: string, path: unknown, write = false): Promise<string> {
  if (typeof path !== "string" || isAbsolute(path) || path.includes("\0"))
    throw new Error("Use a relative snapshot path");
  const resolved = resolve(root, path);
  if (!within(root, resolved)) throw new Error("Path escapes the task snapshot");
  const canonical = await realpath(resolved);
  const canonicalRoot = await realpath(root);
  if (!within(canonicalRoot, canonical)) throw new Error("Symlink escapes the task snapshot");
  if (write && !isEditableSource(relative(canonicalRoot, canonical)))
    throw new Error("Only existing production TypeScript source can be edited");
  return relative(canonicalRoot, canonical) || ".";
}

export function outputDirectory(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(name)) throw new Error("Use a simple experiment name");
  return join(repositoryRoot, "reports/strategy-experiments", name);
}
