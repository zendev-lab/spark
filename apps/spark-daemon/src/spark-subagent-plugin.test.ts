import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import { afterEach, describe, expect, it } from "vitest";

import { resolveSessionCwdForWorkspaceId } from "./session-cwd.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { createSparkDaemonSubagentHost } from "./spark-subagent-plugin.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("daemon subagent host", () => {
  it("spawns a Role-bound child Session through the Cordis host hook", async () => {
    const fixture = await createFixture();
    const host = createSparkDaemonSubagentHost({
      db: fixture.db,
      registry: fixture.registry,
      sparkHome: fixture.sparkHome,
      send: async (request) => ({ sessionId: request.sessionId, invocationId: "inv_test" }),
    });

    const started = await host.createChild({
      parentSessionId: fixture.administrator.sessionId,
      roleRef: "role:builtin-executor",
      mode: "spawn",
      name: "Implementation",
    });

    expect(started).toMatchObject({
      roleRef: "role:builtin-executor",
      mode: "spawn",
    });
    const child = await fixture.registry.get(started.sessionId);
    expect(child).toMatchObject({
      name: "Implementation",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      lineage: {
        kind: "child",
        parentSessionId: fixture.administrator.sessionId,
        origin: { kind: "session" },
      },
    });
    await expect(
      host.send({
        parentSessionId: fixture.administrator.sessionId,
        sessionId: started.sessionId,
        body: "Review the diff.",
      }),
    ).resolves.toEqual({ sessionId: started.sessionId, invocationId: "inv_test" });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "spark-subagent-host-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const cwd = await realpath(workspacePath);
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const db = openSparkDaemonDatabase(paths);
  databases.push(db);
  const workspace = registerWorkspace(db, { localPath: cwd });
  const registry = createDaemonSessionRegistry(join(root, "registry"), {
    resolveWorkspaceCwd: (workspaceId) => (workspaceId === workspace.id ? cwd : undefined),
    resolveSessionCwd: async (input) => await resolveSessionCwdForWorkspaceId(db, input),
  });
  const administrator = await registry.ensureWorkspaceAdministrator(workspace.id);
  return {
    db,
    registry,
    administrator,
    sparkHome: paths.sessionRuntimeDir!,
  };
}
