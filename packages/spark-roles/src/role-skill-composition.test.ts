import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

import {
  createRoleSpec,
  parseRoleSpecMarkdown,
  resolveRoleComposition,
  runRole,
  serializeRoleSpecMarkdown,
} from "./role-runtime.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spark-role-skills-"));
  temporaryRoots.push(root);
  return root;
}

async function writeSkill(
  root: string,
  name: string,
  body: string,
  extraFrontmatter = "",
): Promise<void> {
  const directory = join(root, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use when testing ${name}.\n${extraFrontmatter}---\n\n${body}\n`,
    "utf8",
  );
}

test("Role Markdown preserves ordered Skills in its definition revision and serialization", () => {
  const base = createRoleSpec({
    id: "knowledge-reviewer",
    description: "Use when reviewing knowledge.",
    systemPrompt: "Review knowledge.",
    rationale: "test",
    expectedUses: ["test"],
    capabilities: ["read"],
    modelType: "verification",
  });
  const composed = createRoleSpec({
    id: "knowledge-reviewer",
    description: "Use when reviewing knowledge.",
    systemPrompt: "Review knowledge.",
    rationale: "test",
    expectedUses: ["test"],
    capabilities: ["read"],
    skills: ["spark-change-scope", "spark-code-review"],
    modelType: "verification",
  });
  assert.notEqual(composed.revision, base.revision);
  const parsed = parseRoleSpecMarkdown(serializeRoleSpecMarkdown(composed), {
    source: "project",
    id: composed.id,
  });
  assert.deepEqual(parsed.skills, ["spark-change-scope", "spark-code-review"]);
  assert.equal(parsed.revision, composed.revision);
  assert.throws(
    () =>
      parseRoleSpecMarkdown(
        `---\nid: invalid\ndescription: Use when invalid.\nskills: [same, same]\n---\n\nPrompt.\n`,
        { source: "project", id: "invalid" },
      ),
    /unique/u,
  );
});

test("Role composition preloads complete Skill bodies once in declaration order", async () => {
  const root = await temporaryRoot();
  await writeSkill(root, "first-skill", "# First\n\nFIRST_BODY_TOKEN");
  await writeSkill(root, "second-skill", "# Second\n\nSECOND_BODY_TOKEN");

  const composition = await resolveRoleComposition(
    {
      definitionRevision: `sha256:${"a".repeat(64)}`,
      systemPrompt: "ROLE_BODY_TOKEN",
      skills: ["second-skill", "first-skill"],
    },
    { cwd: root },
  );
  assert.ok(composition);
  assert.deepEqual(
    composition.skillDigests.map(({ name }) => name),
    ["second-skill", "first-skill"],
  );
  assert.ok(
    composition.systemPrompt.indexOf("SECOND_BODY_TOKEN") <
      composition.systemPrompt.indexOf("FIRST_BODY_TOKEN"),
  );
  assert.equal(composition.systemPrompt.split("SECOND_BODY_TOKEN").length - 1, 1);
  assert.equal(composition.systemPrompt.split("FIRST_BODY_TOKEN").length - 1, 1);
  assert.match(composition.systemPrompt, /resource-base/u);
  assert.notEqual(composition.compositionRevision, composition.definitionRevision);
});

test("Role composition rejects unavailable, non-model-invocable, and oversized Skills", async () => {
  const root = await temporaryRoot();
  await writeSkill(root, "hidden-skill", "Hidden.", "disable-model-invocation: true\n");
  await writeSkill(root, "large-skill", "1234567890");
  const revision = `sha256:${"b".repeat(64)}`;

  await assert.rejects(
    resolveRoleComposition(
      { definitionRevision: revision, systemPrompt: "Role.", skills: ["missing-skill"] },
      { cwd: root },
    ),
    /cannot load model-invocable Skills: missing-skill/u,
  );
  await assert.rejects(
    resolveRoleComposition(
      { definitionRevision: revision, systemPrompt: "Role.", skills: ["hidden-skill"] },
      { cwd: root },
    ),
    /cannot load model-invocable Skills: hidden-skill/u,
  );
  await assert.rejects(
    resolveRoleComposition(
      { definitionRevision: revision, systemPrompt: "Role.", skills: ["large-skill"] },
      { cwd: root, maxCombinedSkillChars: 1 },
    ),
    /above the 1 character limit/u,
  );
});

test("Role Skill failures occur before the native executor can create a Session", async () => {
  const root = await temporaryRoot();
  const nativeExecutor = vi.fn();
  await assert.rejects(
    runRole({
      runRef: "run:test-preload-failure",
      roleRef: "role:project-test",
      roleRevision: `sha256:${"c".repeat(64)}`,
      roleSkills: ["missing-skill"],
      systemPrompt: "Role.",
      instruction: "Execute.",
      cwd: root,
      nativeExecutor,
    }),
    /cannot load model-invocable Skills/u,
  );
  assert.equal(nativeExecutor.mock.calls.length, 0);
});
