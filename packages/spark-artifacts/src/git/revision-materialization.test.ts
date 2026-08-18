import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultArtifactStore, newArtifactRef } from "../artifact/index.ts";
import {
  defaultGitCommandRunner,
  gitHubRepositoryFromRemote,
  type GitCommandRunner,
} from "./lifecycle.ts";
import { GitRevisionMaterializationService } from "./revision-materialization.ts";

describe("GitRevisionMaterializationService", () => {
  it.each([
    ["https://github.com/zendev-lab/spark.git", "zendev-lab/spark"],
    ["ssh://git@github.com/zendev-lab/spark.git", "zendev-lab/spark"],
    ["git@github.com:zendev-lab/spark.git", "zendev-lab/spark"],
    ["https://gitlab.com/zendev-lab/spark.git", undefined],
  ])("normalizes GitHub origin %s", (remote, expected) => {
    expect(gitHubRepositoryFromRemote(remote)).toBe(expected);
  });

  it("creates a candidate at the exact frozen baseline and replays its receipt", async () => {
    const fixture = await revisionFixture();
    const service = fixture.service();
    const artifactRef = newArtifactRef();
    const input = {
      action: "create_candidate" as const,
      operationId: "route:create:1",
      authority: "driver_local" as const,
      repository: "acme/app",
      artifactRef,
      title: "Implementation candidate",
      branch: "codex/implementation-candidate",
      baselineRevision: fixture.base,
      trunk: "main",
      repositoryPath: fixture.repository,
    };

    const created = await service.materialize(input);
    const replayed = await service.materialize(input);

    expect(created.headRevision).toBe(fixture.base);
    expect(created.artifact.body.revisionMaterialization).toMatchObject({
      authority: "driver_local",
      baselineRevision: fixture.base,
      revision: 1,
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.artifact.ref).toBe(artifactRef);
  });

  it("rejects abbreviated, foreign, and non-ancestor baselines", async () => {
    const fixture = await revisionFixture();
    const service = fixture.service();
    const baseInput = {
      action: "create_candidate" as const,
      operationId: "route:create:invalid",
      authority: "driver_local" as const,
      repository: "acme/app",
      artifactRef: newArtifactRef(),
      title: "Candidate",
      branch: "codex/invalid-candidate",
      trunk: "main",
      repositoryPath: fixture.repository,
    };

    await expect(
      service.materialize({ ...baseInput, baselineRevision: fixture.base.slice(0, 12) }),
    ).rejects.toMatchObject({ code: "exact_revision_required" });
    await expect(
      service.materialize({
        ...baseInput,
        artifactRef: newArtifactRef(),
        operationId: "route:create:foreign",
        repository: "other/app",
        baselineRevision: fixture.base,
      }),
    ).rejects.toMatchObject({ code: "repository_mismatch" });
    await expect(
      service.materialize({
        ...baseInput,
        artifactRef: newArtifactRef(),
        operationId: "route:create:non-ancestor",
        branch: "codex/non-ancestor-candidate",
        baselineRevision: fixture.source,
      }),
    ).rejects.toMatchObject({ code: "non_ancestor_revision" });
  });

  it("imports a linear accepted range and requires explicit supersession for refresh", async () => {
    const fixture = await revisionFixture();
    const service = fixture.service();
    const artifactRef = await createCandidate(service, fixture);

    const prepared = await service.materialize({
      action: "prepare_layer",
      operationId: "route:prepare:1",
      authority: "driver_local",
      repository: "acme/app",
      artifactRef,
      expectedTargetRevision: fixture.base,
      sourceBaseRevision: fixture.base,
      sourceRevision: fixture.target,
      supersededRevisions: [],
    });
    expect(prepared.headRevision).toBe(fixture.target);
    expect(prepared.appliedRevisions).toEqual([fixture.target]);

    await expect(
      service.materialize({
        action: "refresh_candidate",
        operationId: "route:refresh:missing-supersession",
        authority: "driver_local",
        repository: "acme/app",
        artifactRef,
        expectedTargetRevision: fixture.target,
        sourceBaseRevision: fixture.target,
        sourceRevision: fixture.target,
        supersededRevisions: [],
      }),
    ).rejects.toMatchObject({ code: "superseded_revision_required" });

    const refreshed = await service.materialize({
      action: "refresh_candidate",
      operationId: "route:refresh:no-op",
      authority: "driver_local",
      repository: "acme/app",
      artifactRef,
      expectedTargetRevision: fixture.target,
      sourceBaseRevision: fixture.target,
      sourceRevision: fixture.target,
      supersededRevisions: [fixture.target],
    });
    expect(refreshed.headRevision).toBe(fixture.target);
    expect(refreshed.supersededRevisions).toEqual([fixture.target]);
  });

  it("rolls a conflicting import back to the complete prior candidate", async () => {
    const fixture = await revisionFixture();
    const service = fixture.service();
    const artifactRef = await createCandidate(service, fixture);
    await service.materialize({
      action: "prepare_layer",
      operationId: "route:prepare:target",
      authority: "driver_local",
      repository: "acme/app",
      artifactRef,
      expectedTargetRevision: fixture.base,
      sourceBaseRevision: fixture.base,
      sourceRevision: fixture.target,
      supersededRevisions: [],
    });

    await expect(
      service.materialize({
        action: "refresh_candidate",
        operationId: "route:refresh:conflict",
        authority: "driver_local",
        repository: "acme/app",
        artifactRef,
        expectedTargetRevision: fixture.target,
        sourceBaseRevision: fixture.base,
        sourceRevision: fixture.source,
        supersededRevisions: [fixture.target],
      }),
    ).rejects.toMatchObject({ code: "materialization_conflict" });

    const artifact = await fixture.store.get(artifactRef);
    const path = artifact.body.kind === "git_change" ? artifact.body.worktree.path : undefined;
    expect(path).toBeTruthy();
    expect(await git(path!, "rev-parse", "HEAD")).toBe(fixture.target);
    expect(await git(path!, "status", "--porcelain")).toBe("");
    expect(
      artifact.body.kind === "git_change" && artifact.body.revisionMaterialization?.revision,
    ).toBe(2);
  });

  it("rejects non-linear source history and externally owned writers", async () => {
    const fixture = await revisionFixture();
    const service = fixture.service();
    const artifactRef = await createCandidate(service, fixture);

    await expect(
      service.materialize({
        action: "prepare_layer",
        operationId: "route:prepare:merge",
        authority: "driver_local",
        repository: "acme/app",
        artifactRef,
        expectedTargetRevision: fixture.base,
        sourceBaseRevision: fixture.base,
        sourceRevision: fixture.merge,
        supersededRevisions: [],
      }),
    ).rejects.toMatchObject({ code: "non_linear_revision" });

    const artifact = await fixture.store.get(artifactRef);
    if (artifact.body.kind !== "git_change") throw new Error("expected git_change");
    await fixture.store.update(artifactRef, {
      body: {
        ...artifact.body,
        worktree: { ...artifact.body.worktree, ownership: "external" },
      },
    });
    await expect(
      service.materialize({
        action: "prepare_layer",
        operationId: "route:prepare:external",
        authority: "driver_local",
        repository: "acme/app",
        artifactRef,
        expectedTargetRevision: fixture.base,
        sourceBaseRevision: fixture.base,
        sourceRevision: fixture.target,
        supersededRevisions: [],
      }),
    ).rejects.toMatchObject({ code: "canonical_writer_required" });
  });
});

interface RevisionFixture {
  workspace: string;
  repository: string;
  store: ReturnType<typeof defaultArtifactStore>;
  base: string;
  target: string;
  source: string;
  merge: string;
  service(): GitRevisionMaterializationService;
}

async function revisionFixture(): Promise<RevisionFixture> {
  const workspace = await mkdtemp(join(tmpdir(), "spark-revision-materialization-"));
  const repository = join(workspace, "repository");
  await mkdir(repository, { recursive: true });
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Spark Test");
  await git(repository, "config", "user.email", "spark@example.test");
  await git(repository, "config", "commit.gpgsign", "false");
  await git(repository, "remote", "add", "origin", "git@github.com:acme/app.git");
  await writeFile(join(repository, "value.txt"), "base\n");
  await git(repository, "add", "value.txt");
  await git(repository, "commit", "-m", "base");
  const base = await git(repository, "rev-parse", "HEAD");

  await writeFile(join(repository, "value.txt"), "target\n");
  await git(repository, "commit", "-am", "target");
  const target = await git(repository, "rev-parse", "HEAD");

  await git(repository, "switch", "-c", "source", base);
  await writeFile(join(repository, "value.txt"), "source\n");
  await git(repository, "commit", "-am", "source");
  const source = await git(repository, "rev-parse", "HEAD");

  await git(repository, "switch", "-c", "merge-left", base);
  await writeFile(join(repository, "left.txt"), "left\n");
  await git(repository, "add", "left.txt");
  await git(repository, "commit", "-m", "left");
  await git(repository, "switch", "-c", "merge-right", base);
  await writeFile(join(repository, "right.txt"), "right\n");
  await git(repository, "add", "right.txt");
  await git(repository, "commit", "-m", "right");
  await git(repository, "switch", "merge-left");
  await git(repository, "merge", "--no-ff", "merge-right", "-m", "merge history");
  const merge = await git(repository, "rev-parse", "HEAD");
  await git(repository, "switch", "main");

  const store = defaultArtifactStore(workspace);
  const runner = materializationRunner();
  return {
    workspace,
    repository,
    store,
    base,
    target,
    source,
    merge,
    service: () =>
      new GitRevisionMaterializationService({
        cwd: repository,
        workspaceRoot: workspace,
        store,
        runner,
      }),
  };
}

async function createCandidate(
  service: GitRevisionMaterializationService,
  fixture: RevisionFixture,
) {
  const artifactRef = newArtifactRef();
  await service.materialize({
    action: "create_candidate",
    operationId: `route:create:${artifactRef}`,
    authority: "driver_local",
    repository: "acme/app",
    artifactRef,
    title: "Candidate",
    branch: `codex/candidate-${artifactRef.slice(-8)}`,
    baselineRevision: fixture.base,
    trunk: "main",
    repositoryPath: fixture.repository,
  });
  return artifactRef;
}

function materializationRunner(): GitCommandRunner {
  return async (command, args, cwd, options) => {
    if (command === "git") return await defaultGitCommandRunner(command, args, cwd, options);
    if (command !== "gh") return { stdout: "", stderr: `unexpected ${command}`, code: 127 };
    if (args[0] === "stack" && args[1] === "init") return success("");
    if (args.join(" ") === "stack view --json") {
      return success(
        JSON.stringify({
          trunk: "main",
          currentBranch: "codex/candidate",
          branches: [
            {
              name: "codex/candidate",
              base: "main",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
          ],
        }),
      );
    }
    if (args[0] === "pr" && args[1] === "view") {
      return { stdout: "", stderr: "no pull request", code: 1 };
    }
    return { stdout: "", stderr: `unexpected gh ${args.join(" ")}`, code: 127 };
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await defaultGitCommandRunner("git", args, cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function success(stdout: string) {
  return { stdout, stderr: "", code: 0 };
}
