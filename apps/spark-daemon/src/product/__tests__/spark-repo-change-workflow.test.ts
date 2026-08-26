import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";

import {
  resolveWorkflowDefinition,
  runWorkflowScript,
  type WorkflowAgentRuntimeOptions,
} from "@zendev-lab/spark-workflows";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOW_ROOT = join(REPO_ROOT, ".agents", "workflows");

async function repoChangeScript(): Promise<string> {
  return (
    await resolveWorkflowDefinition({
      cwd: REPO_ROOT,
      selector: "workspace:repo-change",
      includeUser: false,
      workspaceWorkflowDir: WORKFLOW_ROOT,
    })
  ).script;
}

test("repo-change workflow runs ordered handoffs and conditionally reviews agent knowledge", async () => {
  const calls: Array<{ prompt: string; options: WorkflowAgentRuntimeOptions }> = [];
  const script = await repoChangeScript();
  const result = await runWorkflowScript(script, {
    args: {
      instruction: "Update .agents knowledge without duplicating contracts",
      acceptanceCriteria: ["one home per fact"],
      validationCommands: ["pnpm run check:agent-knowledge"],
    },
    agent: async (prompt, options) => {
      calls.push({ prompt, options });
      if (options.label === "architecture scope") {
        return {
          verdict: "accepted",
          owner: "spark-workflows",
          boundaries: ["workflow runtime"],
          risks: ["knowledge duplication"],
          acceptanceCriteria: ["one home per fact"],
          blockingReasons: [],
        };
      }
      if (options.label === "repository implementation") {
        assert.match(prompt, /"owner":"spark-workflows"/u);
        return {
          status: "completed",
          summary: "updated agent workflow",
          changedFiles: [".agents/workflows/repo-change/WORKFLOW.md"],
          validationEvidence: [{ command: "pnpm run check:agent-knowledge", status: "passed" }],
          acceptanceEvidence: [{ criterion: "one home per fact", status: "satisfied" }],
          blockers: [],
        };
      }
      if (options.label === "architecture review") {
        assert.match(prompt, /updated agent workflow/u);
        return { verdict: "accepted", findings: [], boundaryEvidence: ["owner preserved"] };
      }
      if (options.label === "agent knowledge review") {
        return {
          verdict: "accepted",
          classification: "workflow",
          findings: [],
          validation: ["one-home-per-fact"],
        };
      }
      assert.equal(options.label, "delivery verification");
      assert.match(prompt, /Architecture review/u);
      assert.match(prompt, /Agent knowledge review/u);
      return {
        verdict: "accepted",
        scopeMatch: true,
        diffFindings: [],
        validationEvidence: [{ command: "pnpm run check:agent-knowledge", status: "passed" }],
        acceptanceCriteria: [{ criterion: "one home per fact", status: "satisfied" }],
        prReadiness: "ready_for_parent",
        blockingReasons: [],
      };
    },
  });

  assert.equal((result.result as { status: string }).status, "accepted");
  assert.deepEqual(
    result.stages?.map((stage) => `${stage.title}:${stage.status}`),
    ["scope:success", "implement:success", "review:success", "verify:success"],
  );
  assert.deepEqual(
    calls.map((call) => [call.options.label, call.options.role, call.options.roleRef]),
    [
      ["architecture scope", "spark-architecture-guardian", undefined],
      ["repository implementation", undefined, "role:builtin-executor"],
      ["architecture review", "spark-architecture-guardian", undefined],
      ["agent knowledge review", "spark-agent-knowledge-curator", undefined],
      ["delivery verification", "spark-delivery-verifier", undefined],
    ],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify((result.result as { publication: unknown }).publication)),
    {
      performed: false,
    },
  );
});

test("repo-change workflow stops after a guardian rejection", async () => {
  const calls: string[] = [];
  const result = await runWorkflowScript(await repoChangeScript(), {
    args: { instruction: "Add a second state owner" },
    agent: async (_prompt, options) => {
      calls.push(options.label ?? "unknown");
      return {
        verdict: "rejected",
        owner: "spark-daemon",
        blockingReasons: ["second authoritative state owner"],
      };
    },
  });

  assert.deepEqual(calls, ["architecture scope"]);
  assert.deepEqual(
    result.stages?.map((stage) => `${stage.title}:${stage.status}`),
    ["scope:fail", "implement:skip", "review:skip", "verify:skip"],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    status: "rejected",
    rejectedAt: "scope",
    reason: "architecture scope guardian rejected the change",
    evidence: {
      scope: {
        verdict: "rejected",
        owner: "spark-daemon",
        blockingReasons: ["second authoritative state owner"],
      },
    },
    publication: { performed: false },
  });
});

test("repo-change workflow rejects accepted narration when command evidence is missing", async () => {
  const calls: Array<{ label?: string; prompt: string }> = [];
  const result = await runWorkflowScript(await repoChangeScript(), {
    args: {
      instruction: "Change a runtime helper",
      validationCommands: ["pnpm --filter owner test"],
    },
    agent: async (prompt, options) => {
      calls.push({ label: options.label, prompt });
      if (options.label === "architecture scope") {
        return { verdict: "accepted", owner: "spark-runtime", blockingReasons: [] };
      }
      if (options.label === "repository implementation") {
        return {
          status: "completed",
          summary: "changed helper",
          changedFiles: ["packages/spark-task-runtime/src/index.ts"],
          validationEvidence: [],
        };
      }
      if (options.label === "architecture review") {
        return { verdict: "accepted", findings: [] };
      }
      return {
        verdict: "accepted",
        validationEvidence: [],
        acceptanceCriteria: [],
        prReadiness: "ready_for_parent",
      };
    },
  });

  assert.equal(
    calls.some((call) => call.label === "agent knowledge review"),
    false,
  );
  assert.match(calls.at(-1)?.prompt ?? "", /pnpm --filter owner test/u);
  assert.deepEqual(
    result.stages?.map((stage) => `${stage.title}:${stage.status}`),
    ["scope:success", "implement:success", "review:success", "verify:fail"],
  );
  const delivery = result.result as {
    status: string;
    rejectedAt: string;
    evidence: { missingValidationCommands: string[] };
  };
  assert.equal(delivery.status, "rejected");
  assert.equal(delivery.rejectedAt, "verify");
  assert.deepEqual(delivery.evidence.missingValidationCommands, ["pnpm --filter owner test"]);
});
