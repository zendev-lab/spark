import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSparkSessionRegistryRoot } from "@zendev-lab/spark-session";
import { migrateSessionRegistryOwnership } from "./session-registry-migration.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon Session registry hard-cut migration", () => {
  it("runs the registry-owned v4 to v6 migration before service admission and is idempotent", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-session-registry-migration-"));
    roots.push(sparkHome);
    const registryRoot = defaultSparkSessionRegistryRoot(sparkHome);
    await mkdir(registryRoot, { recursive: true });
    const registryPath = join(registryRoot, "registry.json");
    await writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 4,
          sessions: [
            {
              sessionId: "sess_main",
              scope: { kind: "workspace", workspaceId: "ws_demo" },
              role: "Workspace Coordinator",
              status: "ready",
              relation: { kind: "workspace_main" },
              bindings: [],
              createdAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
            },
            {
              sessionId: "sess_worker",
              scope: { kind: "workspace", workspaceId: "ws_demo" },
              role: "role:builtin-worker",
              status: "ready",
              bindings: [],
              createdAt: "2026-07-02T00:00:00.000Z",
              updatedAt: "2026-07-02T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(migrateSessionRegistryOwnership({ sparkHome })).resolves.toMatchObject({
      changed: true,
      sourceVersion: 4,
      targetVersion: 6,
      sessions: 2,
    });
    const migrated = JSON.parse(await readFile(registryPath, "utf8")) as {
      version: number;
      sessions: Array<Record<string, unknown>>;
    };
    expect(migrated.version).toBe(6);
    expect(migrated.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "sess_main",
          owner: { kind: "workspace", workspaceId: "ws_demo" },
          roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
        }),
        expect.objectContaining({
          sessionId: "sess_worker",
          owner: { kind: "session", supervisorSessionId: "sess_main" },
          roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        }),
      ]),
    );
    expect(JSON.stringify(migrated)).not.toMatch(/"(role|status|relation)"\s*:/u);

    await expect(migrateSessionRegistryOwnership({ sparkHome })).resolves.toMatchObject({
      changed: false,
      sourceVersion: 6,
      targetVersion: 6,
      sessions: 2,
    });
  });
});
