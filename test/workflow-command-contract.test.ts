import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { test } from "vitest";

interface PackageManifest {
  scripts?: Record<string, string>;
  os?: string[];
}

interface ArchitectureManifest {
  packages?: Record<string, { path: string }>;
}

const workflowsRoot = resolve(".github/workflows");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

async function workflowSources(): Promise<Array<{ file: string; source: string }>> {
  const files = (await readdir(workflowsRoot))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .toSorted();
  return await Promise.all(
    files.map(async (file) => ({
      file,
      source: await readFile(resolve(workflowsRoot, file), "utf8"),
    })),
  );
}

test("workflow pnpm commands resolve to existing repository scripts", async () => {
  const rootManifest = await readJson<PackageManifest>("package.json");
  const architecture = await readJson<ArchitectureManifest>("architecture/packages.json");
  const workspaceManifests = new Map<string, PackageManifest>();
  for (const [name, entry] of Object.entries(architecture.packages ?? {})) {
    workspaceManifests.set(name, await readJson<PackageManifest>(`${entry.path}/package.json`));
  }

  for (const { file, source } of await workflowSources()) {
    for (const match of source.matchAll(
      /pnpm\s+--filter\s+(?:["']([^"']+)["']|([^\s\\]+))\s+run\s+([\w:-]+)/gu,
    )) {
      const workspace = match[1] ?? match[2];
      const script = match[3];
      assert.ok(workspace);
      assert.ok(script);
      if (!workspace.startsWith("@zendev-lab/")) continue;
      const manifest = workspaceManifests.get(workspace);
      assert.ok(manifest, `${file}: unknown pnpm workspace filter ${workspace}`);
      assert.ok(manifest.scripts?.[script], `${file}: ${workspace} does not expose script ${script}`);
    }

    for (const match of source.matchAll(/pnpm\s+run\s+([\w:-]+)/gu)) {
      const script = match[1];
      assert.ok(script);
      assert.ok(rootManifest.scripts?.[script], `${file}: root package does not expose script ${script}`);
    }
  }
});

test("release workflow uses current Hub commands and selects the actual N-1 release", async () => {
  const source = await readFile(resolve(workflowsRoot, "cd-publish.yml"), "utf8");

  assert.doesNotMatch(source, /@zendev-lab\/spark-cockpit\b/u);
  assert.doesNotMatch(source, /\btest:browser:cockpit\b/u);
  assert.match(source, /pnpm --filter @zendev-lab\/spark-hub run setup:browser/u);
  assert.match(source, /pnpm run test:browser:hub/u);
  assert.match(source, /scripts\/test-release-migration\.mjs --tarball/u);
  assert.doesNotMatch(source, /test-release-migration\.mjs[^\n]*--baseline-version/u);
});

test("package and CI support exactly Linux and macOS", async () => {
  const rootManifest = await readJson<PackageManifest>("package.json");
  const verifyWorkflow = await readFile(resolve(workflowsRoot, "ci-verify.yml"), "utf8");
  const unitCommand = rootManifest.scripts?.["test:unit"] ?? "";

  assert.deepEqual(rootManifest.os, ["darwin", "linux"]);
  assert.match(unitCommand, /@zendev-lab\/spark-cli run check/u);
  assert.match(unitCommand, /@zendev-lab\/spark-tui-app run test/u);
  assert.match(verifyWorkflow, /supported-platforms:/u);
  assert.match(verifyWorkflow, /- ubuntu-latest/u);
  assert.match(verifyWorkflow, /- macos-latest/u);
  assert.doesNotMatch(verifyWorkflow, /windows-latest/u);
  assert.match(verifyWorkflow, /needs:[\s\S]*- supported-platforms/u);
  assert.match(verifyWorkflow, /pnpm run test:process:source/u);
});
