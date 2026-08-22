import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import type { SparkPaths } from "./paths.ts";

type ChannelPathRoots = Pick<SparkPaths, "configDir" | "dataDir" | "runtimeDir">;

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function channelConfigPath(paths: ChannelPathRoots): string {
  return join(paths.configDir, "channels.json");
}

export function channelRuntimeDir(paths: ChannelPathRoots): string {
  return join(paths.runtimeDir, "channels");
}

export function channelSessionWorkspacePath(
  paths: Pick<ChannelPathRoots, "dataDir">,
  sessionId: string,
): string {
  const safeId = validateChannelSessionId(sessionId);
  return join(paths.dataDir, "channels", "sessions", safeId, "workspace");
}

/** Create a daemon-owned Channel workspace without traversing links. */
export async function ensureChannelSessionWorkspace(
  paths: Pick<ChannelPathRoots, "dataDir">,
  sessionId: string,
): Promise<string> {
  assertSafeRoot(paths.dataDir);
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await assertDirectoryNotLink(paths.dataDir);
  await chmodPrivate(paths.dataDir);
  let current = resolve(paths.dataDir);
  for (const segment of [
    "channels",
    "sessions",
    validateChannelSessionId(sessionId),
    "workspace",
  ]) {
    current = join(current, segment);
    await mkdir(current, { recursive: true, mode: 0o700 });
    await assertDirectoryNotLink(current);
    await chmodPrivate(current);
  }
  return await validateChannelSessionWorkspace(paths, sessionId, current);
}

/** Revalidate the stored cwd immediately before every Channel execution. */
export async function validateChannelSessionWorkspace(
  paths: Pick<ChannelPathRoots, "dataDir">,
  sessionId: string,
  cwd = channelSessionWorkspacePath(paths, sessionId),
): Promise<string> {
  assertSafeRoot(paths.dataDir);
  const expected = resolve(channelSessionWorkspacePath(paths, sessionId));
  if (!isAbsolute(cwd) || resolve(cwd) !== expected) {
    throw new Error(`Channel Session ${sessionId} cwd does not match its daemon-private directory`);
  }
  await assertDirectoryNotLink(paths.dataDir);
  let current = resolve(paths.dataDir);
  for (const segment of [
    "channels",
    "sessions",
    validateChannelSessionId(sessionId),
    "workspace",
  ]) {
    current = join(current, segment);
    await assertDirectoryNotLink(current);
  }
  const root = await realpath(paths.dataDir);
  const candidate = await realpath(cwd);
  assertWithin(candidate, root, sessionId);
  return expected;
}

export function validateChannelSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!SAFE_SESSION_ID.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error("Channel Session id is not safe for daemon path derivation");
  }
  return normalized;
}

function assertSafeRoot(root: string): void {
  const normalized = resolve(root);
  if (!isAbsolute(root) || normalized === parse(normalized).root) {
    throw new Error("Channel data root must be an absolute non-root directory");
  }
}

async function assertDirectoryNotLink(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Channel path component must be a real directory: ${path}`);
  }
}

function assertWithin(candidate: string, root: string, sessionId: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Channel Session ${sessionId} cwd escaped its daemon data boundary`);
  }
}

async function chmodPrivate(path: string): Promise<void> {
  try {
    await chmod(path, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
