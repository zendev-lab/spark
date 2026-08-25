import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "@zendev-lab/spark-hub-storage-sqlite";
import { sessionReproStorePathV2 } from "@zendev-lab/spark-loop";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import type { SparkDaemonModelControl } from "./model-control.ts";
import { migrateLegacyReproV9Snapshots } from "./repro-v9-migration.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { SparkReproV10Store } from "./store/repro-v10.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Repro v9 to v10 migration", () => {
  it("backs up, read-checks, and idempotently blocks the current v9 snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-repro-migration-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const paths = resolveSparkPaths({ app: "daemon", sparkHome: join(root, "spark-home") });
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const workspace = registerWorkspace(db, {
      localPath: workspaceRoot,
      displayName: "Migration workspace",
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, "registry"), {
      resolveWorkspaceCwd: () => workspaceRoot,
    });
    const ownerSession = await sessionRegistry.ensureWorkspaceAdministrator(workspace.id);
    const sourcePath = sessionReproStorePathV2(workspaceRoot, {
      sessionId: ownerSession.sessionId,
    });
    const source = JSON.stringify({
      version: 8,
      repro: {
        version: 9,
        reproId: "repro:legacy-v9",
        goalContract: { objective: "Preserve the legacy objective" },
      },
    });
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, source);

    const deps = {
      paths,
      db,
      sessionRegistry,
      modelControl: testModelControl(),
    };

    try {
      expect(await migrateLegacyReproV9Snapshots(deps)).toBe(1);
      const migrated = new SparkReproV10Store(db).get("repro:legacy-v9");
      expect(migrated).toMatchObject({
        version: 10,
        status: "blocked",
        objective: "Preserve the legacy objective",
      });
      expect(migrated?.migratedFromV9Digest).toMatch(/^[a-f0-9]{64}$/u);

      const journal = JSON.parse(await readFile(`${sourcePath}.v10-migration.json`, "utf8")) as {
        backupPath: string;
        status: string;
        migrated: boolean;
      };
      expect(journal).toMatchObject({ status: "complete", migrated: true });
      expect(await readFile(journal.backupPath, "utf8")).toBe(source);
      await expect(access(sourcePath)).resolves.toBeUndefined();
      await expect(access(`${sourcePath}.v10-migration.json.staged`)).rejects.toThrow();

      expect(await migrateLegacyReproV9Snapshots(deps)).toBe(0);
      expect(new SparkReproV10Store(db).get("repro:legacy-v9")).toEqual(migrated);
    } finally {
      db.close();
    }
  });

  it("fails closed without changing a snapshot older than outer v8", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-repro-old-migration-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const paths = resolveSparkPaths({ app: "daemon", sparkHome: join(root, "spark-home") });
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const workspace = registerWorkspace(db, { localPath: workspaceRoot, displayName: "Old" });
    const sessionRegistry = createDaemonSessionRegistry(join(root, "registry"), {
      resolveWorkspaceCwd: () => workspaceRoot,
    });
    const ownerSession = await sessionRegistry.ensureWorkspaceAdministrator(workspace.id);
    const sourcePath = sessionReproStorePathV2(workspaceRoot, {
      sessionId: ownerSession.sessionId,
    });
    const source = JSON.stringify({ version: 7, repro: { version: 8 } });
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, source);

    try {
      await expect(
        migrateLegacyReproV9Snapshots({
          paths,
          db,
          sessionRegistry,
          modelControl: testModelControl(),
        }),
      ).rejects.toThrow(/upgrade through Spark 0\.4\.0/u);
      expect(await readFile(sourcePath, "utf8")).toBe(source);
      await expect(access(`${sourcePath}.v10-migration.json`)).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});

function testModelControl(): SparkDaemonModelControl {
  const model = { providerName: "test-provider", modelId: "test-model" };
  return {
    effectiveModel: async () => model,
    effectiveThinkingLevel: async () => "high",
    prepareModel: async () => undefined,
  } as unknown as SparkDaemonModelControl;
}
