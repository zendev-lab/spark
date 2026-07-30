import type { DatabaseSync } from "node:sqlite";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { EvidenceMigrationWorkspace } from "@zendev-lab/spark-artifacts/evidence-migration";
import { listWorkspaces } from "./store/workspaces.js";

export interface RegisteredEvidenceMigrationWorkspaceSkipped {
  workspaceId: string;
  localPath: string;
  reason: "duplicate-path" | "missing" | "not-directory" | "unreachable";
  duplicateOf?: string;
}

export interface RegisteredEvidenceMigrationWorkspaceDiscovery {
  workspaces: EvidenceMigrationWorkspace[];
  skipped: RegisteredEvidenceMigrationWorkspaceSkipped[];
}

export async function discoverRegisteredEvidenceMigrationWorkspaces(
  db: DatabaseSync,
  options: { workspace?: string } = {},
): Promise<RegisteredEvidenceMigrationWorkspaceDiscovery> {
  const selected = listWorkspaces(db)
    .filter((workspace) =>
      options.workspace
        ? workspace.id === options.workspace ||
          workspace.localPath === options.workspace ||
          resolve(workspace.localPath) === resolve(options.workspace)
        : true,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const workspaces: EvidenceMigrationWorkspace[] = [];
  const skipped: RegisteredEvidenceMigrationWorkspaceSkipped[] = [];
  const ownerByPath = new Map<string, string>();

  for (const workspace of selected) {
    let canonicalPath: string;
    try {
      const info = await stat(workspace.localPath);
      if (!info.isDirectory()) {
        skipped.push({
          workspaceId: workspace.id,
          localPath: workspace.localPath,
          reason: "not-directory",
        });
        continue;
      }
      canonicalPath = await realpath(workspace.localPath);
    } catch (error) {
      skipped.push({
        workspaceId: workspace.id,
        localPath: workspace.localPath,
        reason: errorCode(error) === "ENOENT" ? "missing" : "unreachable",
      });
      continue;
    }

    const owner = ownerByPath.get(canonicalPath);
    if (owner) {
      skipped.push({
        workspaceId: workspace.id,
        localPath: canonicalPath,
        reason: "duplicate-path",
        duplicateOf: owner,
      });
      continue;
    }
    ownerByPath.set(canonicalPath, workspace.id);
    workspaces.push({
      workspaceId: workspace.id,
      rootDir: canonicalPath,
      displayName: workspace.displayName,
    });
  }

  return { workspaces, skipped };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
