import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

import { assertSafeCapabilityCeOutputDirectory } from "../scripts/capability-ce-output-directory.mts";

const ignoredTestSearchDirectories = new Set([
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const testFilePattern = /\.(?:spec|test)\.(?:[cm]?[jt]sx?|svelte)$/u;

interface WorkspaceManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function parseJson<T>(source: string, label: string): T {
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new Error(`Failed to parse ${label}`, { cause: error });
  }
}

function mutationOwnershipViolations(manifest: WorkspaceManifest): string[] {
  const violations: string[] = [];
  if (manifest.scripts?.["test:mutation"] !== "stryker run") violations.push("command");
  if (manifest.devDependencies?.["@stryker-mutator/core"] !== "catalog:") {
    violations.push("core dependency");
  }
  if (manifest.devDependencies?.["@stryker-mutator/vitest-runner"] !== "catalog:") {
    violations.push("runner dependency");
  }
  return violations;
}

test("workspace scripts keep tests and mutation checks with their package owner", async () => {
  for (const workspaceRoot of ["apps", "packages"]) {
    const entries = await readdir(resolve(workspaceRoot), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = resolve(workspaceRoot, entry.name, "package.json");
      let source: string;
      try {
        source = await readFile(manifestPath, "utf8");
      } catch {
        continue;
      }
      const manifest = parseJson<WorkspaceManifest>(source, manifestPath);
      const workspace = `${workspaceRoot}/${entry.name}`;
      if (workspace !== "apps/spark-daemon") {
        assert.notEqual(
          manifest.scripts?.check,
          "vp check --no-fmt --no-lint .",
          `${workspace} should rely on the root typecheck`,
        );
      }
      if (manifest.scripts?.["test:mutation"] !== undefined) {
        assert.deepEqual(
          mutationOwnershipViolations(manifest),
          [],
          `${workspace} must use its package-local Stryker command and catalog dependencies`,
        );
        await readFile(resolve(workspace, "stryker.config.json"), "utf8");
      }
      if (workspaceRoot === "packages" && (await hasTestFiles(resolve(workspace)))) {
        assert.ok(manifest.scripts?.test, `${workspace} must expose its tests`);
        assert.match(
          manifest.scripts.check ?? "",
          /vp test run/u,
          `${workspace} check must retain its package-local tests`,
        );
      }
    }
  }
});

test("package-local mutation ownership rejects independently injected generic defects", () => {
  const valid = {
    scripts: { "test:mutation": "stryker run" },
    devDependencies: {
      "@stryker-mutator/core": "catalog:",
      "@stryker-mutator/vitest-runner": "catalog:",
    },
  };
  const defects = [
    {
      name: "command",
      manifest: { ...valid, scripts: { "test:mutation": "node scripts/run-leaf-mutation.mjs" } },
    },
    {
      name: "core dependency",
      manifest: {
        ...valid,
        devDependencies: { ...valid.devDependencies, "@stryker-mutator/core": "1.0.0" },
      },
    },
    {
      name: "runner dependency",
      manifest: {
        ...valid,
        devDependencies: { ...valid.devDependencies, "@stryker-mutator/vitest-runner": "1.0.0" },
      },
    },
  ];
  for (const defect of defects) {
    assert.deepEqual(mutationOwnershipViolations(defect.manifest), [defect.name]);
  }
});

test("prek uses native integrations and reserves system hooks for fixes", async () => {
  const prek = await readFile(resolve("prek.toml"), "utf8");
  assert.match(prek, /github\.com\/rhysd\/actionlint/u);
  assert.match(prek, /github\.com\/zizmorcore\/zizmor-pre-commit/u);
  const local = prek.slice(prek.indexOf('repo = "local"'));
  assert.match(local, /id = "spark-check-fix"/u);
  assert.match(local, /entry = "pnpm run fix"/u);
  assert.doesNotMatch(local, /pnpm run check:|spark-test-quality|spark-architecture/u);
});

test("capability CE output cleanup cannot traverse reports symlinks", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "spark-capability-ce-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "spark-capability-ce-outside-"));
  try {
    const reportsRoot = join(repositoryRoot, "reports");
    await mkdir(reportsRoot, { recursive: true });
    await symlink(outside, join(reportsRoot, "redirect"));

    await assert.rejects(
      assertSafeCapabilityCeOutputDirectory({
        repositoryRoot,
        outputDir: join(reportsRoot, "redirect", "run"),
      }),
      /must not traverse a symbolic link/u,
    );
    await assert.doesNotReject(
      assertSafeCapabilityCeOutputDirectory({
        repositoryRoot,
        outputDir: join(reportsRoot, "capability-ce"),
      }),
    );
  } finally {
    await Promise.all([
      rm(repositoryRoot, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

async function hasTestFiles(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && testFilePattern.test(entry.name)) return true;
    if (
      entry.isDirectory() &&
      !ignoredTestSearchDirectories.has(entry.name) &&
      (await hasTestFiles(resolve(directory, entry.name)))
    ) {
      return true;
    }
  }
  return false;
}
