import assert from "node:assert/strict";
import { test } from "vitest";

import { evaluateSparkBehavior } from "./behavior-eval.ts";
import { buildSparkPromptManifest } from "./prompt-manifest.ts";

function manifest() {
  return buildSparkPromptManifest({
    promptVersion: "test-v1",
    sessionId: "session-with-private-identity",
    model: { provider: "test", id: "model", api: "responses" },
    reasoning: "medium",
    stablePrompt: "stable secret prompt",
    dynamicPrompt: "dynamic user data",
    promptCacheKey: "cache-key-containing-session-data",
    tools: [
      { name: "read", effect: "read", executionMode: "parallel" },
      {
        name: "write",
        effect: "local_write",
        executionMode: "sequential",
        approval: "manual_only",
      },
      { name: "hidden", active: false, effect: "destructive" },
    ],
    selectedSkills: ["coding", "coding", "testing"],
    roundtripIndex: 1,
    maxParallelToolCalls: 4,
  });
}

test("prompt manifest exposes diagnostics without retaining sensitive prompt/session data", () => {
  const result = manifest();
  const serialized = JSON.stringify(result);

  assert.equal(result.schemaVersion, 6);
  assert.equal(result.prompt.stableChars, "stable secret prompt".length);
  assert.equal(result.prompt.dynamicChars, "dynamic user data".length);
  assert.equal(result.sessionFingerprint.length, 16);
  assert.equal(result.cache.keyFingerprint?.length, 16);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["read", "write"],
  );
  assert.equal(result.tools[1]?.approval, "manual_only");
  assert.deepEqual(result.selectedSkills, ["coding", "testing"]);
  assert.deepEqual(result.roundtrip, { index: 1 });
  assert.doesNotMatch(serialized, /private-identity|secret prompt|user data|cache-key-containing/u);
});

test("prompt manifest includes guidance identity in the tool fingerprint", () => {
  const withoutGuidance = buildSparkPromptManifest({
    sessionId: "session",
    model: { provider: "test", id: "model" },
    stablePrompt: "stable",
    dynamicPrompt: "dynamic",
    tools: [{ name: "read", effect: "read", executionMode: "parallel" }],
    roundtripIndex: 0,
    maxParallelToolCalls: 1,
  });
  const withGuidance = buildSparkPromptManifest({
    sessionId: "session",
    model: { provider: "test", id: "model" },
    stablePrompt: "stable",
    dynamicPrompt: "dynamic",
    tools: [
      {
        name: "read",
        effect: "read",
        executionMode: "parallel",
        promptGuidelines: ["Read before editing."],
      },
    ],
    roundtripIndex: 0,
    maxParallelToolCalls: 1,
  });

  assert.equal(withoutGuidance.tools[0]?.guidanceHash, undefined);
  assert.equal(withGuidance.tools[0]?.guidanceHash?.length, 16);
  assert.notEqual(withoutGuidance.toolProfileFingerprint, withGuidance.toolProfileFingerprint);
});

test("behavior eval reports tool precision, coverage, effects, outcome, and roundtrips", () => {
  const passing = evaluateSparkBehavior(
    {
      id: "implement-and-test",
      allowedTools: ["read", "write", "test"],
      requiredTools: ["write", "test"],
      forbiddenTools: ["publish"],
      allowedEffects: ["read", "local_write"],
      expectedOutcomes: ["completed"],
      maxToolCalls: 4,
      requireEvidence: true,
    },
    {
      manifest: manifest(),
      toolCalls: [
        { name: "read", effect: "read" },
        { name: "write", effect: "local_write" },
        { name: "test", effect: "read" },
      ],
      outcome: "completed",
      roundtrips: 3,
      evidenceRefs: ["test:focused"],
    },
  );

  assert.equal(passing.passed, true);
  assert.equal(passing.metrics.toolSelectionPrecision, 1);
  assert.equal(passing.metrics.requiredToolCoverage, 1);
  assert.equal(passing.metrics.roundtrips, 3);

  const failing = evaluateSparkBehavior(
    {
      id: "plan-no-write",
      allowedTools: ["read"],
      forbiddenTools: ["write", "publish"],
      allowedEffects: ["read"],
      expectedOutcomes: ["completed"],
      maxToolCalls: 1,
    },
    {
      manifest: manifest(),
      toolCalls: [
        { name: "read", effect: "read" },
        { name: "write", effect: "local_write" },
      ],
      outcome: "failed",
      roundtrips: 3,
    },
  );

  assert.equal(failing.passed, false);
  assert.equal(failing.metrics.toolSelectionPrecision, 0.5);
  assert.deepEqual(
    failing.checks.filter((entry) => !entry.passed).map((entry) => entry.id),
    ["allowed_tools", "forbidden_tools", "allowed_effects", "outcome", "tool_budget"],
  );
});

test("behavior eval checks selected skill allowlists, requirements, exclusions, and budget", () => {
  const result = evaluateSparkBehavior(
    {
      id: "skill-routing",
      allowedSkills: ["testing"],
      requiredSkills: ["testing", "release"],
      forbiddenSkills: ["coding"],
      maxSelectedSkills: 1,
    },
    {
      manifest: manifest(),
      toolCalls: [],
      outcome: "completed",
      roundtrips: 1,
    },
  );

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.checks.filter((entry) => !entry.passed).map((entry) => entry.id),
    ["allowed_skills", "required_skills", "forbidden_skills", "skill_budget"],
  );
  assert.equal(result.metrics.selectedSkills, 2);
  assert.equal(result.metrics.skillSelectionPrecision, 0.5);
  assert.equal(result.metrics.requiredSkillCoverage, 0.5);
});
