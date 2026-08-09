#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const processOwners = new Set([
  "@zendev-lab/spark-cli",
  "@zendev-lab/spark-daemon",
  "@zendev-lab/spark-tui",
  "@zendev-lab/spark-daemon-client",
  "@zendev-lab/spark-system",
  "@zendev-lab/spark-update",
]);
const browserOwners = new Set([
  "@zendev-lab/spark-hub",
  "@zendev-lab/spark-hub-coordination",
  "@zendev-lab/spark-hub-db",
  "@zendev-lab/spark-ui",
  "@zendev-lab/spark-web",
  "@zendev-lab/spark-i18n",
  "@zendev-lab/spark-protocol",
]);

function isDocumentationPath(path) {
  return (
    path.endsWith(".md") ||
    path === "LICENSE" ||
    path.startsWith("docs/") ||
    path.startsWith("apps/spark-docs/")
  );
}

function workspaceForPath(path, workspaces) {
  return workspaces.find(
    (workspace) =>
      path === `${workspace.path}/package.json` || path.startsWith(`${workspace.path}/`),
  );
}

function affectedWorkspaceNames(changed, workspaces) {
  const affected = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const workspace of workspaces) {
      if (affected.has(workspace.name)) continue;
      if (!workspace.dependencies.some((dependency) => affected.has(dependency))) continue;
      affected.add(workspace.name);
      grew = true;
    }
  }
  return [...affected].sort((left, right) => left.localeCompare(right));
}

export function classifyCiScope(files, workspaces) {
  const normalized = [...new Set(files.map((path) => path.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (normalized.length === 0) return fullScope([], "empty change set");
  if (normalized.every(isDocumentationPath)) {
    return {
      files: normalized,
      reason: "documentation-only change",
      docsOnly: true,
      full: false,
      runSource: false,
      runMacos: false,
      runProcess: false,
      runBrowser: false,
      changedWorkspaces: [],
      affectedWorkspaces: [],
    };
  }

  const changed = new Set();
  for (const path of normalized) {
    if (isDocumentationPath(path)) continue;
    const workspace = workspaceForPath(path, workspaces);
    if (!workspace) return fullScope(normalized, `root or unknown path: ${path}`);
    changed.add(workspace.name);
  }
  if (changed.size === 0) return fullScope(normalized, "no workspace owner resolved");

  const changedWorkspaces = [...changed].sort((left, right) => left.localeCompare(right));
  const affectedWorkspaces = affectedWorkspaceNames(changedWorkspaces, workspaces);
  const runProcess = changedWorkspaces.some((name) => processOwners.has(name));
  const runBrowser = changedWorkspaces.some((name) => browserOwners.has(name));
  return {
    files: normalized,
    reason: "workspace-owned change",
    docsOnly: false,
    full: false,
    runSource: true,
    runMacos: runProcess,
    runProcess,
    runBrowser,
    changedWorkspaces,
    affectedWorkspaces,
  };
}

function fullScope(files, reason) {
  return {
    files,
    reason,
    docsOnly: false,
    full: true,
    runSource: true,
    runMacos: true,
    runProcess: true,
    runBrowser: true,
    changedWorkspaces: [],
    affectedWorkspaces: [],
  };
}

export function loadWorkspaceCatalog(root = repositoryRoot) {
  const inventory = JSON.parse(readFileSync(resolve(root, "architecture/packages.json"), "utf8"));
  return Object.entries(inventory.packages)
    .map(([name, declaration]) => {
      const path = declaration.path;
      const manifest = JSON.parse(readFileSync(resolve(root, path, "package.json"), "utf8"));
      const dependencyFields = [
        manifest.dependencies,
        manifest.devDependencies,
        manifest.optionalDependencies,
        manifest.peerDependencies,
      ];
      return {
        name,
        path,
        dependencies: [...new Set(dependencyFields.flatMap((field) => Object.keys(field ?? {})))],
      };
    })
    .sort((left, right) => right.path.length - left.path.length);
}

function changedFiles(base) {
  if (!/^[a-f0-9]{7,40}$/u.test(base)) throw new Error(`Invalid CI base SHA: ${base}`);
  execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMRTUXB", `${base}...HEAD`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function writeGitHubOutputs(scope, base) {
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (!outputPath) return;
  const outputs = {
    base,
    full: scope.full,
    docs_only: scope.docsOnly,
    run_source: scope.runSource,
    run_macos: scope.runMacos,
    run_process: scope.runProcess,
    run_browser: scope.runBrowser,
    summary_json: JSON.stringify(scope),
  };
  appendFileSync(
    outputPath,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${String(value)}\n`)
      .join(""),
  );
}

function main(argv) {
  const full = argv.includes("--full");
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : "";
  if (!full && !base) throw new Error("Usage: changed-ci-scope.mjs (--full | --base <sha>)");
  const scope = full
    ? fullScope([], "non-pull-request event")
    : classifyCiScope(changedFiles(base), loadWorkspaceCatalog());
  console.log(JSON.stringify(scope));
  writeGitHubOutputs(scope, base);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
