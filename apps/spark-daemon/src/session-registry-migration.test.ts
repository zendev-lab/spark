import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSparkSessionRegistryRoot } from "@zendev-lab/spark-session";
import { migrateSessionRegistryLineage } from "./session-registry-migration.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon Session registry hard-cut migration", () => {
  it("runs the registry-owned v6 to v7 migration before service admission and is idempotent", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-session-registry-migration-"));
    roots.push(sparkHome);
    const registryRoot = defaultSparkSessionRegistryRoot(sparkHome);
    await mkdir(registryRoot, { recursive: true });
    const registryPath = join(registryRoot, "registry.json");
    await writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 6,
          revision: 3,
          sessions: [
            {
              sessionId: "sess_main",
              scope: { kind: "workspace", workspaceId: "ws_demo" },
              lifecycle: "open",
              placement: "active",
              roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
              owner: { kind: "workspace", workspaceId: "ws_demo" },
              incarnation: 1,
              stateBinding: { kind: "session", ref: "sess_main" },
              visibility: "public",
              retention: "audit",
              purpose: "workspace_administrator",
              bindings: [],
              createdAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
            },
            {
              sessionId: "sess_worker",
              scope: { kind: "workspace", workspaceId: "ws_demo" },
              lifecycle: "open",
              placement: "active",
              roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
              owner: { kind: "session", supervisorSessionId: "sess_main" },
              incarnation: 1,
              stateBinding: { kind: "session", ref: "sess_worker" },
              visibility: "public",
              retention: "retain",
              purpose: "conversation",
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

    await expect(migrateSessionRegistryLineage({ sparkHome })).resolves.toMatchObject({
      changed: true,
      sourceVersion: 6,
      targetVersion: 7,
      sessions: 2,
    });
    const migrated = JSON.parse(await readFile(registryPath, "utf8")) as {
      version: number;
      sessions: Array<Record<string, unknown>>;
    };
    expect(migrated.version).toBe(7);
    expect(migrated.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "sess_main",
          lineage: { kind: "root", workspaceId: "ws_demo" },
          roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
        }),
        expect.objectContaining({
          sessionId: "sess_worker",
          lineage: {
            kind: "child",
            parentSessionId: "sess_main",
            origin: { kind: "session" },
          },
          roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        }),
      ]),
    );
    expect(JSON.stringify(migrated)).not.toMatch(/"(owner|stateBinding)"\s*:/u);

    await expect(migrateSessionRegistryLineage({ sparkHome })).resolves.toMatchObject({
      changed: false,
      sourceVersion: 7,
      targetVersion: 7,
      sessions: 2,
    });
  });
});
