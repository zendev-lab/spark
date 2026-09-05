#!/usr/bin/env node

import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const daemonRequire = createRequire(join(root, "apps", "spark-daemon", "package.json"));
const packageJsonPath = daemonRequire.resolve("@zendev-lab/cue/package.json");
const packageDir = dirname(packageJsonPath);
const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
const { cueSkillsRoot } = await import(
  pathToFileURL(daemonRequire.resolve("@zendev-lab/cue")).href
);
const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const catalogMatch = workspace.match(/^  "@zendev-lab\/cue": "(\d+\.\d+\.\d+)"$/m);
if (!catalogMatch) {
  throw new Error("pnpm catalog must pin @zendev-lab/cue to an exact version");
}
const expectedVersion = catalogMatch[1];

if (manifest.name !== "@zendev-lab/cue" || manifest.version !== expectedVersion) {
  throw new Error(
    `expected @zendev-lab/cue@${expectedVersion}, got ${manifest.name}@${manifest.version}`,
  );
}

const expectedRoot = resolve(packageDir, "skills");
if ((await realpath(cueSkillsRoot)) !== (await realpath(expectedRoot))) {
  throw new Error(`@zendev-lab/cue exported an unexpected Skill root: ${cueSkillsRoot}`);
}

const skillPath = join(cueSkillsRoot, "cue", "SKILL.md");
const skillStat = await lstat(skillPath);
if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
  throw new Error(`@zendev-lab/cue Skill is not a regular file: ${skillPath}`);
}
const skill = await readFile(skillPath, "utf8");
if (!/^---\n[\s\S]*?^name: cue\s*$[\s\S]*?^---$/m.test(skill)) {
  throw new Error("@zendev-lab/cue Skill does not declare name: cue");
}

console.log(`verified @zendev-lab/cue@${expectedVersion} Skill at ${skillPath}`);
