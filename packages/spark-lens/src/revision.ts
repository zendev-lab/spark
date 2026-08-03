import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkspaceRevision } from "./types.ts";

const EMPTY_DIGEST = createHash("sha256").digest("hex");

function digest(values: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function gitOutput(
  cwd: string,
  args: readonly string[],
  allowFailure = false,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 && !allowFailure) {
        reject(
          new Error(
            `git ${args.join(" ")} failed (${String(code)}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
  });
}

async function hashUntrackedFiles(workspaceRoot: string): Promise<string> {
  const output = await gitOutput(workspaceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const paths = output
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0) return EMPTY_DIGEST;

  const hash = createHash("sha256");
  for (const path of paths) {
    const absolutePath = resolve(workspaceRoot, path);
    const before = await lstat(absolutePath);
    if (!before.isFile()) continue;
    const content = await readFile(absolutePath);
    const after = await lstat(absolutePath);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      throw new Error(`untracked file changed while capturing Lens revision: ${path}`);
    }
    hash.update(path);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface CaptureWorkspaceRevisionOptions {
  workspaceRoot: string;
  profile: unknown;
  observedAt?: string;
}

export async function captureWorkspaceRevision(
  options: CaptureWorkspaceRevisionOptions,
): Promise<WorkspaceRevision> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const [head, trackedDiff, stagedDiff, untrackedContentDigest] = await Promise.all([
    gitOutput(workspaceRoot, ["rev-parse", "--verify", "HEAD"], true),
    gitOutput(workspaceRoot, ["diff", "--binary", "--no-ext-diff"]),
    gitOutput(workspaceRoot, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    hashUntrackedFiles(workspaceRoot),
  ]);
  const headOid = head.toString("utf8").trim() || null;
  const trackedDiffDigest = trackedDiff.length === 0 ? EMPTY_DIGEST : digest([trackedDiff]);
  const stagedDiffDigest = stagedDiff.length === 0 ? EMPTY_DIGEST : digest([stagedDiff]);
  const profileDigest = digest([stableJson(options.profile)]);
  const revisionDigest = digest([
    headOid ?? "unborn",
    trackedDiffDigest,
    stagedDiffDigest,
    untrackedContentDigest,
    profileDigest,
  ]);

  return {
    schemaVersion: 1,
    workspaceRoot,
    headOid,
    trackedDiffDigest,
    stagedDiffDigest,
    untrackedContentDigest,
    profileDigest,
    digest: revisionDigest,
    observedAt: options.observedAt ?? new Date().toISOString(),
  };
}

export async function isWorkspaceRevisionCurrent(
  revision: WorkspaceRevision,
  profile: unknown,
): Promise<boolean> {
  const current = await captureWorkspaceRevision({
    workspaceRoot: revision.workspaceRoot,
    profile,
  });
  return current.digest === revision.digest;
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
