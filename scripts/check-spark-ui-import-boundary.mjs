import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const allowedRoot = `${resolve(repositoryRoot, "packages/spark-ui")}${sep}`;
const restrictedDependencies = ["@lucide/svelte", "bits-ui", "svelte-streamdown"];
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".svelte", ".ts", ".tsx"]);
const skippedDirectories = new Set([
  ".git",
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "reports",
]);
const importPattern = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gu;
const violations = [];
const observedOwners = new Set();

for (const rootName of ["apps", "packages"]) {
  visit(resolve(repositoryRoot, rootName));
}

for (const dependency of restrictedDependencies) {
  if (!observedOwners.has(dependency)) {
    violations.push(`packages/spark-ui does not exercise its ${dependency} ownership boundary`);
  }
}

if (violations.length > 0) {
  console.error("Spark UI import boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `Spark UI import boundary passed (${restrictedDependencies.length} presentation dependencies owned by packages/spark-ui).`,
  );
}

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolutePath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === "package.json") {
      inspectManifest(absolutePath);
      continue;
    }
    if (![...sourceExtensions].some((extension) => entry.name.endsWith(extension))) continue;
    inspectSource(absolutePath);
  }
}

function inspectSource(absolutePath) {
  const source = readFileSync(absolutePath, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const dependency = restrictedDependency(specifier);
    if (!dependency) continue;
    if (absolutePath.startsWith(allowedRoot)) {
      observedOwners.add(dependency);
      continue;
    }
    violations.push(`${displayPath(absolutePath)} imports ${specifier}`);
  }
}

function inspectManifest(absolutePath) {
  const manifest = JSON.parse(readFileSync(absolutePath, "utf8"));
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const dependency of restrictedDependencies) {
      if (!(dependency in dependencies)) continue;
      if (absolutePath.startsWith(allowedRoot)) {
        observedOwners.add(dependency);
        continue;
      }
      violations.push(`${displayPath(absolutePath)} declares ${dependency} in ${field}`);
    }
  }
}

function restrictedDependency(specifier) {
  if (typeof specifier !== "string") return undefined;
  return restrictedDependencies.find(
    (dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`),
  );
}

function displayPath(absolutePath) {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}
