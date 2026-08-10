import assert from "node:assert/strict";
import { test } from "vitest";

import type { LeafCapabilityRequest, Task, TaskPlan } from "@zendev-lab/spark-core";
import type { TaskReviewInput } from "@zendev-lab/spark-roles";

import { runTaskFinishReviewWorkflow } from "./spark-finish-review-workflow.ts";

function reviewInput(): TaskReviewInput {
  const plan: TaskPlan = {
    objective: "Verify the bounded finish reviewer.",
    contextRefs: ["docs/specs/tools.md"],
    constraints: ["Do not relax correctness gates."],
    nonGoals: ["Do not inspect unrelated Tasks."],
    successCriteria: ["Focused tests pass."],
    evidenceRequired: ["evidence:focused-test records the passing command."],
    steps: ["legacy step text must not enter the compact packet"],
    items: [
      {
        id: "done-item",
        title: "Completed item",
        status: "done",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
    openQuestions: [],
    askRefs: [],
    riskLevel: "normal",
  };
  const task: Task = {
    ref: "task:finish-review" as Task["ref"],
    projectRef: "project:review" as Task["projectRef"],
    name: "finish-review",
    title: "Finish review",
    description: "Use one bounded leaf decision before any deep Reviewer Session.",
    kind: "review",
    status: "running",
    supersededBy: [],
    artifactRefs: [],
    inputEvidenceRefs: [],
    outputEvidenceRefs: ["evidence:focused-test" as Task["outputEvidenceRefs"][number]],
    plan,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
  return {
    targetKind: "task",
    cwd: "/workspace",
    projectRef: task.projectRef,
    task,
    requestedStatus: "done",
    summary: "Focused tests passed.",
    evidenceRefs: task.outputEvidenceRefs,
    evidencePreviews: [
      {
        ref: task.outputEvidenceRefs[0]!,
        title: "Focused test",
        bodyPreview: "pnpm test exited 0",
      },
    ],
  };
}

test("task finish workflow uses one tool-free compact leaf review", async () => {
  let captured: LeafCapabilityRequest | undefined;
  const result = await runTaskFinishReviewWorkflow(
    {
      runLeaf: async (request) => {
        captured = request;
        return {
          degraded: false,
          model: "fast/reviewer",
          text: JSON.stringify({
            outcome: "approved",
            summary: "Evidence satisfies the selected Task.",
            findings: [],
            blockers: [],
            confidence: "high",
            requestedEvidenceRefs: [],
            requestedArtifactRefs: [],
            requiresCurrentTransitionReceipt: false,
          }),
        };
      },
    },
    reviewInput(),
    undefined,
    { model: "fast/reviewer", now: () => "2026-08-10T00:00:00.000Z" },
  );

  assert.equal(result.kind, "reviewed");
  if (result.kind !== "reviewed") return;
  assert.equal(result.review.verdict.outcome, "approved");
  assert.equal(result.review.record.runName, "task-finish-review-workflow");
  assert.equal(captured?.role, "task-finish-review");
  assert.equal(captured?.model, "fast/reviewer");
  assert.equal(captured?.reasoning, false);
  assert.equal(captured?.maxTokens, 1_200);
  const packet = JSON.parse(captured?.input ?? "{}") as {
    task?: { plan?: Record<string, unknown> };
  };
  assert.equal(packet.task?.plan?.objective, "Verify the bounded finish reviewer.");
  assert.equal(packet.task?.plan?.steps, undefined);
  assert.deepEqual(packet.task?.plan?.itemCounts, { total: 1, done: 1, unfinished: 0 });
});

test("task finish workflow escalates only an explicit needs_deep_review decision", async () => {
  const result = await runTaskFinishReviewWorkflow(
    {
      runLeaf: async () => ({
        degraded: false,
        model: "fast/reviewer",
        text: JSON.stringify({
          outcome: "needs_deep_review",
          summary: "Repository inspection is required to verify generated bindings.",
        }),
      }),
    },
    reviewInput(),
    undefined,
    { model: "fast/reviewer" },
  );

  assert.deepEqual(result, {
    kind: "needs_deep_review",
    reason: "Repository inspection is required to verify generated bindings.",
    model: "fast/reviewer",
  });
});

test("task finish workflow fails closed on malformed leaf output without deep escalation", async () => {
  const result = await runTaskFinishReviewWorkflow(
    {
      runLeaf: async () => ({
        degraded: false,
        model: "fast/reviewer",
        text: '```json\n{"outcome":"approved"}\n```',
      }),
    },
    reviewInput(),
    undefined,
    { model: "fast/reviewer" },
  );

  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") return;
  assert.equal(result.review.failure?.kind, "protocol_error");
  assert.equal(result.review.failure?.retryable, false);
});

test("task finish workflow keeps an explicit compatibility fallback for hosts without leaves", async () => {
  const result = await runTaskFinishReviewWorkflow({}, reviewInput(), undefined, {
    model: "fast/reviewer",
  });
  assert.deepEqual(result, { kind: "compatibility_fallback", reason: "host-unsupported" });
});

test("task finish workflow fails closed on a configured leaf route failure", async () => {
  const result = await runTaskFinishReviewWorkflow(
    {
      runLeaf: async () => ({
        degraded: true,
        text: "",
        reasonCode: "route-unavailable",
      }),
    },
    reviewInput(),
    undefined,
    { model: "fast/reviewer" },
  );
  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") return;
  assert.match(result.review.failure?.reason ?? "", /route-unavailable/u);
  assert.equal(result.review.failure?.retryable, false);
});

test("task finish workflow turns a thrown leaf call into a non-retryable unavailable verdict", async () => {
  const result = await runTaskFinishReviewWorkflow(
    {
      runLeaf: async () => {
        throw new Error("provider transport closed");
      },
    },
    reviewInput(),
    undefined,
    { model: " fast/reviewer " },
  );
  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") return;
  assert.match(result.review.failure?.reason ?? "", /model-call-failed.*transport closed/u);
  assert.equal(result.review.failure?.retryable, false);
});

test("task finish workflow does not inherit the Session model when verification is unconfigured", async () => {
  let leafCalls = 0;
  const result = await runTaskFinishReviewWorkflow(
    {
      runLeaf: async () => {
        leafCalls += 1;
        return { degraded: false, text: "{}" };
      },
    },
    reviewInput(),
    undefined,
  );
  assert.equal(result.kind, "unavailable");
  assert.equal(leafCalls, 0);
  if (result.kind !== "unavailable") return;
  assert.match(result.review.failure?.reason ?? "", /no-model/u);
});
