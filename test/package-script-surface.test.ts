import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

import { assertSafeCapabilityCeOutputDirectory } from "../scripts/capability-ce-output-directory.mts";

const canonicalRootScripts = [
  "audit",
  "audit:renderer",
  "build",
  "build:docs",
  "check",
  "check:architecture",
  "check:evidence-surface",
  "check:boundaries",
  "check:docs",
  "check:static",
  "check:test-quality",
  "check:test-quality:update",
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

test("root package exposes one compact validation and release surface", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};

  assert.deepEqual(Object.keys(scripts).toSorted(), canonicalRootScripts.toSorted());
  assert.equal(scripts.smoke, "node scripts/smoke-npm-product.mjs");
  assert.equal(scripts["release:pack"], "node scripts/pack-release.mjs");
  assert.equal(scripts.test, "vp test run --config vitest.root.config.ts");
  assert.equal(scripts["check:test-quality"], "node scripts/check-test-quality.mjs");
  assert.equal(
    scripts["check:test-quality:update"],
    "node scripts/check-test-quality.mjs --update",
  );
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
    "ajv validate --spec=draft2020 --strict=true --all-errors --errors=text -s architecture/packages.schema.json -d architecture/packages.json && syncpack lint --config .syncpackrc.json --no-ansi && node scripts/check-architecture-ratchets.mjs",
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
      const manifest = JSON.parse(source) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
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
        assert.equal(
          manifest.scripts["test:mutation"],
          "stryker run",
          `${workspace} must use its package-local Stryker config`,
        );
        assert.equal(manifest.devDependencies?.["@stryker-mutator/core"], "catalog:");
        assert.equal(manifest.devDependencies?.["@stryker-mutator/vitest-runner"], "catalog:");
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
      if (workspace === "packages/spark-cockpit-db") {
        assert.match(manifest.scripts?.check ?? "", /check-schema-types\.mjs/u);
      }
    }
  }
  assert.equal(mutationPackageCount, 12, "mutation CE coverage must not shrink silently");
});

test("docs production scripts separate Workers Builds build and deploy phases", async () => {
  const manifest = JSON.parse(await readFile(resolve("apps/spark-docs/package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};

  assert.equal(scripts["build:cloudflare"], "pnpm run check:deploy && pnpm run check");
  assert.equal(scripts["deploy:cloudflare"], "wrangler deploy");
  assert.equal(scripts.deploy, "pnpm run build:cloudflare && pnpm run deploy:cloudflare");
});

test("CI and prek consume the canonical package scripts", async () => {
  const [verifyWorkflow, hygieneWorkflow, capabilityWorkflow, prek] = await Promise.all([
    readFile(resolve(".github/workflows/ci-verify.yml"), "utf8"),
    readFile(resolve(".github/workflows/ce-hygiene.yml"), "utf8"),
    readFile(resolve(".github/workflows/ce-capability-nightly.yml"), "utf8"),
    readFile(resolve("prek.toml"), "utf8"),
  ]);

  assert.match(verifyWorkflow, /pnpm run check:static/u);
  assert.match(verifyWorkflow, /pnpm run test:unit/u);
  assert.match(verifyWorkflow, /pnpm run test:process:source/u);
  assert.match(verifyWorkflow, /pnpm run smoke/u);
  assert.match(verifyWorkflow, /pnpm run check:docs/u);
  assert.match(verifyWorkflow, /wrangler deploy --dry-run/u);
  assert.match(verifyWorkflow, /re-actors\/alls-green@05ac9388f0aebcb5727afa17fcccfecd6f8ec5fe/u);
  assert.match(verifyWorkflow, /jobs: \$\{\{ toJSON\(needs\) \}\}/u);
  assert.match(verifyWorkflow, /pnpm run test:browser:hub/u);
  assert.match(verifyWorkflow, /name: required/u);
  assert.doesNotMatch(verifyWorkflow, /test:npm-product/u);
  assert.match(hygieneWorkflow, /pnpm run report:hygiene/u);
  assert.doesNotMatch(hygieneWorkflow, /pnpm exec (?:knip|jscpd)/u);
  assert.match(capabilityWorkflow, /pnpm run test:capability:ce/u);
  assert.match(capabilityWorkflow, /pull_request:/u);
  assert.match(capabilityWorkflow, /schedule:/u);
  assert.match(capabilityWorkflow, /github\.event_name == 'pull_request' && '2'/u);
  assert.match(capabilityWorkflow, /continue-on-error: true/u);
  assert.match(capabilityWorkflow, /reports\/capability-ce\//u);
  assert.match(prek, /id = "spark-check-fix"/u);
  assert.match(prek, /entry = "pnpm run fix"/u);
  assert.doesNotMatch(prek, /pnpm run check:/u);
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
