import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SparkDaemonFingerprintOptions {
  /** Workspace root used by source checkouts; deployment fingerprints ignore it. */
  sourceRoot?: string;
}

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const SOURCE_PACKAGE_DIRS = ["apps/spark-daemon"];

export interface SparkDaemonBuildChange {
  previousFingerprint: string;
  nextFingerprint: string;
}

export function sparkDaemonEntrypointPath(
  argv: readonly string[] = process.argv,
  fallbackUrl = import.meta.url,
): string {
  return realpathSync(sparkDaemonDeploymentEntrypointPath(argv, fallbackUrl));
}

export function sparkDaemonDeploymentEntrypointPath(
  argv: readonly string[] = process.argv,
  fallbackUrl = import.meta.url,
  env: Record<string, string | undefined> = process.env,
): string {
  const configuredPath = env.SPARK_DEPLOYMENT_WATCH_PATH?.trim();
  if (configuredPath) return resolve(configuredPath);

  const entrypoint = resolve(argv[1] || fileURLToPath(fallbackUrl));
  const workspaceRoot = findWorkspaceRoot(entrypoint);
  if (workspaceRoot) {
    const relativeEntrypoint = relative(workspaceRoot, entrypoint);
    if (relativeEntrypoint === join("apps", "spark-cli", "src", "cli.ts")) {
      return join(workspaceRoot, "apps", "spark-daemon", "src", "cli.ts");
    }
  }
  return entrypoint;
}

export function sparkDaemonEntrypointFingerprint(
  entrypoint = sparkDaemonEntrypointPath(),
  options: SparkDaemonFingerprintOptions = {},
): string {
  const sourceRoot = options.sourceRoot ?? sourceWorkspaceRoot(entrypoint);
  if (sourceRoot) return sparkDaemonSourceFingerprint(sourceRoot);

  const content = readFileSync(entrypoint);
  try {
    const build = JSON.parse(content.toString("utf8")) as { fingerprint?: unknown };
    if (typeof build.fingerprint === "string" && /^sha256:[0-9a-f]{64}$/u.test(build.fingerprint)) {
      return build.fingerprint;
    }
  } catch {
    // Source entrypoints outside a workspace are fingerprinted as bytes below.
  }
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * Fingerprint runtime source and workspace manifests for source checkouts.
 *
 * A source daemon loads workspace-linked modules directly, so hashing only
 * `src/cli.ts` can leave its ESM graph stale after a dependency rename. The
 * content fingerprint is intentionally limited to runtime source and manifests;
 * tests, declarations, docs, and generated output are excluded.
 */
export function sparkDaemonSourceFingerprint(sourceRoot: string): string {
  const resolvedRoot = resolve(sourceRoot);
  const hash = createHash("sha256");
  for (const file of sourceFingerprintFiles(resolvedRoot)) {
    try {
      hash.update(`${relative(resolvedRoot, file)}\0`);
      hash.update(readFileSync(file));
      hash.update("\n");
    } catch {
      // A concurrent atomic replacement is observed on the next poll.
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function sourceWorkspaceRoot(entrypoint: string): string | undefined {
  if (!SOURCE_EXTENSIONS.has(extension(entrypoint))) return undefined;
  const root = findWorkspaceRoot(entrypoint);
  if (!root) return undefined;
  const sourcePath = relative(root, resolve(entrypoint));
  return sourcePath === join("apps", "spark-daemon", "src", "cli.ts") ? root : undefined;
}

function findWorkspaceRoot(entrypoint: string): string | undefined {
  let current = resolve(dirname(entrypoint));
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function sourceFingerprintFiles(sourceRoot: string): string[] {
  const files = [join(sourceRoot, "package.json"), join(sourceRoot, "pnpm-lock.yaml")];
  for (const packageRoot of workspacePackageRoots(sourceRoot)) {
    files.push(join(sourceRoot, packageRoot, "package.json"));
    files.push(...runtimeSourceFiles(join(sourceRoot, packageRoot, "src")));
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function workspacePackageRoots(sourceRoot: string): string[] {
  const packages = new Map<string, string>();
  for (const topLevel of ["apps", "packages"]) {
    const directory = join(sourceRoot, topLevel);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = join(topLevel, entry.name);
      const manifest = readPackageManifest(join(sourceRoot, packageRoot, "package.json"));
      if (manifest?.name) packages.set(manifest.name, packageRoot);
    }
  }

  const selected = new Set<string>();
  const pending = SOURCE_PACKAGE_DIRS.filter((root) => existsSync(join(sourceRoot, root)));
  while (pending.length > 0) {
    const packageRoot = pending.pop();
    if (!packageRoot || selected.has(packageRoot)) continue;
    selected.add(packageRoot);
    const manifest = readPackageManifest(join(sourceRoot, packageRoot, "package.json"));
    for (const dependency of Object.keys({
      ...manifest?.dependencies,
      ...manifest?.optionalDependencies,
    })) {
      const dependencyRoot = packages.get(dependency);
      if (dependencyRoot && !selected.has(dependencyRoot)) pending.push(dependencyRoot);
    }
  }
  return [...selected];
}

function readPackageManifest(path: string):
  | {
      name?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    }
  | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
  } catch {
    return undefined;
  }
}

function runtimeSourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeSourceFiles(path));
      continue;
    }
    if (
      !entry.isFile() ||
      entry.name.endsWith(".d.ts") ||
      !SOURCE_EXTENSIONS.has(extension(entry.name))
    ) {
      continue;
    }
    if (/(?:\.browser)?\.test\.[^.]+$/u.test(entry.name) || entry.name.endsWith(".snap")) continue;
    files.push(path);
  }
  return files;
}

function extension(file: string): string {
  const index = file.lastIndexOf(".");
  return index >= 0 ? file.slice(index) : "";
}

export function createSparkDaemonBuildChangeProbe(
  initialFingerprint: string,
  stabilityMs = 2_000,
): {
  observe(fingerprint: string, observedAtMs: number): SparkDaemonBuildChange | undefined;
} {
  let candidateFingerprint: string | undefined;
  let candidateSinceMs = 0;
  const stableForMs = Math.max(0, Math.floor(stabilityMs));
  return {
    observe(fingerprint, observedAtMs) {
      if (fingerprint === initialFingerprint) {
        candidateFingerprint = undefined;
        candidateSinceMs = 0;
        return undefined;
      }
      if (fingerprint !== candidateFingerprint) {
        candidateFingerprint = fingerprint;
        candidateSinceMs = observedAtMs;
        return stableForMs === 0
          ? {
              previousFingerprint: initialFingerprint,
              nextFingerprint: fingerprint,
            }
          : undefined;
      }
      return observedAtMs - candidateSinceMs >= stableForMs
        ? {
            previousFingerprint: initialFingerprint,
            nextFingerprint: fingerprint,
          }
        : undefined;
    },
  };
}

export function watchSparkDaemonBuild(options: {
  entrypoint: string;
  initialFingerprint: string;
  onChange: (change: SparkDaemonBuildChange) => void | Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  stabilityMs?: number;
  fingerprint?: (entrypoint: string) => string;
}): () => void {
  const probe = createSparkDaemonBuildChangeProbe(options.initialFingerprint, options.stabilityMs);
  const fingerprint = options.fingerprint ?? sparkDaemonEntrypointFingerprint;
  let stopped = false;
  let requestingRestart = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
  timer = setInterval(
    () => {
      if (stopped || requestingRestart) return;
      try {
        const change = probe.observe(fingerprint(options.entrypoint), Date.now());
        if (!change) return;
        requestingRestart = true;
        void Promise.resolve(options.onChange(change))
          .then(stop)
          .catch(options.onError ?? (() => {}))
          .finally(() => {
            requestingRestart = false;
          });
      } catch (error) {
        options.onError?.(error);
      }
    },
    Math.max(250, Math.floor(options.intervalMs ?? 1_000)),
  );
  timer.unref();
  return stop;
}
