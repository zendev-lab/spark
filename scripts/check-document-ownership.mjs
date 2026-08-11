#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const areaRules = [
  {
    directory: "docs/specs",
    rules: [
      {
        pattern:
          /^## (?:Migration plan|Delivery stack|Implementation sequence|Delivery plan|Implementation plan)$/imu,
        reason: "specs own durable contracts, not delivery sequencing",
      },
      {
        pattern: /\b(?:GitHub )?PR (?:\*\*)?#\d+\b/u,
        reason: "numbered pull-request state belongs in the pull request",
      },
    ],
  },
  {
    directory: "docs/operations",
    rules: [
      {
        pattern: /^## (?:Delivery plan|Timing comparison)(?:\s|$)/imu,
        reason: "operations own procedures, not delivery plans or local result tables",
      },
      {
        pattern: /^###? .*smoke scores?(?:\s|$)/imu,
        reason: "measured scores belong in CI artifacts or local reports",
      },
    ],
  },
];

export async function findDocumentOwnershipFailures(root = defaultRoot) {
  const failures = [];

  for (const area of areaRules) {
    for (const path of await markdownFiles(resolve(root, area.directory))) {
      const source = await readFile(path, "utf8");
      for (const rule of area.rules) {
        const match = rule.pattern.exec(source);
        if (!match) continue;
        failures.push(formatFailure(root, path, source, match.index, rule.reason));
      }
    }
  }

  const sparkPath = resolve(root, "SPARK.md");
  if (await isFile(sparkPath)) {
    const source = await readFile(sparkPath, "utf8");
    const match = /^## 近期收尾任务(?:\s|$)/mu.exec(source);
    if (match) {
      failures.push(
        formatFailure(
          root,
          sparkPath,
          source,
          match.index,
          "SPARK.md owns current direction, not a completed-work or delivery backlog",
        ),
      );
    }
  }

  for (const path of await markdownFiles(resolve(root, "packages"))) {
    if (!/^(?:MERGE|SPLIT|EXTRACT)-EVAL\.md$/u.test(basename(path))) continue;
    failures.push(
      `${relativePath(root, path)}: package-local dated evaluations belong in the PR or CI artifact; fold durable rationale into the package README`,
    );
  }

  return failures.toSorted();
}

async function markdownFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && [".md", ".mdx"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function formatFailure(root, path, source, index, reason) {
  const line = source.slice(0, index).split("\n").length;
  return `${relativePath(root, path)}:${line}: ${reason}`;
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.env.SPARK_DOCUMENT_ROOT ?? defaultRoot);
  const failures = await findDocumentOwnershipFailures(root);
  if (failures.length > 0) {
    console.error(
      ["Document ownership check failed:", ...failures.map((item) => `- ${item}`)].join("\n"),
    );
    process.exit(1);
  }
  console.log("Document ownership check passed.");
}
