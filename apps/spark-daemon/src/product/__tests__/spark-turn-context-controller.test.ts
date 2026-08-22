import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { createSparkContextRegistry } from "@zendev-lab/spark-host/context";
import { registerSparkProductEvents } from "../policy/spark-product-events.ts";
import { createSparkTurnContextController } from "../policy/spark-turn-context-controller.ts";
import type { SparkToolContext } from "../policy/spark-tool-registration.ts";

test("turn context controller projects only changed provider snapshots", async () => {
  let content: string | undefined = "first state";
  const registry = createSparkContextRegistry([
    {
      id: "test.state",
      label: "Test state",
      description: "Mutable test state.",
      defaultBudgetChars: 100,
      async render() {
        if (content === undefined) return undefined;
        return { content, refs: ["state.json"] };
      },
    },
  ]);
  const controller = createSparkTurnContextController(registry, {
    providerIds: ["test.state"],
  });
  const ctx: SparkToolContext = { cwd: "/tmp/spark-turn-context", sessionId: "session-a" };

  const first = await controller.collect(ctx);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.customType, "spark-context-snapshot");
  assert.equal(first[0]?.authority, "runtime_data");
  assert.equal(first[0]?.trust, "untrusted");
  assert.match(first[0]?.content ?? "", /first state/);
  assert.deepEqual(first[0]?.details.refs, ["state.json"]);
  assert.equal(first[0]?.details.cleared, false);

  assert.deepEqual(await controller.collect(ctx), []);

  content = "second state";
  const changed = await controller.collect(ctx);
  assert.equal(changed.length, 1);
  assert.match(changed[0]?.content ?? "", /second state/);
  assert.notEqual(changed[0]?.details.snapshotId, first[0]?.details.snapshotId);

  content = undefined;
  const cleared = await controller.collect(ctx);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]?.details.cleared, true);
  assert.match(cleared[0]?.content ?? "", /supersedes earlier snapshots/);
  assert.deepEqual(await controller.collect(ctx), []);
});

test("turn context controller observes provider revisions beyond the rendered budget", async () => {
  let revision = "revision-a";
  const registry = createSparkContextRegistry([
    {
      id: "test.revisioned",
      label: "Revisioned state",
      description: "State whose tail changes beyond the rendered budget.",
      defaultBudgetChars: 8,
      async render() {
        return { content: "unchanged-prefix-with-hidden-tail", revision };
      },
    },
  ]);
  const controller = createSparkTurnContextController(registry, {
    providerIds: ["test.revisioned"],
  });
  const ctx: SparkToolContext = {
    cwd: "/tmp/spark-turn-context",
    sessionId: "revision-session",
  };

  const first = await controller.collect(ctx);
  revision = "revision-b";
  const changed = await controller.collect(ctx);

  assert.equal(first.length, 1);
  assert.equal(changed.length, 1);
  assert.notEqual(first[0]?.details.snapshotId, changed[0]?.details.snapshotId);
  assert.equal(changed[0]?.details.truncated, true);
});

test("turn context controller isolates sessions and replays after reset", async () => {
  const registry = createSparkContextRegistry([
    {
      id: "test.state",
      label: "Test state",
      description: "Static test state.",
      defaultBudgetChars: 100,
      async render() {
        return "shared state";
      },
    },
  ]);
  const controller = createSparkTurnContextController(registry, {
    providerIds: ["test.state"],
  });
  const first: SparkToolContext = {
    cwd: "/tmp/spark-turn-context",
    sessionId: "session-a",
  };
  const second: SparkToolContext = {
    cwd: "/tmp/spark-turn-context",
    sessionId: "session-b",
  };

  const firstInitial = await controller.collect(first);
  const secondInitial = await controller.collect(second);
  assert.equal(firstInitial[0]?.details.providerId, "test.state");
  assert.equal(secondInitial[0]?.details.providerId, "test.state");
  assert.deepEqual(await controller.collect(first), []);

  controller.reset(first);
  const firstAfterReset = await controller.collect(first);
  assert.equal(firstAfterReset[0]?.details.providerId, "test.state");
  assert.deepEqual(await controller.collect(second), []);

  controller.resetAll();
  const firstReplay = await controller.collect(first);
  const secondReplay = await controller.collect(second);
  assert.equal(firstReplay.length, 1);
  assert.equal(secondReplay.length, 1);
});

test("extension lifecycle merges turn context and resets it after compact or switch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-turn-context-events-"));
  const handlers = new Map<string, (event: unknown, ctx: SparkToolContext) => unknown>();
  let resetCount = 0;
  let projected = false;
  const message = {
    customType: "spark-context-snapshot" as const,
    content: "current test state",
    display: false as const,
    authority: "runtime_data" as const,
    trust: "untrusted" as const,
    details: { providerId: "test.state" },
  };
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
      turnContextController: {
        async collect() {
          if (projected) return [];
          projected = true;
          return [message];
        },
        reset() {
          resetCount += 1;
          projected = false;
        },
      },
    },
  );
  const ctx: SparkToolContext = { cwd, sessionId: "event-session" };

  try {
    const injected = (await handlers.get("before_agent_start")?.({}, ctx)) as {
      messages?: unknown[];
    };
    assert.deepEqual(injected.messages, [message]);
    assert.equal(await handlers.get("before_agent_start")?.({}, ctx), undefined);

    await handlers.get("session_compact")?.({}, ctx);
    assert.equal(resetCount, 1);
    const replayedAfterCompact = (await handlers.get("before_agent_start")?.({}, ctx)) as {
      messages?: unknown[];
    };
    assert.deepEqual(replayedAfterCompact.messages, [message]);
    assert.equal(await handlers.get("before_agent_start")?.({}, ctx), undefined);

    await handlers.get("session_switch")?.({}, ctx);
    assert.equal(resetCount, 2);
    const replayedAfterSwitch = (await handlers.get("before_agent_start")?.({}, ctx)) as {
      messages?: unknown[];
    };
    assert.deepEqual(replayedAfterSwitch.messages, [message]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
