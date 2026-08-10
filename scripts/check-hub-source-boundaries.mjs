#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const hubRoot = join(repositoryRoot, "apps", "spark-hub", "src");
const coordinationRoot = join(repositoryRoot, "packages", "spark-hub-coordination", "src");
const removedServerFacades = [
  "agents-product.ts",
  "artifact-cache.ts",
  "command-submission.ts",
  "events.ts",
  "liveness.ts",
  "project-hub.ts",
  "projection-services.ts",
  "runtime-registration.ts",
  "runtime-ws.ts",
  "session-activity.ts",
];

export function hubSourceBoundaryViolations(path, source) {
  const normalizedPath = path.replaceAll("\\", "/");
  const violations = [];
  if (
    normalizedPath.includes("apps/spark-hub/src/routes/") &&
    normalizedPath.endsWith("+page.server.ts")
  ) {
    if (/\.prepare\s*\(/u.test(source)) violations.push("page load opens SQL directly");
  }
  if (
    normalizedPath.includes("apps/spark-hub/src/") &&
    !normalizedPath.includes("/src/lib/server/") &&
    /from\s+["']@zendev-lab\/spark-hub-db/u.test(source)
  ) {
    violations.push("Hub presentation imports spark-hub-db directly");
  }
  if (/from\s+["']@zendev-lab\/spark-daemon(?:\/|["'])/u.test(source)) {
    violations.push("Hub source imports daemon internals");
  }
  if (
    source.includes('resolveSparkPaths({ app: "daemon" })') ||
    source.includes('".spark", "artifacts"') ||
    source.includes("'.spark', 'artifacts'") ||
    source.includes(".spark/artifacts")
  ) {
    violations.push("Hub source bypasses protocol artifact access");
  }
  if (
    source.includes("@zendev-lab/spark-session") ||
    source.includes("session-registry/v1") ||
    /(?:writeFile[\s\S]*session-registry|session-registry[\s\S]*writeFile)/u.test(source)
  ) {
    violations.push("Hub source bypasses daemon-owned session mutations");
  }
  return violations;
}

export async function checkHubSourceBoundaries() {
  const violations = [];
  const sourceFiles = [
    ...(await collectSourceFiles(hubRoot)),
    ...(await collectSourceFiles(coordinationRoot)),
  ];
  for (const path of sourceFiles) {
    const displayPath = relative(repositoryRoot, path).split(sep).join("/");
    const source = await readFile(path, "utf8");
    for (const violation of hubSourceBoundaryViolations(displayPath, source)) {
      violations.push(`${displayPath}: ${violation}`);
    }
  }

  const serverRoot = join(hubRoot, "lib", "server");
  const serverEntries = new Set((await readdir(serverRoot)).map((entry) => entry));
  for (const facade of removedServerFacades) {
    if (serverEntries.has(facade)) {
      violations.push(`apps/spark-hub/src/lib/server/${facade}: retired facade must stay removed`);
    }
  }
  return { sourceFileCount: sourceFiles.length, violations };
}

async function collectSourceFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectSourceFiles(path)));
      continue;
    }
    if (
      entry.isFile() &&
      /\.(?:svelte|ts)$/u.test(entry.name) &&
      !/\.(?:test|spec)\.ts$/u.test(entry.name)
    ) {
      paths.push(path);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

async function main() {
  const result = await checkHubSourceBoundaries();
  if (result.violations.length > 0) {
    console.error("Hub source boundary check failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Hub source boundary check passed (${result.sourceFileCount} production files).`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
