import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Shared precedence for builtin and agent-owned resources. */
export type SparkResourceLayer =
  | "builtin"
  | "user"
  | "workspace"
  | "cwd"
  | "configured"
  | "repository";

export interface SparkResourceRoot {
  layer: SparkResourceLayer;
  path: string;
}

export interface SparkResourceRootOptions {
  builtin?: string[];
  user?: string[];
  workspace?: string[];
  cwd?: string[];
  configured?: string[];
  repository?: string[];
}

export const sparkResourceLayerOrder: readonly SparkResourceLayer[] = [
  "builtin",
  "user",
  "workspace",
  "cwd",
  "configured",
  "repository",
];

/** Flatten roots in canonical order; later roots win same-id collisions. */
export function orderedSparkResourceRoots(options: SparkResourceRootOptions): SparkResourceRoot[] {
  return sparkResourceLayerOrder.flatMap((layer) =>
    (options[layer] ?? []).map((path) => ({ layer, path })),
  );
}

/** Project `.agents/<resource>` roots from the repository boundary to cwd. */
export function defaultProjectResourceDirs(cwd: string, resource: string): string[] {
  const dirs: string[] = [];
  const resolvedCwd = resolve(cwd);
  let current = resolvedCwd;
  let foundRepository = false;
  while (true) {
    dirs.push(join(current, ".agents", resource));
    if (existsSync(join(current, ".git"))) {
      foundRepository = true;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return foundRepository ? dirs.reverse() : [join(resolvedCwd, ".agents", resource)];
}
