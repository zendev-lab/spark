import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionRoleRunRequest, SparkHostAPI, ToolConfig } from "@zendev-lab/spark-core";
import { test } from "vitest";
import sparkRolesExtension from "./extension-entry.ts";
import {
  SKILL_DELEGATE_ALLOWED_TOOLS,
  createSparkSkillDelegateTool,
} from "./skill-extension.ts";

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

function testTool(options: { builtinDirs: string[] }): ToolConfig {
  return createSparkSkillDelegateTool({
    ...options,
    workspaceAgentsDirs: [],
    workspaceDir: join(options.builtinDirs[0]!, "missing-workspace"),
    userAgentsDir: join(options.builtinDirs[0]!, "missing-user"),
    skillDirs: [],
  });
}

test("skill_delegate runs one exact Skill in a restricted anonymous Worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skill-delegate-"));
  try {
    const skillsDir = join(dir, "skills");
    const skillPath = await writeSkill(
      skillsDir,
      "release-audit",
      "# Release audit\n\nInspect the requested release and verify its checks.\n",
    );
    const tool = testTool({ builtinDirs: [skillsDir] });
    assert.deepEqual(tool.policy?.phases, ["implement"]);
    assert.equal((tool.parameters as { additionalProperties?: unknown }).additionalProperties, false);
    let captured: ExtensionRoleRunRequest | undefined;

    const result = await tool.execute(
      "skill-call-1",
      {
        skill: "release-audit",
        instruction: "Audit the current release candidate and report blockers.",
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
              reason: "Skill Worker completed the request.",
            },
            stdout: "Release audit complete: all checks passed.",
            stderr: "",
            jsonEvents: [],
          };
        },
      },
    );

    assert.ok(captured);
    assert.equal(captured.role.ref, "role:skill-release-audit");
    assert.equal(captured.role.id, "skill-release-audit");
    assert.equal(captured.record.launch, "fresh");
    assert.equal(captured.record.noSession, true);
    assert.equal(captured.record.sessionPersistence, "anonymous");
    assert.equal(captured.model, "fake-provider/fake-model");
    assert.equal(captured.timeoutMs, 30_000);
    assert.match(captured.role.systemPrompt, /temporary Spark Worker/);
    assert.match(captured.role.systemPrompt, /# Release audit/);
    assert.match(
      captured.role.systemPrompt,
      new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(captured.instruction.instruction, /Bounded inputs:/);
    assert.match(captured.instruction.instruction, /package\.json/);
    assert.deepEqual(captured.role.allowedTools, [...SKILL_DELEGATE_ALLOWED_TOOLS]);
    for (const forbidden of [
      "skill_delegate",
      "role",
      "session",
      "task_read",
      "task_write",
      "assign",
      "ask",
      "git",
      "artifact",
      "evidence",
    ]) {
      assert.equal(captured.role.allowedTools?.includes(forbidden), false);
    }
    assert.equal(result.isError, undefined);
    assert.match(result.content[0]!.text, /Skill Worker completed: release-audit/);
    assert.match(result.content[0]!.text, /all checks passed/);
    assert.equal(result.details?.runName, "skill:release-audit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill_delegate rejects hidden or unknown Skills before launching a Worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skill-delegate-hidden-"));
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
        { skill: "command-only", instruction: "Run it" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
      /Available Skills: visible-skill/,
    );
    assert.equal(launches, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark-roles extension publishes role and skill_delegate together", () => {
  const names: string[] = [];
  const api: SparkHostAPI = {
    registerTool(config) {
      names.push(config.name);
    },
  };

  sparkRolesExtension(api);

  assert.equal(names.filter((name) => name === "role").length, 1);
  assert.equal(names.filter((name) => name === "skill_delegate").length, 1);
});
