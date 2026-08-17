import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";

import { parseRoleSpecMarkdown } from "@zendev-lab/spark-roles";
import {
  resolveWorkflowDefinition,
  runWorkflowScript,
  type WorkflowAgentRuntimeOptions,
} from "@zendev-lab/spark-workflows";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const WORKFLOW_ROOT = join(REPO_ROOT, ".agents", "workflows");

async function workflowScript(id: string): Promise<string> {
  return (
    await resolveWorkflowDefinition({
      cwd: REPO_ROOT,
      selector: `workspace:${id}`,
      includeUser: false,
      workspaceWorkflowDir: WORKFLOW_ROOT,
    })
  ).script;
}

function acceptedImplementation(changedFiles: string[], validationCommand: string) {
  return {
    status: "completed",
    summary: "completed bounded change",
    changedFiles,
    validationEvidence: [{ command: validationCommand, status: "passed" }],
    acceptanceEvidence: [{ criterion: "preserve behavior", status: "satisfied" }],
  };
}

test("engineering roles preload the specialist skills used by the workflows", async () => {
  const roles = [
    {
      id: "spark-maintainability-reviewer",
      skills: ["spark-change-scope", "spark-code-review", "spark-find-simplifications"],
    },
    {
      id: "spark-feature-planner",
      skills: ["spark-change-scope", "spark-feature-planning"],
    },
  ];

  for (const expected of roles) {
    const role = parseRoleSpecMarkdown(
      await readFile(join(REPO_ROOT, ".agents", "roles", `${expected.id}.md`), "utf8"),
      { source: "project", id: expected.id },
    );
    assert.deepEqual(role.skills, expected.skills);
  }
});

test("maintainability-change bounds improvements and reruns independent reviews", async () => {
  const calls: Array<{ prompt: string; options: WorkflowAgentRuntimeOptions }> = [];
  const result = await runWorkflowScript(await workflowScript("maintainability-change"), {
    args: {
      instruction: "Remove duplicated validators without changing behavior",
      target: "pull request 42",
      maxChanges: 1,
      acceptanceCriteria: ["preserve behavior"],
      validationCommands: ["pnpm run check:agent-knowledge"],
    },
    agent: async (prompt, options) => {
      calls.push({ prompt, options });
      if (options.label === "maintainability scope") {
        return {
          verdict: "accepted",
          owner: "spark-protocol",
          invariants: ["one validator owner"],
          acceptanceCriteria: ["preserve behavior", "keep one validator owner"],
        };
      }
      if (options.label === "maintainability review") {
        return {
          verdict: "accepted",
          findings: [{ category: "complexity", evidence: "three validators" }],
          recommendedSlices: [
            { id: "deduplicate-validator", deletionTest: "protocol validator remains" },
            { id: "adjacent-cleanup", deletionTest: "not selected in this bounded pass" },
          ],
        };
      }
      if (options.label === "maintainability implementation") {
        assert.match(prompt, /deduplicate-validator/u);
        assert.doesNotMatch(prompt, /adjacent-cleanup/u);
        assert.match(prompt, /keep one validator owner/u);
        return {
          ...acceptedImplementation(
            [".agents/skills/spark-code-review/SKILL.md"],
            "pnpm run check:agent-knowledge",
          ),
          equivalenceEvidence: ["focused behavior test"],
        };
      }
      if (options.label === "maintainability architecture rereview") {
        return { verdict: "accepted", findings: [], boundaryEvidence: ["owner unchanged"] };
      }
      if (options.label === "maintainability complexity rereview") {
        return { verdict: "accepted", findings: [], verifiedBehaviors: ["same output"] };
      }
      if (options.label === "maintainability knowledge rereview") {
        return { verdict: "accepted", classification: "skill", findings: [] };
      }
      assert.equal(options.label, "maintainability verification");
      return {
        verdict: "accepted",
        scopeMatch: true,
        acceptanceCriteria: [
          { criterion: "preserve behavior", status: "satisfied" },
          { criterion: "keep one validator owner", status: "satisfied" },
        ],
        equivalence: "proved",
        prReadiness: "ready_for_parent",
      };
    },
  });

  assert.equal((result.result as { status: string }).status, "accepted");
  assert.deepEqual(
    result.stages?.map((stage) => `${stage.title}:${stage.status}`),
    ["scope:success", "review:success", "improve:success", "rereview:success", "verify:success"],
  );
  assert.deepEqual(
    calls.map((call) => [call.options.label, call.options.role, call.options.roleRef]),
    [
      ["maintainability scope", "spark-architecture-guardian", undefined],
      ["maintainability review", "spark-maintainability-reviewer", undefined],
      ["maintainability implementation", undefined, "role:builtin-executor"],
      ["maintainability architecture rereview", "spark-architecture-guardian", undefined],
      ["maintainability complexity rereview", "spark-maintainability-reviewer", undefined],
      ["maintainability knowledge rereview", "spark-agent-knowledge-curator", undefined],
      ["maintainability verification", "spark-delivery-verifier", undefined],
    ],
  );
});

test("maintainability-change completes a review-only pass without inventing edits", async () => {
  const calls: string[] = [];
  const result = await runWorkflowScript(await workflowScript("maintainability-change"), {
    args: { instruction: "Check whether this helper should exist" },
    agent: async (_prompt, options) => {
      calls.push(options.label ?? "unknown");
      if (options.label === "maintainability scope") {
        return { verdict: "accepted", owner: "spark-daemon", invariants: ["same output"] };
      }
      if (options.label === "maintainability review") {
        return { verdict: "accepted", findings: [], recommendedSlices: [] };
      }
      return {
        verdict: "accepted",
        scopeMatch: true,
        acceptanceCriteria: [],
        equivalence: "no change required",
      };
    },
  });

  assert.deepEqual(calls, [
    "maintainability scope",
    "maintainability review",
    "maintainability verification",
  ]);
  assert.deepEqual(
    result.stages?.map((stage) => `${stage.title}:${stage.status}`),
    ["scope:success", "review:success", "improve:skip", "rereview:skip", "verify:success"],
  );
});

test("feature-change keeps research, selection, planning, implementation, and review distinct", async () => {
  const calls: Array<{ prompt: string; options: WorkflowAgentRuntimeOptions }> = [];
  const result = await runWorkflowScript(await workflowScript("feature-change"), {
    args: {
      instruction: "Add a bounded feature",
      researchQuestions: ["Does the owner already expose a primitive?"],
      constraints: ["no second state owner"],
      acceptanceCriteria: ["preserve behavior"],
    },
    agent: async (prompt, options) => {
      calls.push({ prompt, options });
      if (options.label === "feature research") {
        return {
          verdict: "accepted",
          problemEvidence: ["existing owner API"],
          options: ["extend owner", "add adapter"],
          openQuestions: [],
        };
      }
      if (options.label === "feature selection") {
        assert.match(prompt, /existing owner API/u);
        return {
          verdict: "accepted",
          owner: "spark-daemon",
          selection: "extend owner",
          acceptanceCriteria: ["preserve behavior"],
        };
      }
      if (options.label === "feature plan") {
        assert.match(prompt, /extend owner/u);
        return {
          verdict: "accepted",
          plan: ["focused owner change", "failure test"],
          acceptanceCriteria: ["preserve behavior", "feature works"],
          validationCommands: ["pnpm test"],
        };
      }
      if (options.label === "feature implementation") {
        assert.match(prompt, /focused owner change/u);
        assert.match(prompt, /feature works/u);
        assert.match(prompt, /pnpm test/u);
        return acceptedImplementation(["apps/spark-daemon/src/owner.ts"], "pnpm test");
      }
      if (options.label === "feature architecture review") {
        return { verdict: "accepted", findings: [], boundaryEvidence: ["owner preserved"] };
      }
      if (options.label === "feature maintainability review") {
        return { verdict: "accepted", findings: [], verifiedBehaviors: ["bounded diff"] };
      }
      assert.equal(options.label, "feature verification");
      return {
        verdict: "accepted",
        scopeMatch: true,
        acceptanceCriteria: [
          { criterion: "preserve behavior", status: "satisfied" },
          { criterion: "feature works", status: "satisfied" },
        ],
        prReadiness: "ready_for_parent",
      };
    },
  });

  assert.equal((result.result as { status: string }).status, "accepted");
  assert.deepEqual(
    result.stages?.map((stage) => `${stage.title}:${stage.status}`),
    [
      "research:success",
      "select:success",
      "plan:success",
      "implement:success",
      "review:success",
      "verify:success",
    ],
  );
  assert.deepEqual(
    calls.map((call) => [call.options.label, call.options.role, call.options.roleRef]),
    [
      ["feature research", "spark-feature-planner", undefined],
      ["feature selection", "spark-architecture-guardian", undefined],
      ["feature plan", "spark-feature-planner", undefined],
      ["feature implementation", undefined, "role:builtin-executor"],
      ["feature architecture review", "spark-architecture-guardian", undefined],
      ["feature maintainability review", "spark-maintainability-reviewer", undefined],
      ["feature verification", "spark-delivery-verifier", undefined],
    ],
  );
});

test("feature-change stops before planning when architecture selection needs a decision", async () => {
  const calls: string[] = [];
  const result = await runWorkflowScript(await workflowScript("feature-change"), {
    args: { instruction: "Choose a user-visible default" },
    agent: async (_prompt, options) => {
      calls.push(options.label ?? "unknown");
      if (options.label === "feature research") {
        return { verdict: "accepted", options: ["default-a", "default-b"] };
      }
      return {
        verdict: "needs-decision",
        blockingReasons: ["user-visible default is unconfirmed"],
      };
    },
  });

  assert.deepEqual(calls, ["feature research", "feature selection"]);
  assert.deepEqual(
    result.stages?.map((stage) => `${stage.title}:${stage.status}`),
    [
      "research:success",
      "select:fail",
      "plan:skip",
      "implement:skip",
      "review:skip",
      "verify:skip",
    ],
  );
});
