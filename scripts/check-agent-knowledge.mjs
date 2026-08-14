#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootAgentsPath = join(repositoryRoot, "AGENTS.md");
const agentsRoot = join(repositoryRoot, ".agents");
const notesRoot = join(repositoryRoot, ".agents", "notes");
const allowedNoteHomes = new Set(["contracts", "decisions", "runbooks"]);
const activeSourceExtensions = new Set([
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const skippedDirectoryNames = new Set([".git", ".spark", "coverage", "dist", "node_modules"]);
const archivedDocsRoots = [
  join(repositoryRoot, "apps", "spark-docs", "src", "content", "docs", "0.2"),
  join(repositoryRoot, "apps", "spark-docs", "src", "content", "docs", "zh", "0.2"),
];

async function main() {
  const failures = [];
  const files = await repositoryFiles(repositoryRoot);

  await checkAgentsBudgets(files, failures);
  await checkAgentsIndependence(files, failures);
  checkNoteHomes(files, failures);
  await checkRoutingDescriptions(files, failures);
  await checkMarkdownLinks(files, failures);
  await checkRetiredPaths(files, failures);

  if (failures.length > 0) {
    console.error(
      ["Agent knowledge check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const agentsCount = files.filter((file) => file.endsWith(`${sep}AGENTS.md`)).length;
  const noteCount = files.filter((file) => isWithin(file, notesRoot)).length;
  console.log(
    `Agent knowledge check passed (${agentsCount} AGENTS files, ${noteCount} Notes, routing descriptions and internal links valid).`,
  );
}

async function checkAgentsIndependence(files, failures) {
  const agentsFiles = files.filter(
    (file) => file.endsWith(`${sep}AGENTS.md`) && !isWithin(file, agentsRoot),
  );
  for (const file of agentsFiles) {
    const text = await readFile(file, "utf8");
    for (const destination of markdownDestinations(text)) {
      const path = localMarkdownPath(destination);
      if (!path) continue;
      const target = resolve(dirname(file), path);
      if (target === agentsRoot || isWithin(target, agentsRoot)) {
        failures.push(
          `${repositoryPath(file)} must not depend on agent asset ${destination}; standing orders are self-contained.`,
        );
      }
    }
  }
}

async function checkAgentsBudgets(files, failures) {
  const agentsFiles = files.filter((file) => file.endsWith(`${sep}AGENTS.md`));
  for (const file of agentsFiles) {
    const words = wordCount(await readFile(file, "utf8"));
    const limit = file === rootAgentsPath ? 1_600 : 600;
    if (words > limit) {
      failures.push(`${repositoryPath(file)} has ${words} words; limit is ${limit}.`);
    }
  }
}

function checkNoteHomes(files, failures) {
  for (const file of files.filter((candidate) => isWithin(candidate, notesRoot))) {
    const parts = relative(notesRoot, file).split(sep);
    if (parts.length < 2 || !allowedNoteHomes.has(parts[0])) {
      failures.push(
        `${repositoryPath(file)} must live under .agents/notes/contracts, decisions, or runbooks.`,
      );
    }
  }
}

async function checkRoutingDescriptions(files, failures) {
  const rolesRoot = join(repositoryRoot, ".agents", "roles");
  const skillsRoot = join(repositoryRoot, ".agents", "skills");
  const routedFiles = files.filter(
    (file) =>
      (isWithin(file, rolesRoot) && extname(file) === ".md") ||
      (isWithin(file, skillsRoot) && file.endsWith(`${sep}SKILL.md`)),
  );
  for (const file of routedFiles) {
    const description = frontmatterDescription(await readFile(file, "utf8"));
    if (!description?.startsWith("Use when ")) {
      failures.push(`${repositoryPath(file)} description must start with "Use when ...".`);
    }
  }
}

async function checkMarkdownLinks(files, failures) {
  const markdownFiles = files.filter(
    (file) => extname(file) === ".md" && !archivedDocsRoots.some((root) => isWithin(file, root)),
  );
  for (const file of markdownFiles) {
    const text = await readFile(file, "utf8");
    for (const destination of markdownDestinations(text)) {
      const path = localMarkdownPath(destination);
      if (!path) continue;
      const target = resolve(dirname(file), path);
      try {
        await stat(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        failures.push(`${repositoryPath(file)} links to missing ${destination}.`);
      }
    }
  }
}

async function checkRetiredPaths(files, failures) {
  const retiredRoots = [["docs", "specs"].join("/"), ["docs", "operations"].join("/")];
  for (const retired of retiredRoots) {
    try {
      await stat(join(repositoryRoot, ...retired.split("/")));
      failures.push(`${retired} must not exist after the Agent Notes cutover.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  for (const file of files) {
    if (!activeSourceExtensions.has(extname(file))) continue;
    if (archivedDocsRoots.some((root) => isWithin(file, root))) continue;
    const text = await readFile(file, "utf8");
    for (const retired of retiredRoots) {
      if (text.includes(retired)) {
        failures.push(`${repositoryPath(file)} still references retired path ${retired}.`);
      }
    }
  }
}

async function repositoryFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skippedDirectoryNames.has(entry.name)) continue;
        if (path === join(repositoryRoot, ".agents", "worktrees")) continue;
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files;
}

function frontmatterDescription(text) {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const lines = text.slice(4, end).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^description:\s*(.*)$/u.exec(lines[index]);
    if (!match) continue;
    const value = match[1].trim();
    if (value === ">" || value === "|") {
      const parts = [];
      while (index + 1 < lines.length && /^\s+/u.test(lines[index + 1])) {
        index += 1;
        parts.push(lines[index].trim());
      }
      return parts.join(" ").trim();
    }
    return unquote(value);
  }
  return undefined;
}

function markdownDestinations(text) {
  const destinations = [];
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) destinations.push(match[1]);
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gmu)) destinations.push(match[1]);
  return destinations;
}

function localMarkdownPath(destination) {
  let value = destination.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  else value = value.split(/\s+/u)[0];
  if (!value || value.startsWith("#") || value.startsWith("/")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return undefined;
  if (value.includes("${") || value.includes("{{")) return undefined;
  const path = value.split(/[?#]/u)[0];
  if (!path) return undefined;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function wordCount(text) {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isWithin(path, root) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot !== "" && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..";
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

await main();
