#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "vendor/cue/skills/cue.upstream.json");
const skillPath = resolve(root, "vendor/cue/skills/cue/SKILL.md");
const expectedKeys = ["path", "repository", "revision", "sha256"];

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const actualKeys = Object.keys(manifest).sort();
if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
  throw new Error(`invalid Cue Skill manifest keys: ${actualKeys.join(", ")}`);
}
if (manifest.repository !== "https://github.com/zendev-lab/cue") {
  throw new Error(`invalid Cue Skill repository: ${String(manifest.repository)}`);
}
if (!/^[0-9a-f]{40}$/u.test(manifest.revision)) {
  throw new Error(`invalid Cue Skill revision: ${String(manifest.revision)}`);
}
if (manifest.path !== "skills/cue/SKILL.md") {
  throw new Error(`invalid Cue Skill upstream path: ${String(manifest.path)}`);
}
if (!/^[0-9a-f]{64}$/u.test(manifest.sha256)) {
  throw new Error(`invalid Cue Skill SHA-256: ${String(manifest.sha256)}`);
}

const stats = await lstat(skillPath);
if (!stats.isFile() || stats.isSymbolicLink()) {
  throw new Error(`vendored Cue Skill is not a regular file: ${skillPath}`);
}
const content = await readFile(skillPath);
const digest = createHash("sha256").update(content).digest("hex");
if (digest !== manifest.sha256) {
  throw new Error(`vendored Cue Skill digest mismatch: expected ${manifest.sha256}, got ${digest}`);
}
if (!content.toString("utf8").startsWith("---\nname: cue\n")) {
  throw new Error("vendored Cue Skill does not declare name: cue");
}

const sourcePath = process.env.CUE_SKILL_SOURCE?.trim();
if (sourcePath) {
  const source = await readFile(resolve(sourcePath));
  if (!content.equals(source)) {
    throw new Error(`vendored Cue Skill differs from explicit source ${sourcePath}`);
  }
}

process.stdout.write(
  `Cue Skill snapshot verified (${manifest.repository}@${manifest.revision} ${manifest.path} sha256:${digest})\n`,
);
