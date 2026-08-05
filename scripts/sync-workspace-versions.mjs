#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { npmDistributions } from "./npm-distributions.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--write");
if (unknownArguments.length > 0) {
  throw new Error("Usage: node scripts/sync-workspace-versions.mjs [--write]");
}

const rootManifestPath = resolve(root, "package.json");
const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
if (rootManifest.name !== "@zendev-lab/spark" || rootManifest.private !== true) {
  throw new Error("The private root manifest must own the @zendev-lab/spark product identity");
}
if (typeof rootManifest.version !== "string" || !rootManifest.version) {
  throw new Error("The root manifest must declare a release version");
}

const expectedApplicationNames = new Map([
  ["apps/spark-cli", "@zendev-lab/spark-cli"],
  ["apps/spark-cockpit", "@zendev-lab/spark-hub"],
  ["apps/spark-daemon", "@zendev-lab/spark-daemon"],
  ["apps/spark-tui", "@zendev-lab/spark-tui"],
]);
const expectedProducts = new Set([rootManifest.name, ...expectedApplicationNames.values()]);
const configuredProducts = new Set(
  npmDistributions.map((distribution) => distribution.packageName),
);
const compareStrings = (left, right) => left.localeCompare(right);
if (
  JSON.stringify([...configuredProducts].sort(compareStrings)) !==
  JSON.stringify([...expectedProducts].sort(compareStrings))
) {
  throw new Error("The npm distribution inventory does not match the root and executable apps");
}

const failures = [];
let updates = 0;
for (const workspaceRoot of ["apps", "packages"]) {
  for (const entry of await readdir(resolve(root, workspaceRoot), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "spark-mcp-spike") continue;
    const manifestPath = resolve(root, workspaceRoot, entry.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const workspacePath = `${workspaceRoot}/${entry.name}`;
    const expectedName = expectedApplicationNames.get(workspacePath);
    if (expectedName && manifest.name !== expectedName) {
      failures.push(`${workspacePath} must be named ${expectedName}, received ${manifest.name}`);
    }
    if (manifest.version === rootManifest.version) continue;
    if (!write) {
      failures.push(
        `${workspacePath} (${manifest.name}) version ${manifest.version} must match ${rootManifest.version}`,
      );
      continue;
    }
    manifest.version = rootManifest.version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    updates += 1;
  }
}

if (failures.length > 0) {
  throw new Error(`Workspace release identity is inconsistent:\n- ${failures.join("\n- ")}`);
}
console.log(
  write
    ? `Synchronized ${updates} workspace version(s) to ${rootManifest.version}.`
    : `Workspace release identity valid at ${rootManifest.version}.`,
);
