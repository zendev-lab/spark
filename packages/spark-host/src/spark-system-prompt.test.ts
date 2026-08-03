import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DEFAULT_SPARK_IDENTITY_PROMPT,
  renderPersistentSessionRolePrompt,
} from "./system-prompt.ts";

test("Spark identity prompt does not imply work continues after a final response", () => {
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /Each invocation ends/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /durable background task/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /completed work, active durable work/u);
  assert.match(
    DEFAULT_SPARK_IDENTITY_PROMPT,
    /User-facing Artifacts are issue, git_change, and document/u,
  );
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /agent-internal compact ledger/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /Continuously update/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /one owning worktree/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /submit drafts by default/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /do not post routine duplicate PR comments/u);
});

test("persistent session role prompt keeps work grouped by division of labour", () => {
  const prompt = renderPersistentSessionRolePrompt("质量验证");
  assert.match(prompt, /Persistent session role: 质量验证/u);
  assert.match(prompt, /stable division of labour/u);
  assert.doesNotMatch(prompt, /administrator session/u);
});

test("administrator role prompt owns coordination without changing task identity", () => {
  const prompt = renderPersistentSessionRolePrompt("管理员");
  assert.match(prompt, /administrator session/u);
  assert.match(prompt, /Before creating a session, list same-workspace local sessions/u);
  assert.match(prompt, /reuse a semantically matching role/u);
  assert.match(prompt, /Create only when no existing division of labour owns/u);
  assert.match(prompt, /user's language and existing naming style/u);
  assert.match(prompt, /never use a task slug/u);
});
