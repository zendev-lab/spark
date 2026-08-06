import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionRoleRunRequest, SparkHostAPI, ToolConfig } from "@zendev-lab/spark-core";
import { test } from "vitest";
import sparkRolesExtension from "./extension-entry.ts";
import { SKILL_AGENT_ALLOWED_TOOLS, createSparkSkillAgentTool } from "./skill-extension.ts";

async function writeSkill(
  root: string,
  name: string,
  body: string,
  extraFrontmatter = "",
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeFile(
    path,
    [
      "---",
      `name: ${name}`,
      `description: Execute the ${name} workflow`,
      `${extraFrontmatter}---`,
      "",
      body,
    ].join("\n"),
    "utf8",
  );
  return path;
}

function testTool(
  options: { builtinDirs: string[]; maxCombinedSkillChars?: number },
): ToolConfig {
  return createSparkSkillAgentTool({
    ...options,
    workspaceAgentsDirs: [],
    workspaceDir: join(options.builtinDirs[0]!, "missing-workspace"),
    userAgentsDir: join(options.builtinDirs[0]!, "missing-user"),
    skillDirs: [],
  });
}

test("skill_agent runs the complete Skill set in one restricted anonymous Agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skill-agent-"));
  try {
    const skillsDir = join(dir, "skills");
    const auditPath = await writeSkill(
      skillsDir,
      "release-audit",
      "# Release audit\n\nInspect the requested release and verify its checks.\n",
    );
    const publishPath = await writeSkill(
      skillsDir,
      "github-publish",
      "# GitHub publish\n\nPublish only after the requested verification passes.\n",
    );
    const tool = testTool({ builtinDirs: [skillsDir] });
    assert.deepEqual(tool.policy?.phases, ["implement"]);
    assert.equal(
      (tool.parameters as { additionalProperties?: unknown }).additionalProperties,
      false,
    );
    let captured: ExtensionRoleRunRequest | undefined;

    const result = await tool.execute(
      "skill-call-1",
      {
        skills: ["release-audit", "github-publish"],
        instruction: "Audit the current release candidate and publish only when it passes.",
        inputs: ["package.json", "CI must pass"],
        timeoutMs: 30_000,
      },
      new AbortController().signal,
      () => undefined,
      {
        cwd: dir,
        model: { provider: "fake-provider", id: "fake-model" },
        runRole: async (request) => {
          captured = request;
          return {
            record: {
              ...request.record,
              status: "succeeded",
              startedAt: "2026-08-04T00:00:00.000Z",
              finishedAt: "2026-08-04T00:00:01.000Z",
            },
            outcome: {
              kind: "completed",
              code: "completed",
              reason: "Skill Agent completed the request.",
            },
            stdout: "Release audit complete and publication ready.",
            stderr: "",
            jsonEvents: [],
          };
        },
      },
    );

    assert.ok(captured);
    assert.match(captured.role.ref, /^role:skill-agent-[0-9a-f]{12}$/u);
    assert.match(captured.role.id, /^skill-agent-[0-9a-f]{12}$/u);
    assert.equal(captured.record.launch, "fresh");
    assert.equal(captured.record.noSession, true);
    assert.equal(captured.record.sessionPersistence, "anonymous");
    assert.equal(captured.model, "fake-provider/fake-model");
    assert.equal(captured.timeoutMs, 30_000);
    assert.match(captured.role.systemPrompt, /dedicated Spark Agent/);
    assert.match(captured.role.systemPrompt, /release-audit, github-publish/);
    assert.match(captured.role.systemPrompt, /already included below/);
    assert.match(captured.role.systemPrompt, /# Release audit/);
    assert.match(captured.role.systemPrompt, /# GitHub publish/);
    assert.match(
      captured.role.systemPrompt,
      new RegExp(auditPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(
      captured.role.systemPrompt,
      new RegExp(publishPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(captured.instruction.instruction, /Bounded inputs:/);
    assert.match(captured.instruction.instruction, /package\.json/);
    assert.deepEqual(captured.role.allowedTools, [...SKILL_AGENT_ALLOWED_TOOLS]);
    const allowedTools = new Set<string>(captured.role.allowedTools);
    for (const forbidden of [
      "skill_agent",
      "role",
      "session",
      "task_read",
      "task_write",
      "assign",
      "ask",
      "workflow",
      "goal",
      "loop",
      "repro",
      "git",
      "artifact",
      "evidence",
      "memory",
    ]) {
      assert.equal(allowedTools.has(forbidden), false);
    }
    assert.equal(result.isError, undefined);
    assert.match(result.content[0]!.text, /Skill Agent completed: release-audit, github-publish/);
    assert.match(result.content[0]!.text, /publication ready/);
    assert.equal(result.details?.runName, "skills:release-audit,github-publish");
    assert.equal((result.details?.skills as unknown[]).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill_agent rejects invalid Skill sets before launching an Agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skill-agent-invalid-"));
  try {
    const skillsDir = join(dir, "skills");
    await writeSkill(skillsDir, "visible-skill", "# Visible\n");
    await writeSkill(
      skillsDir,
      "command-only",
      "# Command only\n",
      "disable-model-invocation: true\n",
    );
    const tool = testTool({ builtinDirs: [skillsDir] });
    let launches = 0;
    const ctx = {
      cwd: dir,
      model: { provider: "fake-provider", id: "fake-model" },
      runRole: async (_request: ExtensionRoleRunRequest) => {
        launches += 1;
        throw new Error("must not launch");
      },
    };

    await assert.rejects(
      tool.execute(
        "skill-call-hidden",
        { skills: ["command-only"], instruction: "Run it" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
      /Available Skills: visible-skill/,
    );
    await assert.rejects(
      tool.execute(
        "skill-call-invalid-name",
        { skills: ["Visible Skill"], instruction: "Run it" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
      /lowercase letters, digits, and hyphens/,
    );
    await assert.rejects(
      tool.execute(
        "skill-call-duplicate",
        { skills: ["visible-skill", "visible-skill"], instruction: "Run it" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
      /must not contain duplicate Skill names/,
    );
    await assert.rejects(
      tool.execute(
        "skill-call-empty",
        { skills: [], instruction: "Run it" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
      /array with 1-8 Skill names/,
    );
    await assert.rejects(
      tool.execute(
        "skill-call-long-instruction",
        { skills: ["visible-skill"], instruction: "x".repeat(12_001) },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
      /instruction must contain at most 12000 characters/,
    );
    await assert.rejects(
      tool.execute(
        "skill-call-long-input",
        { skills: ["visible-skill"], instruction: "Run it", inputs: ["x".repeat(2_049)] },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
      /inputs\[0\] must contain at most 2048 characters/,
    );
    assert.equal(launches, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill_agent enforces one aggregate Skill source budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skill-agent-budget-"));
  try {
    const skillsDir = join(dir, "skills");
    await writeSkill(skillsDir, "first-skill", `# First\n\n${"a".repeat(700)}\n`);
    await writeSkill(skillsDir, "second-skill", `# Second\n\n${"b".repeat(700)}\n`);
    const tool = testTool({ builtinDirs: [skillsDir], maxCombinedSkillChars: 1_000 });
    let launches = 0;

    await assert.rejects(
      tool.execute(
        "skill-call-budget",
        {
          skills: ["first-skill", "second-skill"],
          instruction: "Run both",
        },
        new AbortController().signal,
        () => undefined,
        {
          cwd: dir,
          model: { provider: "fake-provider", id: "fake-model" },
          runRole: async (_request: ExtensionRoleRunRequest) => {
            launches += 1;
            throw new Error("must not launch");
          },
        },
      ),
      /combined Skill source is .* above the 1000 character execution limit/,
    );
    assert.equal(launches, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark-roles extension publishes role and skill_agent together", () => {
  const names: string[] = [];
  const api: SparkHostAPI = {
    registerTool(config) {
      names.push(config.name);
    },
  };

  sparkRolesExtension(api);

  assert.equal(names.filter((name) => name === "role").length, 1);
  assert.equal(names.filter((name) => name === "skill_agent").length, 1);
  assert.equal(names.includes("skill_delegate"), false);
});
