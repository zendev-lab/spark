import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import type { ArtifactRef, ProjectRef, RoleRef, Task, TaskRef } from "@zendev-lab/spark-core";
import { fleetLaneKey, resolveFleetTaskTarget } from "../extension/spark-fleet-target.ts";
import { prepareFleetTargetLocks } from "../extension/spark-fleet-projection.ts";

async function withWorkspace(fn: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "spark-fleet-target-"));
  try {
    await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function putGitChange(
  workspace: string,
  ref: ArtifactRef,
  worktreePath: string,
  status: "attached" | "missing" = "attached",
): Promise<void> {
  await defaultArtifactStore(workspace).put({
    ref,
    kind: "git_change",
    title: ref,
    format: "json",
    body: {
      schemaVersion: 2,
      kind: "git_change",
      repository: { forge: "github", repo: `acme/${ref.slice("artifact:".length)}` },
      trunk: "main",
      worktree: {
        path: worktreePath,
        branch: `fleet/${ref.slice("artifact:".length)}`,
        ownership: "spark",
        status,
      },
      stack: { authority: "gh-stack", entries: [] },
      lifecycle: "local",
    },
  });
}

function task(
  ref: string,
  artifactRefs: ArtifactRef[],
  worktreeTarget?: { primaryArtifactRef: ArtifactRef; writableArtifactRefs: ArtifactRef[] },
  options: { kind?: Task["kind"]; isolation?: "isolated_worktree" | "readonly" } = {},
): Task {
  return {
    ref: ref as TaskRef,
    projectRef: "project:fleet" as ProjectRef,
    name: ref.replace("task:", ""),
    title: ref,
    description: "Fleet test task",
    kind: options.kind ?? "implement",
    status: "ready",
    roleRef: "role:executor" as RoleRef,
    executionPolicy: {
      sessionLifetime: "task_revision",
      continuity: "reuse_within_revision",
      isolation: options.isolation ?? "isolated_worktree",
      comparison: "single_side",
      concurrencyKeys: [],
      maxAttempts: 2,
      ...(worktreeTarget ? { worktreeTarget } : {}),
    },
    supersededBy: [],
    artifactRefs,
    inputEvidenceRefs: [],
    outputEvidenceRefs: [],
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

test("Fleet infers one git_change and resolves explicit multi-worktree targets", async () => {
  await withWorkspace(async (workspace) => {
    const firstRef = "artifact:first" as ArtifactRef;
    const secondRef = "artifact:second" as ArtifactRef;
    const firstRoot = join(workspace, "first");
    const secondRoot = join(workspace, "second");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    await Promise.all([
      putGitChange(workspace, firstRef, firstRoot),
      putGitChange(workspace, secondRef, secondRoot),
    ]);

    const inferred = await resolveFleetTaskTarget({
      workspaceCwd: workspace,
      task: task("task:single", [firstRef]),
    });
    assert.equal(inferred.primaryArtifactRef, firstRef);
    assert.deepEqual(inferred.writableArtifactRefs, [firstRef]);
    assert.deepEqual(inferred.concurrencyKeys, [`worktree:${firstRef}`]);

    const explicit = await resolveFleetTaskTarget({
      workspaceCwd: workspace,
      task: task("task:multi", [firstRef, secondRef], {
        primaryArtifactRef: secondRef,
        writableArtifactRefs: [secondRef, firstRef],
      }),
    });
    assert.equal(explicit.primaryArtifactRef, secondRef);
    assert.equal(explicit.primaryRoot, await realpath(secondRoot));
    assert.deepEqual(explicit.writableArtifactRefs, [firstRef, secondRef]);
    assert.deepEqual(explicit.concurrencyKeys, [`worktree:${firstRef}`, `worktree:${secondRef}`]);
  });
});

test("Fleet rejects ambiguous, unlinked, missing, and moved targets without replacement", async () => {
  await withWorkspace(async (workspace) => {
    const firstRef = "artifact:first" as ArtifactRef;
    const secondRef = "artifact:second" as ArtifactRef;
    const missingRef = "artifact:missing" as ArtifactRef;
    const firstRoot = join(workspace, "first");
    const secondRoot = join(workspace, "second");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    await Promise.all([
      putGitChange(workspace, firstRef, firstRoot),
      putGitChange(workspace, secondRef, secondRoot),
      putGitChange(workspace, missingRef, join(workspace, "moved")),
    ]);

    await assert.rejects(
      resolveFleetTaskTarget({
        workspaceCwd: workspace,
        task: task("task:ambiguous", [firstRef, secondRef]),
      }),
      /worktreeTarget is required/u,
    );
    await assert.rejects(
      resolveFleetTaskTarget({
        workspaceCwd: workspace,
        task: task("task:unlinked", [firstRef], {
          primaryArtifactRef: secondRef,
          writableArtifactRefs: [secondRef],
        }),
      }),
      /not linked/u,
    );
    await assert.rejects(
      resolveFleetTaskTarget({
        workspaceCwd: workspace,
        task: task("task:moved", [missingRef]),
      }),
      /missing or moved/u,
    );
    await assert.rejects(
      resolveFleetTaskTarget({
        workspaceCwd: join(workspace, "other-workspace"),
        task: task("task:cross-workspace", [firstRef]),
      }),
      /no linked git_change/u,
    );
  });
});

test("Fleet allows readonly tasks without a git_change and uses the session cwd", async () => {
  await withWorkspace(async (workspace) => {
    const resolved = await resolveFleetTaskTarget({
      workspaceCwd: workspace,
      task: task("task:review", [], undefined, { kind: "review", isolation: "readonly" }),
    });
    assert.equal(resolved.primaryRoot, workspace);
    assert.deepEqual(resolved.writableArtifactRefs, []);
    assert.deepEqual(resolved.writableRoots, []);
    assert.deepEqual(resolved.concurrencyKeys, []);
  });
});

test("Fleet derives overlap locks and deterministic lane identities", async () => {
  await withWorkspace(async (workspace) => {
    const firstRef = "artifact:first" as ArtifactRef;
    const secondRef = "artifact:second" as ArtifactRef;
    const firstRoot = join(workspace, "first");
    const secondRoot = join(workspace, "second");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    await Promise.all([
      putGitChange(workspace, firstRef, firstRoot),
      putGitChange(workspace, secondRef, secondRoot),
    ]);
    const prepared = await prepareFleetTargetLocks(workspace, [
      task("task:first", [firstRef]),
      task("task:overlap", [firstRef, secondRef], {
        primaryArtifactRef: secondRef,
        writableArtifactRefs: [firstRef, secondRef],
      }),
    ]);
    assert.equal(prepared.deferred.length, 0);
    assert.deepEqual(prepared.tasks[0]?.executionPolicy?.concurrencyKeys, [`worktree:${firstRef}`]);
    assert.deepEqual(prepared.tasks[1]?.executionPolicy?.concurrencyKeys, [
      `worktree:${firstRef}`,
      `worktree:${secondRef}`,
    ]);

    const identity = {
      ownerSessionId: "session:owner",
      projectRef: "project:fleet" as ProjectRef,
      roleRef: "role:executor" as RoleRef,
      primaryArtifactRef: firstRef,
      writableArtifactRefs: [secondRef, firstRef],
    };
    assert.equal(
      fleetLaneKey(identity),
      fleetLaneKey({ ...identity, writableArtifactRefs: [firstRef, secondRef] }),
    );
    assert.notEqual(
      fleetLaneKey(identity),
      fleetLaneKey({ ...identity, primaryArtifactRef: secondRef }),
    );
  });
});
