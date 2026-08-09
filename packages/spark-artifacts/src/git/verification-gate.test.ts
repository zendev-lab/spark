import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  captureWorkspaceRevision,
  TSC_PROVIDER_ID,
  TYPESCRIPT_DUAL_ROUTE_DIGEST,
  TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  VITE_PLUS_PROVIDER_ID,
  type LensVerificationReceipt,
  type ProviderVersion,
} from "@zendev-lab/spark-lens";
import { describe, expect, test } from "vitest";

import {
  defaultEvidenceStore,
  defaultArtifactStore,
  type ArtifactRef,
  type JsonValue,
} from "../index.ts";
import { GitLifecycleService, type GitCommandRunner } from "./lifecycle.ts";
import { requireCurrentLensPass } from "./verification-gate.ts";

const execFileAsync = promisify(execFile);

test("Ready gate accepts only a current digest-bound Pass receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lens-ready-gate-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "index.ts"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Spark Lens",
      "-c",
      "user.email=lens@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  const gitChangeRef = "artifact:fixture" as ArtifactRef;
  const revision = await captureWorkspaceRevision({
    workspaceRoot: root,
    profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  });
  const receipt: LensVerificationReceipt = {
    schemaVersion: 1,
    gitChangeRef,
    workspaceRevision: revision,
    routeDigest: TYPESCRIPT_DUAL_ROUTE_DIGEST,
    profileDigest: revision.profileDigest,
    providers: [
      {
        id: TSC_PROVIDER_ID,
        version: "6.0.3" as ProviderVersion,
        status: "ok",
        durationMs: 10,
      },
      {
        id: VITE_PLUS_PROVIDER_ID,
        version: "0.2.6" as ProviderVersion,
        status: "ok",
        durationMs: 20,
      },
    ],
    obligations: ["owner", "verifier"],
    observationRefs: [],
    externalChecks: [
      {
        provider: "github-pr-checks",
        subjectRevision: revision.headOid!,
        verdict: "pass",
        obligations: ["required GitHub checks"],
        observedAt: "2026-07-31T00:00:00.000Z",
      },
    ],
    verdict: "pass",
    createdAt: "2026-07-31T00:00:00.000Z",
  };
  const { externalChecks: _externalChecks, ...receiptWithoutPrChecks } = receipt;
  await defaultEvidenceStore(root).put({
    kind: "record",
    title: "Lens pass without PR checks",
    format: "json",
    body: receiptWithoutPrChecks as unknown as JsonValue,
    provenance: {
      producer: "spark",
      note: "lens:typescript-dual-verification-v1",
    },
  });
  await expect(requireCurrentLensPass(root, gitChangeRef)).rejects.toThrow(
    /current Pass Lens receipt required/,
  );
  const evidence = await defaultEvidenceStore(root).put({
    kind: "record",
    title: "Lens pass",
    format: "json",
    body: receipt as unknown as JsonValue,
    provenance: {
      producer: "spark",
      note: "lens:typescript-dual-verification-v1",
    },
  });

  await expect(requireCurrentLensPass(root, gitChangeRef)).resolves.toBe(evidence.ref);

  await writeFile(join(root, "index.ts"), "export const value = 2;\n");
  await expect(requireCurrentLensPass(root, gitChangeRef)).rejects.toThrow(
    /current Pass Lens receipt required/,
  );
});

test("removes terminal worktree from artifact repository when daemon cwd is unrelated", async () => {
  const fixture = await cleanupFixture();

  await expect(fixture.service.cleanup(fixture.artifactRef)).resolves.toMatchObject({
    body: { lifecycle: "cleaned", worktree: { status: "cleaned" } },
  });
  expect(fixture.removalCwds).toEqual([fixture.repositoryRoot]);
  await expect(access(fixture.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
});

describe.each([
  ["dirty worktree", { dirty: true }, "uncommitted changes"],
  ["nonterminal PR", { nonterminal: true }, "PR is not terminal"],
  ["uncovered commit", { uncovered: true }, "not covered by origin"],
  ["non-Spark ownership", { ownership: "external" as const }, "externally owned"],
])("cleanup negative gate: %s", (_name, options, blocker) => {
  test("preserves the worktree", async () => {
    const fixture = await cleanupFixture(options);

    await expect(fixture.service.cleanup(fixture.artifactRef)).rejects.toMatchObject({
      code: "cleanup_blocked",
      message: expect.stringContaining(blocker),
    });
    await expect(access(fixture.worktreePath)).resolves.toBeUndefined();
    expect(fixture.removalCwds).toEqual([]);
  });
});

interface CleanupFixtureOptions {
  dirty?: boolean;
  nonterminal?: boolean;
  uncovered?: boolean;
  ownership?: "spark" | "external";
}

async function cleanupFixture(options: CleanupFixtureOptions = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "spark-cleanup-workspace-"));
  const daemonCwd = await mkdtemp(join(tmpdir(), "spark-cleanup-daemon-cwd-"));
  const repositoryRoot = join(workspaceRoot, "repository");
  const worktreeRoot = join(workspaceRoot, "managed-worktrees");
  const worktreePath = join(worktreeRoot, "acme", "app", "cleanup-fixture");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  const removalCwds: string[] = [];
  const runner: GitCommandRunner = async (command, args, cwd) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation === "git remote get-url origin") {
      return commandSuccess("git@github.com:acme/app.git\n");
    }
    if (invocation === "git rev-parse --git-common-dir") {
      return commandSuccess(`${join(repositoryRoot, ".git")}\n`);
    }
    if (invocation === "git branch --show-current") return commandSuccess("cleanup-fixture\n");
    if (invocation === "git status --porcelain") {
      return commandSuccess(options.dirty ? " M dirty.ts\n" : "");
    }
    if (args[0] === "rev-list") return commandSuccess(options.uncovered ? "1\n" : "0\n");
    if (invocation === "gh stack view --json") {
      return commandSuccess(
        JSON.stringify({
          trunk: "main",
          currentBranch: "cleanup-fixture",
          branches: [
            {
              name: "cleanup-fixture",
              base: "base-oid",
              isCurrent: true,
              isMerged: !options.nonterminal,
            },
          ],
        }),
      );
    }
    if (args[0] === "pr" && args[1] === "view") {
      return commandSuccess(
        JSON.stringify({
          number: 123,
          title: "Cleanup fixture",
          state: options.nonterminal ? "OPEN" : "MERGED",
          url: "https://github.com/acme/app/pull/123",
          body: "Fixture",
          labels: [],
          headRefName: "cleanup-fixture",
          baseRefName: "main",
          isDraft: false,
          statusCheckRollup: [],
        }),
      );
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      removalCwds.push(cwd);
      await rm(args[2]!, { recursive: true, force: true });
      return commandSuccess("");
    }
    return { stdout: "", stderr: `unexpected command: ${invocation}`, code: 127 };
  };
  const store = defaultArtifactStore(workspaceRoot);
  const artifactRef = "artifact:cleanup-fixture" as ArtifactRef;
  await store.put({
    ref: artifactRef,
    kind: "git_change",
    title: "Cleanup fixture",
    format: "json",
    body: {
      schemaVersion: 2,
      kind: "git_change",
      repository: {
        forge: "github",
        repo: "acme/app",
        remote: "git@github.com:acme/app.git",
        commonGitDir: join(repositoryRoot, ".git"),
      },
      trunk: "main",
      worktree: {
        path: worktreePath,
        branch: "cleanup-fixture",
        ownership: options.ownership ?? "spark",
        status: "attached",
      },
      stack: {
        authority: "gh-stack",
        currentBranch: "cleanup-fixture",
        entries: [],
        observedAt: new Date().toISOString(),
      },
      lifecycle: "terminal",
    },
  });
  return {
    artifactRef,
    repositoryRoot,
    removalCwds,
    service: new GitLifecycleService({
      cwd: daemonCwd,
      workspaceRoot,
      worktreeRoot,
      runner,
      store,
    }),
    worktreePath,
  };
}

function commandSuccess(stdout: string) {
  return { stdout, stderr: "", code: 0 };
}
