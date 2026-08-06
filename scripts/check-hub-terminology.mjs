#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(
  process.env.SPARK_HUB_TERMINOLOGY_ROOT ?? new URL("..", import.meta.url).pathname,
);
const allowlistPath = resolve(
  process.env.SPARK_HUB_TERMINOLOGY_ALLOWLIST ??
    join(root, "test/fixtures/hub-compatibility-allowlist.json"),
);
const allowlist = JSON.parse(await readFile(allowlistPath, "utf8"));
const ignoredDirectoryNames = new Set([
  ".git",
  ".spark",
  ".svelte-kit",
  ".stryker-tmp",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".mts",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const textFileNames = new Set(["AGENTS.md", "Dockerfile", "README.md"]);
if (allowlist.schemaVersion !== 1 || !Array.isArray(allowlist.rules)) {
  throw new Error("Hub compatibility allowlist must use schemaVersion 1 with a rules array.");
}

const rules = allowlist.rules.map((rule) => {
  if (typeof rule?.pattern !== "string" || typeof rule?.category !== "string") {
    throw new Error(
      "Every Hub compatibility allowlist rule needs string pattern and category fields.",
    );
  }
  return { ...rule, regex: globToRegExp(rule.pattern), matches: 0 };
});
const occurrences = [];
const violations = [];

for (const relativePath of await listRepositoryFiles(root)) {
  const content = await readFile(join(root, relativePath), "utf8");
  const lines = content.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (!/cockpit/iu.test(line)) return;
    const matchingRules = rules.filter((rule) => rule.regex.test(relativePath));
    if (matchingRules.length !== 1) {
      violations.push(
        `${relativePath}:${index + 1}: expected exactly one compatibility classification, found ${matchingRules.length}`,
      );
      return;
    }
    const [rule] = matchingRules;
    rule.matches += 1;
    occurrences.push({
      path: relativePath,
      line: index + 1,
      category: rule.category,
      source: line.trim().replace(/\s+/gu, " "),
    });
  });
}

for (const rule of rules) {
  if (rule.matches === 0) violations.push(`${rule.pattern}: stale compatibility allowlist rule`);
}

if (violations.length > 0) {
  console.error("Hub terminology compatibility violation");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Hub terminology compatibility report");
console.log(`allowlist=${relative(root, allowlistPath) || allowlistPath}`);
for (const occurrence of occurrences) {
  console.log(
    `- ${occurrence.path}:${occurrence.line} [${occurrence.category}] ${occurrence.source}`,
  );
}
console.log(`classified=${occurrences.length} violations=0`);

async function listRepositoryFiles(directory, prefix = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name) || relativePath === "apps/spark-docs/dist")
        continue;
      files.push(...(await listRepositoryFiles(join(directory, entry.name), relativePath)));
      continue;
    }
    if (entry.isFile() && isTextSource(relativePath)) files.push(relativePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function isTextSource(path) {
  const extension = extname(path);
  return (
    textExtensions.has(extension) ||
    textFileNames.has(path.split("/").at(-1)) ||
    path.endsWith(".md.golden")
  );
}

function globToRegExp(pattern) {
  const doubleStar = "__DOUBLE_STAR__";
  const escaped = pattern
    .replace(/\*\*/gu, doubleStar)
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, "[^/]*")
    .replaceAll(doubleStar, ".*");
  return new RegExp(`^${escaped}$`, "u");
}
