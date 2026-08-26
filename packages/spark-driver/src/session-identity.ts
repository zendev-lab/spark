import { stableId } from "@zendev-lab/spark-invocation";
import { sparkStateRootPath } from "@zendev-lab/spark-platform-node/paths";

export { sparkStateCwd, sparkStateRootPath } from "@zendev-lab/spark-platform-node/paths";

export interface SparkSessionContext {
  cwd?: string;
  /** Host-bound Spark session identity; preferred over sessionManager stubs. */
  sessionId?: string;
  /** Optional absolute path to the Spark state root directory (`.../.spark`). */
  sparkStateRoot?: string;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
}

export function sparkSessionFileKey(ctx?: SparkSessionContext): string | undefined {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  return sessionFile ? `session:${stableId(sessionFile)}` : undefined;
}

export function sparkSessionKey(ctx?: SparkSessionContext): string {
  const sessionId = ctx?.sessionId?.trim();
  if (sessionId) {
    if (sessionId.startsWith("session:") || sessionId.startsWith("leaf:")) return sessionId;
    return `session:${sessionId}`;
  }
  const managerSessionId = ctx?.sessionManager?.getSessionId?.().trim();
  if (managerSessionId) {
    if (managerSessionId.startsWith("session:") || managerSessionId.startsWith("leaf:")) {
      return managerSessionId;
    }
    return `session:${managerSessionId}`;
  }
  const fileKey = sparkSessionFileKey(ctx);
  if (fileKey) return fileKey;
  const leaf = ctx?.sessionManager?.getLeafId?.();
  if (leaf) {
    if (leaf.startsWith("session:") || leaf.startsWith("leaf:")) return leaf;
    return `leaf:${leaf}`;
  }
  return "session:ephemeral";
}

export function sparkSessionOwnerKey(ctx?: SparkSessionContext): string {
  return sparkSessionKey(ctx);
}

export function sanitizeStoreScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || "default";
}
