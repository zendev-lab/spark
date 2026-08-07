#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(root, "apps/spark-docs/src/content/docs");
const failures = [];

const englishPages = await listMarkdownPages(docsRoot);
const chinesePages = await listMarkdownPages(join(docsRoot, "zh"));

for (const page of englishPages) {
  if (page.startsWith("0.2/")) continue;
  const chinesePath = join(docsRoot, "zh", page);
  if (!chinesePages.includes(page)) failures.push(`missing Chinese page for ${page}`);
  const source = await readFile(join(docsRoot, page), "utf8");
  if (!source.includes("description:")) failures.push(`${page} has no description frontmatter`);
  if (!source.includes("title:")) failures.push(`${page} has no title frontmatter`);
}

for (const page of chinesePages) {
  if (page.startsWith("0.2/")) continue;
  if (!englishPages.includes(page)) failures.push(`missing English page for zh/${page}`);
}

for (const page of ["index.md", "zh/index.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const term of ["Spark", "CLI", "TUI", "daemon", "Hub"]) {
    if (!source.includes(term)) failures.push(`${page} does not introduce ${term}`);
  }
}

for (const page of ["getting-started.md", "zh/getting-started.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of ["pnpm add -g", "spark", "spark tui", "spark run", "spark daemon"]) {
    if (!source.includes(command)) failures.push(`${page} does not document ${command}`);
  }
}

for (const page of ["reference/cli.md", "zh/reference/cli.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of [
    "spark run",
    "spark bg",
    "spark paths",
    "spark doctor",
    "spark install --managed",
    "spark update",
    "spark version",
    "spark daemon",
    "spark daemon auth status",
    "spark daemon auth login",
    "spark daemon auth logout",
    "spark daemon auth import pi",
    "spark daemon model list",
    "spark daemon model status",
    "spark daemon model set",
    "spark hub",
  ]) {
    if (!source.includes(command)) failures.push(`${page} does not document ${command}`);
  }
}

for (const page of ["guides/plan-and-execute.md", "zh/guides/plan-and-execute.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of ["/plan", "/execute"]) {
    if (!source.includes(command)) failures.push(`${page} does not teach ${command}`);
  }
}

for (const page of ["guides/automation.md", "zh/guides/automation.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of [
    "/automate",
    "/goal",
    "/loop",
    "/repro",
    "/workflow run",
    "/workflow pause",
  ]) {
    if (!source.includes(command)) failures.push(`${page} does not teach ${command}`);
  }
}

for (const page of ["guides/tui.md", "zh/guides/tui.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of ["/help", "/help commands", "/help all", "/inspect", "/automate"]) {
    if (!source.includes(command)) failures.push(`${page} does not teach ${command}`);
  }
}

const featureMapHeadings = {
  "concepts/feature-map.md": [
    "## 1.",
    "## 2.",
    "## 3.",
    "## 4.",
    "## 5.",
    "## 6.",
    "## 7.",
    "## 8.",
    "## 9.",
    "## 10.",
  ],
  "zh/concepts/feature-map.md": [
    "## 1.",
    "## 2.",
    "## 3.",
    "## 4.",
    "## 5.",
    "## 6.",
    "## 7.",
    "## 8.",
    "## 9.",
    "## 10.",
  ],
};
for (const [page, headings] of Object.entries(featureMapHeadings)) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const heading of headings) {
    if (!source.includes(heading)) failures.push(`${page} is missing ${heading}`);
  }
}

for (const page of ["guides/operator-handbook.md", "zh/guides/operator-handbook.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of [
    "spark paths",
    "spark doctor",
    "spark daemon start",
    "spark daemon model status",
    "spark daemon session",
    "spark hub",
  ]) {
    if (!source.includes(command)) failures.push(`${page} does not document ${command}`);
  }
}

for (const page of ["reference/configuration-and-paths.md", "zh/reference/configuration-and-paths.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const term of ["SPARK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    if (!source.includes(term)) failures.push(`${page} does not document ${term}`);
  }
}

const currentPages = [
  ...englishPages.filter((page) => !page.startsWith("0.2/")),
  ...chinesePages.filter((page) => !page.startsWith("0.2/")).map((page) => `zh/${page}`),
];
for (const page of currentPages) {
  const source = await readFile(join(docsRoot, page), "utf8");
  if (/spark cockpit\b/iu.test(source)) failures.push(`${page} still documents retired spark cockpit`);
  if (/\/cockpit\b/iu.test(source)) failures.push(`${page} still links retired /cockpit`);
}

if (failures.length > 0) {
  console.error("Spark user docs check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Spark user docs check passed: ${englishPages.length} English pages.`);
}

async function listMarkdownPages(directory, prefix = "") {
  const pages = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      pages.push(...(await listMarkdownPages(join(directory, entry.name), relative)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      pages.push(relative);
    }
  }
  return pages.sort();
}
