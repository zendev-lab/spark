import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createSparkReproRoleSpecs,
  registerSparkReproRoles,
  SPARK_REPRO_ROLE_IDS,
} from "../extension/spark-repro-roles.ts";
import { createDefaultRoleRegistry, hydrateExtensionRoles } from "@zendev-lab/spark-roles";
import {
  listSavedWorkflows,
  parseWorkflowScript,
  readSavedWorkflow,
  reproBuiltinWorkflowSpecs,
  reproChangeLoopWorkflowScript,
  reproDeliverySyncWorkflowScript,
  reproModuleSweepWorkflowScript,
  runWorkflowScript,
} from "@zendev-lab/spark-workflows";

test("Repro extension roles are bounded specialists without ask or spawn authority", () => {
  const roles = createSparkReproRoleSpecs("2026-07-29T00:00:00.000Z");
  assert.deepEqual(
    roles.map((role) => role.id),
    SPARK_REPRO_ROLE_IDS,
  );
  const forbidden = new Set(["ask", "ask_user", "ask_flow", "role", "assign", "task_write"]);
  for (const role of roles) {
    assert.equal(role.source, "extension");
    assert.equal(role.ref, `role:extension-${role.id}`);
    assert.equal(
      role.allowedTools?.some((tool) => forbidden.has(tool)),
      false,
    );
  }
  assert.equal(
    roles.find((role) => role.id === "repro-precision-fixer")?.allowedTools?.includes("edit"),
    true,
  );
  for (const role of roles.filter((candidate) => candidate.id !== "repro-precision-fixer")) {
    assert.equal(role.allowedTools?.includes("edit"), false);
    assert.equal(role.allowedTools?.includes("write"), false);
  }
  registerSparkReproRoles();
  const registry = createDefaultRoleRegistry();
  hydrateExtensionRoles(registry);
  for (const role of roles) assert.equal(registry.get(role.ref).id, role.id);
});

test("all Repro workflows are discoverable, metadata-first, and stage-bounded", async () => {
  const listing = await listSavedWorkflows(".", {
    includeUser: false,
    workspaceWorkflowDir: "/missing-workspace-workflows",
  });
  const discovered = new Set(listing.workflows.map((workflow) => workflow.id));
  for (const spec of reproBuiltinWorkflowSpecs) {
    assert.equal(discovered.has(spec.id), true, `missing ${spec.id}`);
    const loaded = await readSavedWorkflow({
      cwd: ".",
      selector: `builtin:${spec.id}`,
      includeUser: false,
    });
    const parsed = parseWorkflowScript(loaded.script);
    assert.equal(parsed.meta.name, spec.title);
    assert.deepEqual(
      parsed.meta.stages?.map((stage) => stage.title),
      spec.stages,
    );
    assert.match(loaded.script, /role:extension-repro-/u);
  }
});

test("module sweep fans out bounded cells and joins through the numerical auditor", async () => {
  const calls: Array<{ label?: string; roleRef?: string }> = [];
  const run = await runWorkflowScript(reproModuleSweepWorkflowScript(), {
    args: {
      projectRef: "proj:repro",
      taskRef: "task:sweep",
      experiments: [{ id: "attention-backward" }, { id: "rope-layout" }],
      concurrency: 2,
    },
    agent: async (_prompt, options) => {
      calls.push({ label: options.label, roleRef: options.roleRef });
      return { status: "pass", evidenceRefs: [`evidence:${options.label}`] };
    },
  });
  assert.equal(run.agentCount, 3);
  assert.deepEqual(calls, [
    {
      label: "attention-backward",
      roleRef: "role:extension-repro-distributed-runner",
    },
    { label: "rope-layout", roleRef: "role:extension-repro-distributed-runner" },
    { label: "evidence join", roleRef: "role:extension-repro-numerical-auditor" },
  ]);
});

test("change loop keeps fix, formal regression, and independent review sequential", async () => {
  const roles: string[] = [];
  const run = await runWorkflowScript(reproChangeLoopWorkflowScript(), {
    args: { changes: [{ id: "confirmed-reduction-order" }] },
    agent: async (_prompt, options) => {
      roles.push(options.roleRef ?? "");
      return { status: "pass" };
    },
  });
  assert.deepEqual(roles, [
    "role:extension-repro-precision-fixer",
    "role:extension-repro-distributed-runner",
    "role:extension-repro-numerical-auditor",
  ]);
  assert.deepEqual(
    run.stages?.map((stage) => stage.title),
    ["Validate", "Fix", "Build and regress", "Review"],
  );
});

test("delivery sync records deterministic managed sections without forge mutation", async () => {
  const records: Array<{ title: string; taskRef?: string; projectRef?: string }> = [];
  const run = await runWorkflowScript(reproDeliverySyncWorkflowScript(), {
    args: {
      projectRef: "proj:repro",
      taskRef: "task:delivery",
      updates: [{ id: "profile-qualified", evidenceRefs: ["evidence:profile"] }],
    },
    agent: async () => ({ verdict: "pass" }),
    evidenceRecord: async (record) => {
      records.push({
        title: record.title,
        projectRef: record.projectRef,
        taskRef: record.taskRef,
      });
      return { ref: "evidence:delivery-receipt" };
    },
  });
  assert.deepEqual(records, [
    {
      title: "repro:delivery-sync managed sections",
      projectRef: "proj:repro",
      taskRef: "task:delivery",
    },
  ]);
  assert.deepEqual((run.result as { receipt?: unknown }).receipt, {
    ref: "evidence:delivery-receipt",
  });
});
