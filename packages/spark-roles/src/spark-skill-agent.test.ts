import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionRoleRunRequest, SparkHostAPI, ToolConfig } from "@zendev-lab/spark-core";
import { test } from "vitest";
import sparkRolesExtension from "./extension-entry.ts";
import { SKILL_AGENT_ALLOWED_TOOLS, createSparkSkillAgentTool } from "./skill-extension.ts";
import {
  RoleModelTypeUnconfiguredError,
  defaultProjectRoleModelSettingsStore,
} from "./role-runtime.ts";

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

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function testTool(options: { builtinDirs: string[]; maxCombinedSkillChars?: number }): ToolConfig {
  return createSparkSkillAgentTool({
    ...options,
    workspaceAgentsDirs: [],
    workspaceDir: join(options.builtinDirs[0]!, "missing-workspace"),
    userAgentsDir: join(options.builtinDirs[0]!, "missing-user"),
    skillDirs: [],
  });
}

test("skill_agent runs the complete Skill set in one restricted owned Session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skill-agent-"));
  try {
    const skillsDir = join(dir, "skills");
    const auditBody =
      "# Release audit\n\nInspect the requested release and verify RELEASE_AUDIT_SENTINEL.\n";
    const publishBody =
      "# GitHub publish\n\nPublish only after PUBLISH_READY_SENTINEL verification passes.\n";
    const auditPath = await writeSkill(skillsDir, "release-audit", auditBody);
    const publishPath = await writeSkill(skillsDir, "github-publish", publishBody);
    await defaultProjectRoleModelSettingsStore(dir).save(
      "implementation",
      "fake-provider/fake-model",
    );
    const tool = testTool({ builtinDirs: [skillsDir] });
    assert.deepEqual(tool.policy?.modes, ["execute"]);
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
    assert.equal(captured.role.source, "extension");
    assert.equal(captured.role.modelType, "implementation");
    assert.deepEqual(captured.role.capabilities, ["read", "write", "exec", "net"]);
    assert.match(captured.role.revision, /^sha256:[a-f0-9]{64}$/u);
    assert.equal("launch" in captured.record, false);
    assert.equal("sessionLifetime" in captured.record, false);
    assert.equal(captured.model, "fake-provider/fake-model");
    assert.equal(captured.timeoutMs, 30_000);
    assert.equal(countOccurrences(captured.role.systemPrompt, auditBody.trim()), 1);
    assert.equal(countOccurrences(captured.role.systemPrompt, publishBody.trim()), 1);
    assert.equal(countOccurrences(captured.role.systemPrompt, auditPath), 1);
    assert.equal(countOccurrences(captured.role.systemPrompt, publishPath), 1);
    assert.equal(countOccurrences(captured.role.systemPrompt, "<skill>"), 2);
    assert.equal(
      captured.instruction.instruction,
      [
        "Audit the current release candidate and publish only when it passes.",
        "",
        "Bounded inputs:",
        "- package.json",
        "- CI must pass",
      ].join("\n"),
    );
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
    assert.equal(result.details?.runName, "skills:release-audit,github-publish");
    assert.equal(result.details?.output, "Release audit complete and publication ready.");
    assert.deepEqual(
      (result.details?.skills as Array<{ name: string }>).map((skill) => skill.name),
      ["release-audit", "github-publish"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill_agent refuses parent-model fallback when implementation is unconfigured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skill-agent-model-type-"));
  try {
    const skillsDir = join(dir, "skills");
    await writeSkill(skillsDir, "visible-skill", "# Visible\n");
    const tool = testTool({ builtinDirs: [skillsDir] });
    await assert.rejects(
      tool.execute(
        "skill-call-model",
        { skills: ["visible-skill"], instruction: "Run it" },
        new AbortController().signal,
        () => undefined,
        {
          cwd: dir,
          model: { provider: "parent-provider", id: "parent-model" },
          runRole: async () => assert.fail("unconfigured Skill Agent must not launch"),
        },
      ),
      (error) =>
        error instanceof RoleModelTypeUnconfiguredError &&
        error.code === "role_model_type_unconfigured" &&
        error.modelType === "implementation",
    );
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
