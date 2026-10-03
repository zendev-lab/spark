import { join } from "node:path";

import { resolveSparkUserPaths } from "@zendev-lab/spark-platform-node";

export function workspaceWorkflowDir(cwd: string): string {
  return join(cwd, ".agents", "workflows");
}

export function userWorkflowDir(): string {
  return resolveSparkUserPaths().workflowsDir;
}
