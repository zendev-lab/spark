import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nowIso, type EvidenceRef, type TaskPlan } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import { registerSparkTodoTools } from "./spark-todo-tool-registration.ts";
import { saveCurrentProjectRef, sparkSessionKey, sparkStateCwd } from "./session-state.ts";
import type { SparkRegisteredToolConfig, SparkToolContext } from "./spark-tool-registration.ts";

function testContext(cwd: string): SparkToolContext {
  const sessionId = "session:plan-items";
  return {
    cwd,
    sessionId,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "session.json"),
      isPersisted: () => true,
    },
  };
}

function planWithMetadata(input: {
  id: string;
  title: string;
  description: string;
  evidenceRef: EvidenceRef;
}): TaskPlan {
  const now = nowIso();
  return {
    objective: `Complete ${input.title}`,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`pnpm test verifies ${input.title} with exit code 0.`],
    evidenceRequired: [`Evidence ${input.evidenceRef} records the validation result.`],
    items: [
      {
        id: input.id,
        title: input.title,
        description: input.description,
        status: "in_progress",
        notes: ["retain this note"],
        blockedBy: [],
        evidenceRefs: [input.evidenceRef],
        createdAt: now,
        updatedAt: now,
      },
    ],
    steps: [input.title],
    riskLevel: "normal",
    openQuestions: [],
    askRefs: [],
  };
}

function capturePlanUpdateTool(): SparkRegisteredToolConfig {
  let tool: SparkRegisteredToolConfig | undefined;
  registerSparkTodoTools(
    (registered) => {
      if (registered.name === "impl_update_task_plan_items") tool = registered;
    },
    { refreshSparkWidget: async () => undefined },
  );
  expect(tool).toBeTruthy();
  return tool!;
}

describe("task plan item updates", () => {
  it("honors taskRef and changes progress without dropping description or Evidence refs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-plan-item-metadata-"));
    try {
      const ctx = testContext(cwd);
      const sessionKey = sparkSessionKey(ctx);
      const stateCwd = sparkStateCwd(cwd, ctx);
      const store = defaultTaskGraphStore(stateCwd);
      const graph = new TaskGraph();
      const project = graph.createProject({
        title: "Plan item metadata",
        description: "Preserve task plan semantics",
      });
      const evidenceRef = "evidence:plan-item-contract" as EvidenceRef;
      const target = graph.createTask({
        projectRef: project.ref,
        name: "metadata-target",
        title: "Metadata target",
        description: "Update exactly this plan item",
        kind: "implement",
        status: "running",
        plan: planWithMetadata({
          id: "target-item",
          title: "Run focused validation",
          description: "Execute the focused validation and retain this semantic detail.",
          evidenceRef,
        }),
      });
      const distractor = graph.createTask({
        projectRef: project.ref,
        name: "metadata-distractor",
        title: "Metadata distractor",
        description: "Must remain unchanged",
        kind: "implement",
        status: "running",
        plan: planWithMetadata({
          id: "distractor-item",
          title: "Keep distractor running",
          description: "This item must not be selected by current-task fallback.",
          evidenceRef: "evidence:distractor" as EvidenceRef,
        }),
      });
      graph.claimTask(target.ref, {
        kind: "main",
        claimedBy: sessionKey,
        sessionId: sessionKey,
        leaseMs: 60_000,
      });
      graph.claimTask(distractor.ref, {
        kind: "role-run",
        claimedBy: `${sessionKey}/distractor-run`,
        sessionId: sessionKey,
        runName: "distractor-run",
        leaseMs: 60_000,
      });
      graph.setCurrentTask(project.ref, distractor.ref);
      await store.save(graph);
      await saveCurrentProjectRef(cwd, ctx, project.ref, distractor.ref);

      const tool = capturePlanUpdateTool();
      const additionalEvidenceRef = "evidence:focused-validation" as EvidenceRef;
      await tool.execute(
        "plan-update",
        {
          taskRef: target.ref,
          ops: [
            {
              op: "done",
              id: "target-item",
              evidenceRefs: [additionalEvidenceRef, evidenceRef],
            },
          ],
        },
        new AbortController().signal,
        () => undefined,
        ctx,
      );

      const persisted = await store.load();
      const targetItem = persisted
        ?.getTask(target.ref)
        .plan?.items?.find((item) => item.id === "target-item");
      const distractorItem = persisted
        ?.getTask(distractor.ref)
        .plan?.items?.find((item) => item.id === "distractor-item");
      expect(targetItem).toMatchObject({
        status: "done",
        description: "Execute the focused validation and retain this semantic detail.",
        evidenceRefs: [evidenceRef, additionalEvidenceRef],
      });
      expect(distractorItem?.status).toBe("in_progress");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects cross-namespace plan item evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-plan-item-evidence-namespace-"));
    try {
      const ctx = testContext(cwd);
      const sessionKey = sparkSessionKey(ctx);
      const store = defaultTaskGraphStore(sparkStateCwd(cwd, ctx));
      const graph = new TaskGraph();
      const project = graph.createProject({
        title: "Plan item Evidence namespace",
        description: "Reject Artifact refs in plan item Evidence",
      });
      const task = graph.createTask({
        projectRef: project.ref,
        name: "evidence-target",
        title: "Evidence target",
        description: "Attach only canonical Evidence refs",
        status: "running",
        plan: planWithMetadata({
          id: "evidence-item",
          title: "Attach focused evidence",
          description: "Keep Evidence and Artifact namespaces separate.",
          evidenceRef: "evidence:existing" as EvidenceRef,
        }),
      });
      graph.claimTask(task.ref, {
        kind: "main",
        claimedBy: sessionKey,
        sessionId: sessionKey,
        leaseMs: 60_000,
      });
      await store.save(graph);
      await saveCurrentProjectRef(cwd, ctx, project.ref, task.ref);

      const tool = capturePlanUpdateTool();
      await expect(
        tool.execute(
          "plan-update",
          {
            taskRef: task.ref,
            ops: [{ op: "done", id: "evidence-item", evidenceRefs: ["artifact:not-evidence"] }],
          },
          new AbortController().signal,
          () => undefined,
          ctx,
        ),
      ).rejects.toThrow(/evidenceRefs\[0\] must be an evidence: ref/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
