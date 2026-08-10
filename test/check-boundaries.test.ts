import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const configPath = resolve(".dependency-cruiser.cjs");
const docTerminologyScriptPath = resolve("scripts/check-doc-terminology.mjs");
const hubI18nBoundaryFixturePath = resolve(
  "test/fixtures/boundaries/spark-i18n-hub-surface-private.ts.fixture",
);

test("production circular rule rejects a real TypeScript cycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-depcruise-cycle-"));
  try {
    const fixture = join(root, "packages", "cycle-fixture");
    await mkdir(fixture, { recursive: true });
    await Promise.all([
      writeFile(join(fixture, "a.ts"), `import "./b.js";\n`),
      writeFile(join(fixture, "b.ts"), `import "./a.js";\n`),
    ]);

    const binary = resolve("node_modules/dependency-cruiser/bin/dependency-cruise.mjs");
    const baseArgs = [binary, "--config", configPath, "packages/cycle-fixture"];
    const errorResult = spawnSync(process.execPath, baseArgs, { cwd: root, encoding: "utf8" });
    assert.notEqual(errorResult.status, 0, errorResult.stderr);

    const jsonResult = spawnSync(
      process.execPath,
      [binary, "--config", configPath, "--output-type", "json", "packages/cycle-fixture"],
      { cwd: root, encoding: "utf8" },
    );
    const report = JSON.parse(jsonResult.stdout) as {
      summary?: {
        error?: number;
        violations?: Array<{ rule?: { name?: string; severity?: string } }>;
      };
    };
    const violations = report.summary?.violations ?? [];
    assert.ok((report.summary?.error ?? 0) > 0);
    assert.deepEqual(
      violations.map((violation) => violation.rule?.name),
      ["production-no-circular"],
    );
    assert.equal(violations[0]?.rule?.severity, "error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency-cruiser rejects non-Hub imports of the Hub i18n surface", async () => {
  const fixtureParent = resolve(".spark");
  await mkdir(fixtureParent, { recursive: true });
  const fixtureRoot = await mkdtemp(join(fixtureParent, "depcruise-hub-i18n-"));
  try {
    const fixturePath = join(fixtureRoot, "index.ts");
    await writeFile(fixturePath, await readFile(hubI18nBoundaryFixturePath, "utf8"));
    const result = spawnSync("pnpm", ["exec", "depcruise", "--config", configPath, fixturePath], {
      cwd: resolve("."),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /spark-i18n-hub-surface-private/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("dependency-cruiser rejects presentation dependency imports outside spark-ui", async () => {
  const fixtureParent = resolve(".spark");
  await mkdir(fixtureParent, { recursive: true });
  const fixtureRoot = await mkdtemp(join(fixtureParent, "depcruise-presentation-owner-"));
  try {
    const fixturePath = join(fixtureRoot, "index.ts");
    await writeFile(fixturePath, 'import { Button } from "bits-ui";\nvoid Button;\n');
    const result = spawnSync("pnpm", ["exec", "depcruise", "--config", configPath, fixturePath], {
      cwd: resolve("."),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /spark-ui-owns-presentation-dependencies/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("documentation terminology checker rejects retired product package names in active docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-doc-term-"));
  const retiredProduct = ["na", "via"].join("");
  await writeFile(
    join(root, "README.md"),
    `# Example\n\nUse @zendev-lab/${retiredProduct}-db as the product database package.\n`,
  );

  const terminologyResult = spawnSync(process.execPath, [docTerminologyScriptPath], {
    cwd: resolve("."),
    env: { ...process.env, SPARK_DOC_TERMINOLOGY_ROOT: root },
    encoding: "utf8",
  });

  assert.notEqual(terminologyResult.status, 0);
  assert.match(terminologyResult.stderr, /retired product terminology/u);
});

test("documentation terminology checker rejects retired product app names in active docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-doc-term-"));
  const retiredProduct = ["na", "via"].join("");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs/tools.md"),
    `# Tools\n\nUse apps/${retiredProduct}-web for the web app.\n`,
  );

  const terminologyResult = spawnSync(process.execPath, [docTerminologyScriptPath], {
    cwd: resolve("."),
    env: { ...process.env, SPARK_DOC_TERMINOLOGY_ROOT: root },
    encoding: "utf8",
  });

  assert.notEqual(terminologyResult.status, 0);
  assert.match(terminologyResult.stderr, /retired product terminology/u);
});
