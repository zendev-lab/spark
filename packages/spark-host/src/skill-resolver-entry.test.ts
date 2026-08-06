import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  SparkSkillResolver,
  formatSelectedSparkSkillsForPrompt,
  formatSparkSkillsForPrompt,
  type SparkSkill,
} from "./skill-resolver-entry.ts";

const visibleSkill: SparkSkill = {
  name: "release-audit",
  description: "Audit release readiness",
  filePath: "/skills/release-audit/SKILL.md",
  baseDir: "/skills/release-audit",
  layer: "builtin",
  disabled: false,
  disableModelInvocation: false,
  frontmatter: {},
};

test("public Skill catalog routes complete matching sets to one Skill Agent", () => {
  const prompt = formatSparkSkillsForPrompt([visibleSkill]);
  assert.match(prompt, /one or more Skills match/u);
  assert.match(prompt, /skill_agent is active/u);
  assert.match(prompt, /complete matching Skill set/u);
  assert.match(prompt, /loads every selected Skill body exactly once/u);
  assert.doesNotMatch(prompt, /skill_delegate/u);
});

test("selected Skill checkpoint does not instruct the parent to reload bodies", () => {
  const prompt = formatSelectedSparkSkillsForPrompt([
    { skill: visibleSkill, content: "# Release audit", promptBody: false, score: 10 },
  ]);
  assert.match(prompt, /Call skill_agent once/u);
  assert.match(prompt, /complete matching Skill set/u);
  assert.match(prompt, /Do not explicitly read selected Skills/u);
  assert.match(prompt, /do not duplicate assigned work/u);
  assert.doesNotMatch(prompt, /skill_delegate/u);
});

test("public SparkSkillResolver method uses canonical Skill Agent routing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skill-resolver-entry-"));
  try {
    const skillDir = join(dir, "skills", "release-audit");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: release-audit",
        "description: Audit release readiness",
        "---",
        "",
        "# Release audit",
      ].join("\n"),
      "utf8",
    );
    const resolver = new SparkSkillResolver({
      cwd: dir,
      builtinDirs: [join(dir, "skills")],
      workspaceAgentsDirs: [],
      workspaceDir: join(dir, "missing-workspace"),
      userDir: join(dir, "missing-user"),
      userAgentsDir: join(dir, "missing-user-agents"),
      skillDirs: [],
    });
    const prompt = await resolver.formatAvailableSkillsForPrompt();
    assert.match(prompt, /skill_agent/u);
    assert.doesNotMatch(prompt, /skill_delegate/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
