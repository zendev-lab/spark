import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSparkSessionRegistryRoot } from "@zendev-lab/spark-session";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDaemonGlobalSessions } from "./session-scope-migration.ts";

const roots: string[] = [];
const timestamp = "2026-08-01T00:00:00.000Z";

function session(
  sessionId: string,
  scope: { kind: "workspace"; workspaceId: string } | { kind: "daemon"; daemonId: string },
  input: { cwd?: string; status?: "ready" | "archived"; sessionPath?: string } = {},
) {
  return {
    sessionId,
    scope,
    ...(scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {}),
    status: input.status ?? "ready",
    bindings: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
  };
}

async function fixture(registry: unknown): Promise<{
  sparkHome: string;
  registryPath: string;
  source: Buffer;
}> {
  const sparkHome = await mkdtemp(join(tmpdir(), "spark-session-scope-migration-"));
  roots.push(sparkHome);
  const registryRoot = defaultSparkSessionRegistryRoot(sparkHome);
  await mkdir(registryRoot, { recursive: true });
  const source = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
  const registryPath = join(registryRoot, "registry.json");
  await writeFile(registryPath, source, { mode: 0o600 });
  return { sparkHome, registryPath, source };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon-global session scope migration", () => {
  it("maps inferable cwd ownership, archives unknown records, and preserves an exact backup", async () => {
    const workspaceRoot = join(tmpdir(), "spark-workspace-alpha");
    const packageRoot = join(workspaceRoot, "packages", "session");
    const transcriptPath = join(tmpdir(), "spark-transcripts", "sess-exact.jsonl");
    const archivedTranscriptPath = join(tmpdir(), "spark-transcripts", "sess-no-cwd.jsonl");
    const { sparkHome, registryPath, source } = await fixture({
      version: 3,
      sessions: [
        session(
          "sess-existing",
          { kind: "workspace", workspaceId: "ws-existing" },
          {
            cwd: workspaceRoot,
          },
        ),
        session(
          "sess-exact",
          { kind: "daemon", daemonId: "daemon-a" },
          {
            cwd: workspaceRoot,
            sessionPath: transcriptPath,
          },
        ),
        session(
          "sess-nested",
          { kind: "daemon", daemonId: "daemon-a" },
          {
            cwd: join(packageRoot, "src"),
          },
        ),
        session(
          "sess-no-cwd",
          { kind: "daemon", daemonId: "daemon-a" },
          {
            sessionPath: archivedTranscriptPath,
          },
        ),
        session(
          "sess-unknown",
          { kind: "daemon", daemonId: "daemon-a" },
          {
            cwd: join(tmpdir(), "not-a-registered-workspace"),
          },
        ),
      ],
    });

    const result = await migrateDaemonGlobalSessions({
      sparkHome,
      workspaces: [
        { id: "ws-alpha", localPath: workspaceRoot },
        { id: "ws-package", localPath: packageRoot },
      ],
      now: new Date(timestamp),
    });

    expect(result).toMatchObject({
      changed: true,
      registryPath,
      migratedSessions: 2,
      archivedSessions: 2,
    });
    expect(result.backupPath).toBeTruthy();
    expect(await readFile(join(result.backupPath!, "registry.json"))).toEqual(source);
    expect(JSON.parse(await readFile(join(result.backupPath!, "manifest.json"), "utf8"))).toEqual({
      version: 1,
      createdAt: timestamp,
      sourcePath: registryPath,
      beforeHash: sha256(source),
      afterHash: result.afterHash,
      migratedSessions: 2,
      archivedSessions: 2,
      backupFile: "registry.json",
    });

    const active = JSON.parse(await readFile(registryPath, "utf8")) as {
      version: number;
      sessions: Array<Record<string, unknown>>;
    };
    expect(active.version).toBe(4);
    expect(active.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "sess-exact",
          scope: { kind: "workspace", workspaceId: "ws-alpha" },
          workspaceId: "ws-alpha",
          sessionPath: transcriptPath,
          status: "ready",
        }),
        expect.objectContaining({
          sessionId: "sess-nested",
          scope: { kind: "workspace", workspaceId: "ws-package" },
          workspaceId: "ws-package",
          status: "ready",
        }),
        expect.objectContaining({
          sessionId: "sess-no-cwd",
          scope: { kind: "daemon", daemonId: "daemon-a" },
          status: "archived",
          updatedAt: timestamp,
          sessionPath: archivedTranscriptPath,
        }),
        expect.objectContaining({
          sessionId: "sess-unknown",
          scope: { kind: "daemon", daemonId: "daemon-a" },
          status: "archived",
          updatedAt: timestamp,
        }),
      ]),
    );
  });

  it("is idempotent after version 4 and does not create another backup", async () => {
    const workspaceRoot = join(tmpdir(), "spark-workspace-idempotent");
    const fixtureState = await fixture({
      version: 3,
      sessions: [
        session(
          "sess-idempotent",
          { kind: "daemon", daemonId: "daemon-a" },
          {
            cwd: workspaceRoot,
          },
        ),
      ],
    });
    const options = {
      sparkHome: fixtureState.sparkHome,
      workspaces: [{ id: "ws-idempotent", localPath: workspaceRoot }],
      now: new Date(timestamp),
    };
    const first = await migrateDaemonGlobalSessions(options);
    const firstBytes = await readFile(fixtureState.registryPath);
    const second = await migrateDaemonGlobalSessions(options);
    const secondBytes = await readFile(fixtureState.registryPath);

    expect(second).toMatchObject({
      changed: false,
      backupPath: null,
      beforeHash: first.afterHash,
      afterHash: first.afterHash,
      migratedSessions: 0,
      archivedSessions: 0,
    });
    expect(secondBytes).toEqual(firstBytes);
    const backupRoot = join(
      defaultSparkSessionRegistryRoot(fixtureState.sparkHome),
      "backups",
      "workspace-session-scope",
    );
    expect(await readdir(backupRoot)).toHaveLength(1);
  });

  it("fails closed when registry v4 contains an active daemon-global session", async () => {
    const fixtureState = await fixture({
      version: 4,
      sessions: [
        session(
          "sess-v4-daemon",
          { kind: "daemon", daemonId: "daemon-a" },
          {
            cwd: join(tmpdir(), "legacy-daemon-cwd"),
          },
        ),
      ],
    });

    await expect(
      migrateDaemonGlobalSessions({
        sparkHome: fixtureState.sparkHome,
        workspaces: [],
        now: new Date(timestamp),
      }),
    ).rejects.toThrow(/v4 contains active daemon-global session/u);
    expect(await readFile(fixtureState.registryPath)).toEqual(fixtureState.source);
  });

  it("fails before backup or active replacement when any record is invalid", async () => {
    const fixtureState = await fixture({
      version: 3,
      sessions: [{ sessionId: "sess-invalid", scope: { kind: "daemon", daemonId: "daemon-a" } }],
    });

    await expect(
      migrateDaemonGlobalSessions({
        sparkHome: fixtureState.sparkHome,
        workspaces: [],
        now: new Date(timestamp),
      }),
    ).rejects.toThrow();
    expect(await readFile(fixtureState.registryPath)).toEqual(fixtureState.source);
    await expect(
      readdir(
        join(
          defaultSparkSessionRegistryRoot(fixtureState.sparkHome),
          "backups",
          "workspace-session-scope",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
