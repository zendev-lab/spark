import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { loadSparkSessionWorkspaceState } from "@zendev-lab/spark-loop";
import { TaskGraph, defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import {
  enterSparkExecuteMode,
  enterSparkFleetMode,
  enterSparkPlanMode,
  type SparkModeMessageApi,
} from "../policy/spark-mode-entry.ts";
import { renderSparkActiveSystemPrompt } from "../policy/spark-active-injection.ts";
import type { SparkToolContext } from "../policy/spark-tool-registration.ts";

type SentMessage = {
  message: Parameters<SparkModeMessageApi["sendMessage"]>[0];
  options: Parameters<SparkModeMessageApi["sendMessage"]>[1];
};

async function withDirectiveProject<T>(
  run: (input: { cwd: string; ctx: SparkToolContext; graph: TaskGraph }) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "spark-one-shot-directive-"));
  try {
    const graph = new TaskGraph();
    graph.createProject({ title: "Directive project", description: "One-shot directive scope." });
    await defaultTaskGraphStore(cwd).save(graph);
    return await run({ cwd, ctx: { cwd, sessionId: "directive-session" }, graph });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function recordingApi(sent: SentMessage[]): SparkModeMessageApi {
  return {
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
}

const deps = {
  queueSparkAgentInstruction: () => undefined,
  refreshSparkWidget: async () => undefined,
  ensureWorkflowRunManager: async () => undefined,
};

test("one-shot /plan, /execute, /fleet inject guidance without persisting any session mode", async () => {
  await withDirectiveProject(async ({ cwd, ctx, graph }) => {
    const sent: SentMessage[] = [];
    const api = recordingApi(sent);

    await enterSparkPlanMode(api, deps, ctx, graph, "shape the work", "direct");
    await enterSparkExecuteMode(api, deps, ctx, graph);
    await enterSparkFleetMode(api, deps, ctx, graph);

    assert.equal(sent.length, 3);
    for (const entry of sent) {
      assert.equal(entry.message.customType, "spark-directive-request");
      assert.equal(entry.message.authority, "runtime_control");
      assert.equal(entry.message.trust, "trusted");
    }

    // No mode is persisted: the session workspace state either does not exist
    // or carries no retired mode field.
    const state = await loadSparkSessionWorkspaceState(cwd, ctx);
    assert.equal(state === undefined || !Object.hasOwn(state, "mode"), true);
  });
});

test("one-shot directive prefers the session turn channel when the host provides one", async () => {
  await withDirectiveProject(async ({ ctx, graph }) => {
    const sent: SentMessage[] = [];
    const userMessages: string[] = [];
    const ctxWithChannel: SparkToolContext = {
      ...ctx,
      sendUserMessage: async (content) => {
        userMessages.push(content);
      },
    };
    await enterSparkExecuteMode(recordingApi(sent), deps, ctxWithChannel, graph);

    assert.equal(sent.length, 0, "directive guidance must ride the turn channel");
    assert.equal(userMessages.length, 1);
    assert.equal(await loadSparkSessionWorkspaceState(ctx.cwd, ctx), undefined);
  });
});

test("the standing per-turn prompt is neutral without any directive", () => {
  assert.equal(renderSparkActiveSystemPrompt("Base prompt."), "Base prompt.");
});
