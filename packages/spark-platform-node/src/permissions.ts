import { chmodSync, closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SparkPaths } from "./paths.js";

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function ensurePublicDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o755 });
}

export function ensureSparkPathDirs(paths: SparkPaths): void {
  ensurePrivateDir(paths.configDir);
  ensurePrivateDir(paths.dataDir);
  ensurePublicDir(paths.cacheDir);
  ensurePrivateDir(paths.stateDir);
  ensurePrivateDir(paths.runtimeDir);
  ensurePrivateDir(paths.logDir);
}

export function writePrivateFile(path: string, contents: string): void {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function touchPrivateFile(path: string): void {
  ensurePrivateDir(dirname(path));
  if (!existsSync(path)) {
    closeSync(openSync(path, "w", 0o600));
  }
  chmodSync(path, 0o600);
}
