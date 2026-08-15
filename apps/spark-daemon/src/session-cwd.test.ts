import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultArtifactStore, type GitChangeArtifactBody } from "@zendev-lab/spark-artifacts";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  resolveSessionCwdForWorkspace,
  resolveSessionCwdOwner,
  SessionCwdResolutionError,
} from "./session-cwd.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { listWorkspaces, registerWorkspace } from "./store/workspaces.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("session cwd ownership", () => {
  it("accepts workspace and GitChange subdirectories while preserving one workspace", async () => {
    const fixture = await createFixture();
    const workspaceSubdir = join(fixture.workspaceRoot, "packages", "demo");
    const worktreeSubdir = join(fixture.worktreeRoot, "apps", "demo");
    await mkdir(workspaceSubdir, { recursive: true });
    await mkdir(worktreeSubdir, { recursive: true });
    const artifact = await putGitChange(fixture.workspaceRoot, fixture.worktreeRoot);

    await expect(
      resolveSessionCwdForWorkspace({ workspace: fixture.workspace, cwd: "packages/demo" }),
    ).resolves.toMatchObject({ cwd: workspaceSubdir });
    await expect(
      resolveSessionCwdForWorkspace({
        workspace: fixture.workspace,
        cwd: "apps/demo",
        cwdArtifactRef: artifact.ref,
      }),
    ).resolves.toMatchObject({ cwd: worktreeSubdir, cwdArtifactRef: artifact.ref });
    await expect(
      resolveSessionCwdForWorkspace({ workspace: fixture.workspace, cwd: worktreeSubdir }),
    ).resolves.toMatchObject({ cwd: worktreeSubdir, cwdArtifactRef: artifact.ref });

    const owned = await resolveSessionCwdOwner(fixture.db, worktreeSubdir);
    expect(owned).toMatchObject({
      workspace: { id: fixture.workspace.id },
      cwd: worktreeSubdir,
      cwdArtifactRef: artifact.ref,
    });
    expect(listWorkspaces(fixture.db)).toHaveLength(1);
    fixture.db.close();
  });

  it("rejects unrelated, missing, file, and symlink-escape paths", async () => {
    const fixture = await createFixture();
    const unrelated = join(fixture.root, "unrelated");
    const file = join(fixture.workspaceRoot, "README.md");
    const escape = join(fixture.workspaceRoot, "escape");
    await mkdir(unrelated);
    await writeFile(file, "demo");
    await symlink(unrelated, escape);

    await expect(
      resolveSessionCwdForWorkspace({ workspace: fixture.workspace, cwd: unrelated }),
    ).rejects.toBeInstanceOf(SessionCwdResolutionError);
    await expect(
      resolveSessionCwdForWorkspace({ workspace: fixture.workspace, cwd: "../unrelated" }),
    ).rejects.toThrow(/must be inside workspace|escapes its workspace root/u);
    await expect(
      resolveSessionCwdForWorkspace({ workspace: fixture.workspace, cwd: "/" }),
    ).rejects.toThrow(/cannot be the filesystem root/u);
    await expect(
      resolveSessionCwdForWorkspace({
        workspace: fixture.workspace,
        cwdArtifactRef: "artifact:missing",
      }),
    ).rejects.toThrow(/does not belong to workspace/u);
    await expect(
      resolveSessionCwdForWorkspace({ workspace: fixture.workspace, cwd: "missing" }),
    ).rejects.toThrow(/does not exist/u);
    await expect(
      resolveSessionCwdForWorkspace({ workspace: fixture.workspace, cwd: file }),
    ).rejects.toThrow(/not a directory/u);
    await expect(
      resolveSessionCwdForWorkspace({ workspace: fixture.workspace, cwd: escape }),
    ).rejects.toThrow(/must be inside workspace/u);
    fixture.db.close();
  });

  it("ignores stale registrations while resolving another live workspace", async () => {
    const fixture = await createFixture();
    const staleRoot = join(fixture.root, "stale-workspace");
    await mkdir(staleRoot);
    registerWorkspace(fixture.db, { localPath: staleRoot });
    await rm(staleRoot, { recursive: true });

    await expect(resolveSessionCwdOwner(fixture.db, fixture.workspaceRoot)).resolves.toMatchObject({
      workspace: { id: fixture.workspace.id },
      cwd: fixture.workspaceRoot,
    });
    expect(listWorkspaces(fixture.db)).toHaveLength(2);
    fixture.db.close();
  });

  it("rejects an unmatched invocation cwd instead of registering it implicitly", async () => {
    const fixture = await createFixture();
    const checkout = join(fixture.root, "standalone");
    await mkdir(checkout);

    await expect(resolveSessionCwdOwner(fixture.db, checkout)).rejects.toThrow(
      /Workspace is not registered/u,
    );
    expect(listWorkspaces(fixture.db)).toHaveLength(1);
    fixture.db.close();
  });
});

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spark-session-cwd-")));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const worktreeRoot = join(root, "worktree");
  await mkdir(workspaceRoot);
  await mkdir(worktreeRoot);
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
  const workspace = registerWorkspace(db, { localPath: workspaceRoot });
  return { root, workspaceRoot, worktreeRoot, db, workspace };
}

async function putGitChange(workspaceRoot: string, worktreeRoot: string) {
  return await defaultArtifactStore(workspaceRoot).put<GitChangeArtifactBody>({
    kind: "git_change",
    title: "Session cwd worktree",
    body: {
      schemaVersion: 2,
      kind: "git_change",
      repository: { forge: "github", repo: "zrr1999/spark" },
      trunk: "main",
      worktree: {
        path: worktreeRoot,
        branch: "codex/session-cwd",
        ownership: "spark",
        status: "attached",
      },
      stack: { authority: "legacy-unbound", entries: [] },
      lifecycle: "local",
    },
  });
}
