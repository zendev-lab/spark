import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createSparkWorkflowRoleRunAdapter,
  SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS,
  type SparkWorkflowGraftAgentResult,
  type SparkWorkflowRoleRunRequest,
} from "./index.ts";

test("spark-workflows role-run adapter sends model agents through model runner hook", async () => {
  const roleRequests: unknown[] = [];
  const modelRequests: unknown[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-executor",
    async runRoleInstruction(request) {
      roleRequests.push(request);
      return { text: "role result" };
    },
    async runModelInstruction(request) {
      modelRequests.push(request);
      return { text: "model result" };
    },
  });

  const result = await agent("Compare model answers", {
    index: 1,
    label: "panel 1",
    stage: "Panel",
    model: "provider/model",
    agentType: "model",
    timeoutMs: 250,
    evidenceRef: "evidence:brief-456",
  });

  assert.equal(result, "model result");
  assert.equal(roleRequests.length, 0);
  assert.equal(modelRequests.length, 1);
  const request = modelRequests[0] as {
    prompt: string;
    label: string;
    stage?: string;
    phase?: string;
    model?: string;
    metadata: Record<string, unknown>;
  };
  assert.equal(request.prompt, "Compare model answers");
  assert.equal(request.label, "panel 1");
  assert.equal(request.stage, "Panel");
  assert.equal(request.phase, "Panel");
  assert.equal(request.model, "provider/model");
  assert.equal(request.metadata.workflowAgent, true);
  assert.equal(request.metadata.agentType, "model");
  assert.equal(request.metadata.index, 1);
  assert.equal(request.metadata.timeoutMs, 250);
  assert.equal(request.metadata.evidenceRef, "evidence:brief-456");
});

test("spark-workflows role-run adapter honors an explicit reusable roleRef", async () => {
  let selectedRoleRef: string | undefined;
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-executor",
    async runRoleInstruction(request) {
      selectedRoleRef = request.roleRef;
      return { text: "specialist result" };
    },
  });

  const result = await agent("Audit numerical evidence", {
    index: 0,
    roleRef: "role:extension-repro-numerical-auditor",
  });

  assert.equal(result, "specialist result");
  assert.equal(selectedRoleRef, "role:extension-repro-numerical-auditor");
});

test("spark-workflows role-run adapter resolves a role selector to an exact revision", async () => {
  const requests: SparkWorkflowRoleRunRequest[] = [];
  const telemetry: unknown[] = [];
  const revision = `sha256:${"a".repeat(64)}`;
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-executor",
    resolveRole(selector) {
      assert.equal(selector, "spark-architecture-guardian");
      return {
        roleRef: "role:project-spark-architecture-guardian",
        roleRevision: revision,
      };
    },
    async runRoleInstruction(request) {
      requests.push(request);
      return { text: "approved" };
    },
  });

  const result = await agent("Review boundaries", {
    index: 0,
    role: "spark-architecture-guardian",
    reportTelemetry: (value) => telemetry.push(value),
  });

  assert.equal(result, "approved");
  assert.equal(requests[0]?.roleRef, "role:project-spark-architecture-guardian");
  assert.equal(requests[0]?.roleRevision, revision);
  assert.deepEqual(requests[0]?.metadata, {
    workflowAgent: true,
    label: "workflow-agent-1",
    stage: undefined,
    phase: undefined,
    model: undefined,
    agentType: undefined,
    isolation: undefined,
    timeoutMs: undefined,
    evidenceRef: undefined,
    envKeys: undefined,
    allowedTools: undefined,
    roleSelector: "spark-architecture-guardian",
    roleRef: "role:project-spark-architecture-guardian",
    roleRevision: revision,
    index: 0,
  });
  assert.deepEqual(telemetry, [
    {
      metadata: {
        roleSelector: "spark-architecture-guardian",
        roleRef: "role:project-spark-architecture-guardian",
        roleRevision: revision,
      },
    },
  ]);
});

test("spark-workflows role-run adapter rejects selectors without a host resolver", async () => {
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-executor",
    async runRoleInstruction() {
      return { text: "should not run" };
    },
  });

  await assert.rejects(
    () => agent("Review boundaries", { index: 0, role: "spark-architecture-guardian" }),
    /role selector requires a host role resolver/,
  );
});

test("spark-workflows role-run adapter forwards child usage telemetry", async () => {
  const reported: unknown[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-executor",
    async runRoleInstruction() {
      return {
        text: "role result",
        telemetry: {
          runRef: "run:child-telemetry",
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsd: 0.004 },
        },
      };
    },
  });

  const result = await agent("Inspect usage", {
    index: 0,
    reportTelemetry: (telemetry) => reported.push(telemetry),
  });

  assert.equal(result, "role result");
  assert.deepEqual(reported, [
    {
      runRef: "run:child-telemetry",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsd: 0.004 },
      metadata: { roleRef: "role:builtin-executor" },
    },
  ]);
});

test("spark-workflows role-run adapter fails model agents when model hook is missing", async () => {
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-executor",
    async runRoleInstruction() {
      return { text: "role result" };
    },
  });

  await assert.rejects(
    () =>
      agent("model prompt", {
        index: 0,
        agentType: "model",
      }),
    /workflow model agent runner is not configured/,
  );
});

test("spark-workflows role-run adapter maps workflow agents to Spark dependency boundary", async () => {
  const requests: unknown[] = [];
  const telemetryReports: unknown[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-executor",
    graftBaseRef: "tree:isolated",
    async runRoleInstruction(request) {
      requests.push(request);
      return { text: "adapter result with scratch:abc candidate:def patch:ghi" };
    },
  });

  const result = (await agent("Inspect auth routes", {
    index: 2,
    label: "auth reviewer",
    stage: "Review",
    model: "provider/model",
    agentType: "reviewer",
    isolation: "graft",
    timeoutMs: 123,
    evidenceRef: "evidence:brief-123",
    reportTelemetry: (telemetry) => {
      telemetryReports.push(telemetry);
    },
  })) as SparkWorkflowGraftAgentResult;

  assert.equal(result.text, "adapter result with scratch:abc candidate:def patch:ghi");
  assert.deepEqual(result.graftRefs, {
    scratchRefs: ["scratch:abc"],
    candidateRefs: ["candidate:def"],
    patchRefs: ["patch:ghi"],
  });
  assert.deepEqual(telemetryReports, [
    {
      metadata: {
        roleRef: "role:builtin-executor",
        graftRefs: {
          scratchRefs: ["scratch:abc"],
          candidateRefs: ["candidate:def"],
          patchRefs: ["patch:ghi"],
        },
      },
    },
  ]);
  assert.equal(requests.length, 1);
  const request = requests[0] as SparkWorkflowRoleRunRequest;
  assert.equal(request.label, "auth reviewer");
  assert.equal(request.stage, "Review");
  assert.equal(request.phase, "Review");
  assert.equal(request.model, "provider/model");
  assert.equal(request.metadata.workflowAgent, true);
  assert.equal(request.metadata.index, 2);
  assert.equal(request.metadata.isolation, "graft");
  assert.equal(request.metadata.evidenceRef, "evidence:brief-123");
  assert.deepEqual(request.metadata.envKeys, ["GRAFT_BASE_REF"]);
  assert.deepEqual(request.metadata.allowedTools, SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS);
  assert.equal(request.env?.GRAFT_BASE_REF, "tree:isolated");
  assert.deepEqual(request.allowedTools, SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS);
  assert.equal(request.allowedTools?.includes("read"), false);
  assert.equal(request.allowedTools?.includes("write"), false);
  assert.equal(request.allowedTools?.includes("edit"), false);
});

test("Spark workflow role-run adapter refuses graft isolation without a base", async () => {
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-executor",
    async runRoleInstruction() {
      return { text: "should not run" };
    },
  });

  await assert.rejects(
    () => agent("edit files", { index: 0, isolation: "graft" }),
    /workflow graft isolation requires persisted workflow base metadata/,
  );
});
