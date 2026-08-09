import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

import { assertSafeCapabilityCeOutputDirectory } from "../scripts/capability-ce-output-directory.mts";

const canonicalRootScripts = [
  "audit",
  "audit:renderer",
  "bench:lens",
  "bench:lens:codspeed",
  "build",
  "build:docs",
  "check",
  "check:architecture",
  "check:evidence-surface",
  "check:boundaries",
  "check:docs",
  "check:static",
  "check:test-quality",
  "deploy:docs",
  "dev:docs",
  "fix",
  "prepare",
  "preview",
  "preview:docs",
  "release:pack",
  "report:hygiene",
  "smoke",
  "test",
  "test:browser:hub",
  "test:capability",
  "test:capability:ce",
  "test:mutation",
  "test:process:source",
  "test:unit",
  "typecheck",
];
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

test("root package exposes one compact validation and release surface", async () => {
  const manifest = parseJson<{ scripts?: Record<string, string> }>(
    await readFile(resolve("package.json"), "utf8"),
    "root package manifest",
  );
  const scripts = manifest.scripts ?? {};

  assert.deepEqual(Object.keys(scripts).toSorted(), canonicalRootScripts.toSorted());
  assert.equal(scripts.smoke, "node scripts/smoke-npm-product.mjs");
  assert.equal(scripts["release:pack"], "node scripts/pack-release.mjs");
  assert.equal(scripts.test, "vp test run --config vitest.root.config.ts");
  assert.equal(scripts["check:test-quality"], "node scripts/check-test-quality.mjs");
  assert.equal(scripts["test:browser:hub"], "pnpm --filter @zendev-lab/spark-hub run test:browser");
  assert.equal(scripts["test:capability"], "vp test run --config vitest.capability.config.ts");
  assert.equal(
    scripts["test:mutation"],
    "pnpm -r --workspace-concurrency=1 --filter './packages/*' --if-present run test:mutation",
  );
  assert.equal(
    scripts["test:capability:ce"],
    "node --experimental-strip-types scripts/run-nightly-capability-ce.mts",
  );
  assert.equal(
    scripts.check,
    "pnpm run check:static && pnpm run check:docs && pnpm run test:unit && pnpm run test:process:source",
  );
  assert.equal(scripts["build:docs"], "pnpm --filter @zendev-lab/spark-docs run build");
  assert.equal(scripts["check:docs"], "pnpm --filter @zendev-lab/spark-docs run check");
  assert.equal(
    scripts["check:architecture"],
    "node scripts/validate-architecture-inventory.mjs && syncpack lint --config .syncpackrc.json --no-ansi && node scripts/check-architecture-ratchets.mjs",
  );
  assert.equal(scripts["check:evidence-surface"], "node scripts/check-evidence-surface.mjs");
  assert.equal(
    scripts["check:boundaries"],
    "depcruise --config .dependency-cruiser.cjs apps packages test",
  );
  assert.equal(scripts["deploy:docs"], "pnpm --filter @zendev-lab/spark-docs run deploy");
  assert.equal(scripts["dev:docs"], "pnpm --filter @zendev-lab/spark-docs run dev");
  assert.equal(scripts["preview:docs"], "pnpm --filter @zendev-lab/spark-docs run preview");
  assert.equal(scripts["test:process:source"], "vp test run --config vitest.process.config.ts");
  assert.match(scripts.fix ?? "", /^pnpm --filter @zendev-lab\/spark-hub exec svelte-kit sync/u);
  for (const requiredCheckPhase of [
    "pnpm --filter @zendev-lab/spark-docs exec astro sync",
    "node scripts/sync-workspace-versions.mjs",
    "pnpm run check:architecture",
    "node scripts/check-npm-product.mjs",
    "node --experimental-strip-types scripts/check-lens-release.mts",
    "pnpm run check:evidence-surface",
    "pnpm run check:boundaries",
    "pnpm run check:test-quality",
    "node scripts/check-doc-terminology.mjs",
    "node scripts/check-hub-terminology.mjs",
    "vp fmt . --check",
    "vp lint --quiet",
    "pnpm run typecheck",
  ]) {
    assert.ok(
      scripts["check:static"]?.includes(requiredCheckPhase),
      `check:static must run ${requiredCheckPhase}`,
    );
  }
  for (const requiredUnitPhase of [
    "pnpm --filter @zendev-lab/spark-hub exec svelte-kit sync",
    "vp test run --config vitest.root.config.ts",
    "pnpm -r --filter './packages/*' --if-present run check",
    "pnpm --filter @zendev-lab/spark-hub run test",
    "pnpm --filter @zendev-lab/spark-daemon run test",
  ]) {
    assert.ok(
      scripts["test:unit"]?.includes(requiredUnitPhase),
      `test:unit must run ${requiredUnitPhase}`,
    );
  }
  assert.match(
    scripts["test:unit"] ?? "",
    /^pnpm --filter @zendev-lab\/spark-hub exec svelte-kit sync/u,
  );
  for (const requiredFixPhase of [
    "vp fmt . --write",
    "vp lint --fix --quiet",
    "pnpm run typecheck",
  ]) {
    assert.ok(scripts.fix?.includes(requiredFixPhase), `fix must run ${requiredFixPhase}`);
  }
  assert.match(scripts.typecheck ?? "", /^pnpm --filter @zendev-lab\/spark-hub run check/u);
  assert.match(scripts.typecheck ?? "", /vp check --no-fmt --no-lint/u);
  assert.match(scripts.typecheck ?? "", /@zendev-lab\/spark-daemon run check$/u);
  assert.doesNotMatch(
    Object.keys(scripts).join("\n"),
    /(?:test:file|(?:build|check|test|publish):npm-product|check:distribution)/u,
  );
});

test("workspace scripts contain package-local behavior instead of root boilerplate", async () => {
  let mutationPackageCount = 0;
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
        mutationPackageCount += 1;
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
      if (workspace === "packages/spark-i18n") {
        assert.match(manifest.scripts?.check ?? "", /pnpm run generate/u);
      }
      if (workspace === "packages/spark-hub-db") {
        assert.match(manifest.scripts?.check ?? "", /check-schema-types\.mjs/u);
      }
    }
  }
  assert.equal(mutationPackageCount, 12, "mutation CE coverage must not shrink silently");
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

test("docs production scripts separate Workers Builds build and deploy phases", async () => {
  const manifest = parseJson<{ scripts?: Record<string, string> }>(
    await readFile(resolve("apps/spark-docs/package.json"), "utf8"),
    "Spark docs package manifest",
  );
  const scripts = manifest.scripts ?? {};

  assert.equal(scripts["build:cloudflare"], "pnpm run check:deploy && pnpm run check");
  assert.equal(scripts["deploy:cloudflare"], "wrangler deploy");
  assert.equal(scripts.deploy, "pnpm run build:cloudflare && pnpm run deploy:cloudflare");
});

test("CI, CD, CE, and prek keep distinct validation ownership", async () => {
  const [
    staticWorkflow,
    releaseWorkflow,
    testsWorkflow,
    smokeWorkflow,
    hygieneWorkflow,
    behaviorWorkflow,
    mutationCiWorkflow,
    mutationCeWorkflow,
    prek,
  ] = await Promise.all([
    readFile(resolve(".github/workflows/ci-static-checks.yml"), "utf8"),
    readFile(resolve(".github/workflows/cd-publish.yml"), "utf8"),
    readFile(resolve(".github/workflows/ci-tests.yml"), "utf8"),
    readFile(resolve(".github/workflows/ci-smoke.yml"), "utf8"),
    readFile(resolve(".github/workflows/ce-hygiene.yml"), "utf8"),
    readFile(resolve(".github/workflows/ce-behavior.yml"), "utf8"),
    readFile(resolve(".github/workflows/ci-mutation.yml"), "utf8"),
    readFile(resolve(".github/workflows/ce-mutation.yml"), "utf8"),
    readFile(resolve("prek.toml"), "utf8"),
  ]);

  assert.match(staticWorkflow, /pnpm run check:static/u);
  assert.match(staticWorkflow, /pnpm run check:docs/u);

  assert.match(releaseWorkflow, /pull_request:/u);
  assert.match(releaseWorkflow, /merge_group:/u);
  assert.match(releaseWorkflow, /name: Documentation Deployment Dry Run/u);
  assert.match(releaseWorkflow, /wrangler deploy --dry-run/u);
  assert.match(releaseWorkflow, /name: Container Build and Smoke/u);
  assert.match(releaseWorkflow, /name: Release Build/u);
  assert.match(releaseWorkflow, /pnpm run release:pack/u);
  assert.match(releaseWorkflow, /Smoke the exact lockstep artifacts/u);
  assert.match(releaseWorkflow, /Verify N-1 expand-only migration compatibility/u);
  assert.doesNotMatch(releaseWorkflow, /pnpm run check(?:\s|$)/u);
  assert.doesNotMatch(releaseWorkflow, /test:browser:hub/u);
  assert.match(releaseWorkflow, /if: github\.ref_type == 'tag'/u);
  assert.match(releaseWorkflow, /if: github\.event_name == 'push' && github\.ref_type == 'tag'/u);

  assert.match(testsWorkflow, /pnpm run test:unit/u);
  assert.match(testsWorkflow, /pnpm run test:process:source/u);
  assert.match(testsWorkflow, /pnpm run test:browser:hub/u);
  assert.match(smokeWorkflow, /pnpm run smoke/u);

  for (const workflow of [staticWorkflow, releaseWorkflow, testsWorkflow, smokeWorkflow]) {
    assert.doesNotMatch(workflow, /test:npm-product/u);
    assert.doesNotMatch(workflow, /re-actors\/alls-green/u);
    assert.doesNotMatch(workflow, /name: required/u);
  }
  await assert.rejects(readFile(resolve(".github/workflows/ci-build.yml"), "utf8"));
  await assert.rejects(readFile(resolve(".github/workflows/ci-verify.yml"), "utf8"));

  assert.doesNotMatch(releaseWorkflow, /--baseline-version/u);
  assert.doesNotMatch(releaseWorkflow, /secrets\.NPM_TOKEN/u);
  assert.match(releaseWorkflow, /id-token: write/u);
  assert.match(releaseWorkflow, /--cli-tarball "dist\/release\/spark-cli-\$\{RELEASE_TAG\}\.tgz"/u);

  assert.match(hygieneWorkflow, /pnpm run report:hygiene/u);
  assert.doesNotMatch(hygieneWorkflow, /pnpm exec (?:knip|jscpd)/u);

  assert.match(behaviorWorkflow, /schedule:/u);
  assert.doesNotMatch(behaviorWorkflow, /pull_request:/u);
  assert.match(behaviorWorkflow, /pnpm run test:capability:ce/u);
  assert.match(behaviorWorkflow, /run-scripted-provider-ce\.mts/u);
  assert.match(behaviorWorkflow, /continue-on-error: true/u);
  assert.match(behaviorWorkflow, /reports\/capability-ce\//u);
  assert.match(behaviorWorkflow, /reports\/scripted-provider-ce\//u);

  assert.match(mutationCiWorkflow, /pull_request:/u);
  assert.match(mutationCiWorkflow, /Run focused mutation tests/u);
  assert.doesNotMatch(mutationCiWorkflow, /schedule:/u);
  assert.match(mutationCeWorkflow, /schedule:/u);
  assert.doesNotMatch(mutationCeWorkflow, /pull_request:/u);
  assert.match(mutationCeWorkflow, /pnpm run test:mutation/u);
  assert.match(mutationCeWorkflow, /continue-on-error: true/u);

  assert.match(prek, /id = "spark-check-fix"/u);
  assert.match(prek, /entry = "pnpm run fix"/u);
  assert.doesNotMatch(prek, /pnpm run check:/u);
  assert.doesNotMatch(
    prek,
    /architecture-ratchet-check|pi-boundary-check|spark-doc-terminology-check/u,
  );
});

test("replacement CI owners pin every direct action to an immutable commit", async () => {
  const ownerPaths = [
    ".github/workflows/ci-pr-checks.yml",
    ".github/workflows/ci-static-checks.yml",
    ".github/workflows/cd-publish.yml",
    ".github/workflows/ci-tests.yml",
    ".github/workflows/ci-smoke.yml",
    ".github/workflows/ci-benchmarks.yml",
    ".github/workflows/ci-mutation.yml",
  ];
  for (const path of ownerPaths) {
    const source = await readFile(resolve(path), "utf8");
    const actions = [...source.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gmu)].map(
      (match) => match[1],
    );
    assert.ok(actions.length > 0, `${path} must declare at least one action`);
    for (const action of actions) {
      assert.match(action, /@[a-f0-9]{40}$/u, `${path} must pin ${action}`);
    }
  }

  for (const retiredPath of [
    ".github/workflows/ci.yml",
    ".github/workflows/ci-build.yml",
    ".github/workflows/ci-context-migration.yml",
    ".github/workflows/ci-typos.yml",
    ".github/workflows/ci-verify.yml",
  ]) {
    await assert.rejects(readFile(resolve(retiredPath), "utf8"));
  }
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
