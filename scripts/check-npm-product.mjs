#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

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
    "spark-cockpit",
    "spark-acp",
    "spark-update",
  ]) {
    if (manifest.bin?.[name] !== `./bin/${name}`) {
      failures.push(`product must expose ${name} as a companion executable`);
    }
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
  for (const asset of [
    "bin/spark",
    "bin/spark-tui",
    "bin/spark-daemon",
    "bin/spark-cockpit",
    "bin/spark-acp",
    "bin/spark-update",
    "dist/spark-cli.js",
    "dist/spark-tui.js",
    "dist/spark-daemon.js",
    "dist/spark-headless-role-executor.js",
    "dist/spark-cockpit-server.js",
    "dist/spark-update.js",
    "dist/migrations/0001_initial.sql",
    "skills/model-reproduction/SKILL.md",
    "skills/model-reproduction/references/known-diffs/catalog.md",
    "skills/model-reproduction/references/known-diffs/source-notes.md",
    "skills/model-reproduction/references/provenance.md",
    "build/handler.js",
  ]) {
    if (!(await exists(resolve(productDirectory, asset))))
      failures.push(`missing product asset: ${asset}`);
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
