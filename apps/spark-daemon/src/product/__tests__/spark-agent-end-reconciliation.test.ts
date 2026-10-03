import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { registerSparkProductEvents } from "../policy/spark-product-events.ts";
import type { SparkModeMessageApi } from "../policy/spark-mode-entry.ts";
import { saveIndependentTodos } from "../policy/session-todos.ts";
import { createSparkAgentEndReconciliationController } from "../policy/spark-agent-end-reconciliation.ts";
import type { SparkToolContext } from "../policy/spark-tool-registration.ts";

type SentMessage = {
  message: Parameters<SparkModeMessageApi["sendMessage"]>[0];
  options: Parameters<SparkModeMessageApi["sendMessage"]>[1];
};

test("agent-end TODO reconciliation queues one guarded follow-up per input cycle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-todo-reconciliation-"));
  const ctx: SparkToolContext = { cwd, sessionId: "todo-reconciliation" };
  const sent: SentMessage[] = [];
  const controller = createSparkAgentEndReconciliationController({
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  });

  try {
    await saveIndependentTodos(cwd, ctx, [
      { id: "todo-active", content: "Verify the release gate", status: "in_progress" },
      { id: "todo-pending", content: "Publish the summary", status: "pending" },
      { id: "todo-blocked", content: "Wait for approval", status: "blocked" },
      { id: "todo-done", content: "Run unit tests", status: "done" },
    ]);

    assert.equal(await controller.reconcile(ctx), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.message.customType, "spark-agent-end-reconciliation");
    assert.equal(sent[0]?.message.display, false);
    assert.equal(sent[0]?.message.authority, "runtime_control");
    assert.equal(sent[0]?.message.trust, "trusted");
    assert.deepEqual(sent[0]?.options, { deliverAs: "followUp", triggerTurn: true });
    assert.match(sent[0]?.message.content ?? "", /todo-active.*Verify the release gate/);
    assert.match(sent[0]?.message.content ?? "", /todo-pending.*Publish the summary/);
    assert.match(sent[0]?.message.content ?? "", /todo-blocked.*Wait for approval/);
    assert.doesNotMatch(sent[0]?.message.content ?? "", /todo-done/);

    assert.equal(await controller.reconcile(ctx), false);
    assert.equal(sent.length, 1, "automatic follow-up must not recurse");

    await saveIndependentTodos(cwd, ctx, [
      { id: "todo-done", content: "Run unit tests", status: "done" },
    ]);
    assert.equal(await controller.reconcile(ctx), false);
    await saveIndependentTodos(cwd, ctx, [
      { id: "todo-late", content: "Late automatic work", status: "pending" },
    ]);
    assert.equal(await controller.reconcile(ctx), false);
    assert.equal(sent.length, 1, "clearing work must not reopen the same input cycle");

    controller.reset(ctx);
    assert.equal(await controller.reconcile(ctx), true);
    assert.equal(sent.length, 2, "a new user input cycle may remind again");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("agent-end TODO reconciliation does not continue blocked or terminal checklists", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-todo-reconciliation-terminal-"));
  const ctx: SparkToolContext = { cwd, sessionId: "todo-reconciliation-terminal" };
  const sent: SentMessage[] = [];
  const controller = createSparkAgentEndReconciliationController({
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  });

  try {
    await saveIndependentTodos(cwd, ctx, [
      { id: "todo-blocked", content: "Wait for approval", status: "blocked" },
      { id: "todo-done", content: "Run unit tests", status: "done" },
      { id: "todo-cancelled", content: "Discarded follow-up", status: "cancelled" },
    ]);

    assert.equal(await controller.reconcile(ctx), false);
    assert.deepEqual(sent, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Spark product policy wires hook-owned reconciliation to turn_end with agent_end fallback", () => {
  const handlers = new Map<string, (event: unknown, ctx: SparkToolContext) => unknown>();
  registerSparkProductEvents(
    {
      on(event, handler) {
        handlers.set(event, handler);
      },
      sendMessage() {},
    },
    {
      refreshSparkWidget: async () => undefined,
      ensureWorkflowRunManager: async () => undefined,
    },
  );

  assert.ok(handlers.has("turn_end"));
  assert.ok(handlers.has("agent_end"));
});

test("terminal turn_end reconciles in-run while tool and failed turns defer to agent_end", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-terminal-todo-reconciliation-"));
  const handlers = new Map<string, (event: unknown, ctx: SparkToolContext) => unknown>();
  const sent: SentMessage[] = [];
  registerSparkProductEvents(
    {
      on(event, handler) {
        handlers.set(event, handler);
      },
      sendMessage(message, options) {
        sent.push({ message, options });
      },
    },
    {
      refreshSparkWidget: async () => undefined,
      ensureWorkflowRunManager: async () => undefined,
    },
  );

  try {
    const terminalCtx: SparkToolContext = { cwd, sessionId: "terminal" };
    await saveIndependentTodos(cwd, terminalCtx, [
      { id: "todo-terminal", content: "Reconcile before final output", status: "in_progress" },
    ]);
    await handlers.get("turn_end")?.(
      { message: { stopReason: "stop", content: [{ type: "text", text: "Done" }] } },
      terminalCtx,
    );
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.options, { deliverAs: "followUp", triggerTurn: false });

    await handlers.get("agent_end")?.({}, terminalCtx);
    assert.equal(sent.length, 1, "agent_end fallback must not duplicate in-run reconciliation");

    for (const [sessionId, message] of [
      ["tooling", { stopReason: "toolUse", content: [{ type: "toolCall", name: "todo" }] }],
      ["failed", { stopReason: "error", content: [{ type: "text", text: "failed" }] }],
      ["aborted", { stopReason: "aborted", content: [{ type: "text", text: "aborted" }] }],
    ] as const) {
      const ctx: SparkToolContext = { cwd, sessionId };
      await saveIndependentTodos(cwd, ctx, [
        { id: `todo-${sessionId}`, content: `Pending ${sessionId}`, status: "pending" },
      ]);
      await handlers.get("turn_end")?.({ message }, ctx);
    }
    assert.equal(sent.length, 1, "non-terminal turn_end events must not reconcile");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
