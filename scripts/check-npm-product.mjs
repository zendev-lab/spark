#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveProductRuntimeDependencies } from "./product-runtime-closure.mjs";

const root = process.cwd();
const productDirectory = resolve(root, "dist/npm-package");
const productManifestPath = resolve(productDirectory, "package.json");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(directory, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const failures = [];
const thirdPartyNoticePath = resolve(root, "THIRD_PARTY_NOTICES.md");
if (!(await exists(thirdPartyNoticePath))) {
  failures.push("source tree must include THIRD_PARTY_NOTICES.md");
} else {
  const notices = await readFile(thirdPartyNoticePath, "utf8");
  for (const required of [
    "Sikandar Bhide",
    "fa4bc217f84bc571378bc371332a154106772614",
    "Mitch Fultz",
    "cc2ac14d6a1e2bdf6baa1ee635bda0e08452bdd8",
  ]) {
    if (!notices.includes(required)) failures.push(`third-party notices must retain ${required}`);
  }
}
if (!(await exists(resolve(root, "packages/spark-loop/UPSTREAM-LICENSE.txt")))) {
  failures.push("spark-loop must retain its upstream MIT license");
}
const modelReproductionSkillDirectory = resolve(
  root,
  "packages/spark-host/skills/model-reproduction",
);
if (
  (await exists(modelReproductionSkillDirectory)) &&
  (await countFiles(modelReproductionSkillDirectory)) > 0
) {
  failures.push("Spark must not embed the model-reproduction domain skill");
}
if (rootManifest.private !== true) failures.push("source monorepo root must remain private");
for (const workspaceRoot of ["apps", "packages"]) {
  for (const entry of await readdir(resolve(root, workspaceRoot), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, workspaceRoot, entry.name, "package.json");
    if (!(await exists(manifestPath))) continue;
    const workspace = JSON.parse(await readFile(manifestPath, "utf8"));
    if (workspace.private !== true)
      failures.push(`${workspace.name}: source workspace must be private`);
    if (workspace.publishConfig !== undefined) {
      failures.push(`${workspace.name}: source workspace must not declare publishConfig`);
    }
  }
}
if (await exists(productManifestPath)) {
  const manifest = JSON.parse(await readFile(productManifestPath, "utf8"));
  if (manifest.name !== "@zendev-lab/spark")
    failures.push("product name must be @zendev-lab/spark");
  if (manifest.private === true) failures.push("generated npm product must be publishable");
  for (const name of [
    "spark",
    "spark-tui",
    "spark-daemon",
    "spark-hub",
    "spark-acp",
    "spark-mcp",
    "spark-update",
  ]) {
    if (manifest.bin?.[name] !== `./bin/${name}`) {
      failures.push(`product must expose ${name} as a companion executable`);
    }
  }
  if (manifest.bin?.["spark-cockpit"] !== undefined) {
    failures.push("product must not expose the retired spark-cockpit executable");
  }
  if (
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.registry !== "https://registry.npmjs.org/"
  ) {
    failures.push("product publishConfig must target the public npm registry");
  }
  for (const field of ["keywords", "repository", "homepage", "bugs"]) {
    if (rootManifest[field] !== undefined && manifest[field] === undefined) {
      failures.push(`product must retain root ${field} metadata`);
    }
  }
  if (!manifest.files?.includes("THIRD_PARTY_NOTICES.md")) {
    failures.push("product files must include THIRD_PARTY_NOTICES.md");
  }
  const expectedDependencies = await resolveProductRuntimeDependencies(root, productDirectory);
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(expectedDependencies)) {
    failures.push("product dependencies must match the generated runtime closure");
  }
  for (const asset of [
    "bin/spark",
    "bin/spark-tui",
    "bin/spark-daemon",
    "bin/spark-hub",
    "bin/spark-acp",
    "bin/spark-mcp",
    "bin/spark-update",
    "dist/spark-cli.js",
    "dist/spark-tui.js",
    "dist/spark-daemon.js",
    "dist/spark-headless-role-executor.js",
    "dist/spark-cockpit-server.js",
    "dist/spark-cockpit-web-service.js",
    "dist/spark-mcp.js",
    "dist/spark-update.js",
    "dist/migrations/0001_initial.sql",
    "skills/spark-cue/SKILL.md",
    "THIRD_PARTY_NOTICES.md",
    "build/handler.js",
  ]) {
    if (!(await exists(resolve(productDirectory, asset))))
      failures.push(`missing product asset: ${asset}`);
  }
  if (await exists(resolve(productDirectory, "bin/spark-cockpit"))) {
    failures.push("generated product must omit bin/spark-cockpit");
  }
  if (await exists(resolve(productDirectory, "skills/model-reproduction"))) {
    failures.push("generated product must not include the model-reproduction domain skill");
  }
  const sourceMaps = await (async function countSourceMaps(directory) {
    let count = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) count += await countSourceMaps(path);
      else if (entry.isFile() && entry.name.endsWith(".map")) count += 1;
    }
    return count;
  })(productDirectory);
  if (sourceMaps > 0)
    failures.push(`product must omit runtime-unneeded source maps (found ${sourceMaps})`);
}

if (failures.length) {
  throw new Error(`Invalid npm product:\n- ${failures.join("\n- ")}`);
}
if (await exists(productManifestPath)) {
  const bytes = (await stat(productManifestPath)).size;
  console.log(
    `Npm product policy valid (${await countFiles(productDirectory)} files; manifest ${bytes} bytes).`,
  );
} else {
  console.log("Npm product policy valid.");
}
