import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DEFAULT_SPARK_IDENTITY_PROMPT,
  SPARK_ARTIFACT_EVIDENCE_BOUNDARY_PROMPT,
  SPARK_OPERATING_POLICY_PROMPT,
  SPARK_SKILL_AGENT_POLICY_PROMPT,
  renderPersistentSessionRolePrompt,
} from "./system-prompt.ts";

test("Spark standing prompt keeps runtime, intent, and authority boundaries explicit", () => {
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /Each invocation ends/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /durable background task/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /completed work, active durable work/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /User intent must be explicit/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /Do not guess the user's intended outcome/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /low risk, and easy reversibility/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /Automated review and model confidence/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /simplest implementation/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /remove obsolete internal paths/u);
  assert.match(
    DEFAULT_SPARK_IDENTITY_PROMPT,
    /User-facing Artifacts are issue, git_change, and document/u,
  );
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /agent-internal compact ledger/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /continuously update a document Artifact/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /one worktree and one native GitHub PR stack/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /skill_agent once/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /Omit optional tool fields/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /never invent empty artifactRef/u);
});

test("operating policy separates coordination from specialist execution", () => {
  assert.match(SPARK_OPERATING_POLICY_PROMPT, /substantial independently owned/u);
  assert.match(SPARK_OPERATING_POLICY_PROMPT, /persistent specialist session/u);
  assert.match(SPARK_OPERATING_POLICY_PROMPT, /dedicated Skill Agent/u);
  assert.match(SPARK_OPERATING_POLICY_PROMPT, /does not recursively delegate routine substeps/u);
});

test("Skill Agent policy loads the complete Skill set once", () => {
  assert.match(SPARK_SKILL_AGENT_POLICY_PROMPT, /complete matching Skill set/u);
  assert.match(SPARK_SKILL_AGENT_POLICY_PROMPT, /every complete Skill body exactly once/u);
  assert.match(SPARK_SKILL_AGENT_POLICY_PROMPT, /Do not read selected Skill files/u);
  assert.match(SPARK_SKILL_AGENT_POLICY_PROMPT, /Do not duplicate the assigned work/u);
});

test("PR delivery remains draft during work and becomes ready at completion", () => {
  assert.match(SPARK_ARTIFACT_EVIDENCE_BOUNDARY_PROMPT, /remain.*draft/u);
  assert.match(
    SPARK_ARTIFACT_EVIDENCE_BOUNDARY_PROMPT,
    /git\(\{ action: "submit", ready: true \}\)/u,
  );
  assert.match(SPARK_ARTIFACT_EVIDENCE_BOUNDARY_PROMPT, /Promotion from draft to ready/u);
  assert.match(SPARK_ARTIFACT_EVIDENCE_BOUNDARY_PROMPT, /authorizes the draft-to-ready lifecycle/u);
  assert.match(SPARK_ARTIFACT_EVIDENCE_BOUNDARY_PROMPT, /draft-only deliverable/u);
  assert.match(SPARK_ARTIFACT_EVIDENCE_BOUNDARY_PROMPT, /Do not post routine duplicate comments/u);
});

test("persistent specialist session directly completes its responsibility", () => {
  const prompt = renderPersistentSessionRolePrompt("质量验证");
  assert.match(prompt, /Persistent session role: 质量验证/u);
  assert.match(prompt, /stable division of labour/u);
  assert.match(prompt, /specialist session/u);
  assert.match(prompt, /directly complete ordinary work/u);
  assert.match(prompt, /Do not recursively delegate commands, files/u);
  assert.doesNotMatch(prompt, /administrator session/u);
});

test("administrator role prompt owns coordination without changing task identity", () => {
  const prompt = renderPersistentSessionRolePrompt("管理员");
  assert.match(prompt, /administrator session/u);
  assert.match(prompt, /clarify material intent/u);
  assert.match(prompt, /decompose independently owned responsibilities/u);
  assert.match(prompt, /Before creating a session, list same-workspace local sessions/u);
  assert.match(prompt, /reuse a semantically matching role/u);
  assert.match(prompt, /Create only when no existing division of labour owns/u);
  assert.match(prompt, /user's language and existing naming style/u);
  assert.match(prompt, /never use a task slug/u);
});