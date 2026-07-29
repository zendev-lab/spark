import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRegisteredEvidenceMigrationWorkspaces } from "./evidence-migration.js";
import { migrateSparkDaemonDatabase } from "./store/schema.js";
import { addWorkspace } from "./store/workspaces.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("registered Evidence migration workspace discovery", () => {
  it("returns stable reachable registry roots and reports missing workspaces", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const first = await temporaryWorkspace("first");
    const second = await temporaryWorkspace("second");
    const missing = `${first}-missing`;
    addWorkspace(db, {
      id: "workspace:b",
      localWorkspaceKey: "b",
      displayName: "Second",
      localPath: second,
    });
    addWorkspace(db, {
      id: "workspace:a",
      localWorkspaceKey: "a",
      displayName: "First",
      localPath: first,
    });
    addWorkspace(db, {
      id: "workspace:missing",
      localWorkspaceKey: "missing",
      displayName: "Missing",
      localPath: missing,
    });

    const discovered = await discoverRegisteredEvidenceMigrationWorkspaces(db);
    expect(discovered.workspaces).toEqual([
      { workspaceId: "workspace:a", rootDir: first, displayName: "First" },
      { workspaceId: "workspace:b", rootDir: second, displayName: "Second" },
    ]);
    expect(discovered.skipped).toEqual([
      {
        workspaceId: "workspace:missing",
        localPath: missing,
        reason: "missing",
      },
    ]);

    const selected = await discoverRegisteredEvidenceMigrationWorkspaces(db, {
      workspace: "workspace:b",
    });
    expect(selected.workspaces).toEqual([
      { workspaceId: "workspace:b", rootDir: second, displayName: "Second" },
    ]);
    expect(selected.skipped).toEqual([]);
    db.close();
  });
});

async function temporaryWorkspace(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `spark-evidence-registry-${name}-`));
  roots.push(root);
  return realpath(root);
}
