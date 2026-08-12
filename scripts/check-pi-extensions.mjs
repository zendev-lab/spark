#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validatePiExtensionManifest } from "./pi-extension-topology.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifestPath = join(repositoryRoot, "package.json");

async function validateManifestFiles(manifest, manifestDirectory, rootProfile) {
  const failures = validatePiExtensionManifest(manifest, { rootProfile });
  const record = asRecord(manifest);
  const pi = asRecord(record?.pi);
  const extensions = pi?.extensions;
  if (!Array.isArray(extensions)) return failures;

  const name = typeof record?.name === "string" ? record.name : "<unnamed>";
  for (const specifier of extensions) {
    if (typeof specifier !== "string" || !specifier.startsWith(".")) continue;
    const entryPath = resolve(manifestDirectory, specifier);
    try {
      const details = await stat(entryPath);
      if (!details.isFile()) failures.push(`${name} pi extension ${specifier} is not a file.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      failures.push(`${name} pi extension ${specifier} points to a missing file.`);
    }
  }
  return failures;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function workspaceManifestPaths() {
  const paths = [rootManifestPath];
  for (const workspaceDirectory of ["apps", "packages"]) {
    const directory = join(repositoryRoot, workspaceDirectory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(directory, entry.name, "package.json");
      try {
        const details = await stat(manifestPath);
        if (details.isFile()) paths.push(manifestPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return paths;
}

async function main() {
  const failures = [];
  const manifestPaths = await workspaceManifestPaths();
  for (const manifestPath of manifestPaths) {
    const manifest = await readJson(manifestPath);
    failures.push(
      ...(await validateManifestFiles(
        manifest,
        dirname(manifestPath),
        manifestPath === rootManifestPath,
      )),
    );
  }

  if (failures.length > 0) {
    console.error(
      ["Pi extension topology failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Pi extension topology passed (${manifestPaths.length} manifests checked).`);
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
