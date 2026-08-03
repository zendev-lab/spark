import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const FIXTURE_INPUTS = [
  "benchmarks/lens/tasks.json",
  "benchmarks/lens/fault-injections.json",
  "benchmarks/lens/fixtures",
] as const;

export async function lensFixtureDigest(root: string): Promise<string> {
  const paths: string[] = [];
  for (const input of FIXTURE_INPUTS) {
    await collectFiles(resolve(root, input), paths);
  }
  paths.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function collectFiles(path: string, output: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (!entries) {
    output.push(path);
    return;
  }
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await collectFiles(child, output);
    else if (entry.isFile()) output.push(child);
  }
}
