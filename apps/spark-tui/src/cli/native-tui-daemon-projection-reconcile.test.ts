import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { SPARK_PROTOCOL_VERSION, type SparkSessionView } from "@zendev-lab/spark-protocol";

import {
  nativeTuiDaemonProjectionSignature,
  reconcileIdleNativeTuiDaemonProjection,
  startIdleNativeTuiDaemonProjectionReconcile,
} from "./native-tui-daemon-projection-reconcile.ts";

function projectionView(overrides: Record<string, unknown> = {}): SparkSessionView {
  return {
    version: SPARK_PROTOCOL_VERSION,
    sessionId: "session",
    status: "idle",
    messages: [],
    tools: [],
    runs: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    metadata: {},
    ...overrides,
  } as SparkSessionView;
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

test("native TUI projection signature tracks pending turns, messages, and work stage", () => {
  const baseline = nativeTuiDaemonProjectionSignature(projectionView());
  const pending = nativeTuiDaemonProjectionSignature(
    projectionView({
      pendingTurns: [
        {
          invocationId: "inv_later",
          prompt: "tick",
          status: "running",
          createdAt: "2026-08-17T00:00:01.000Z",
        },
      ],
    }),
  );
  const message = nativeTuiDaemonProjectionSignature(
    projectionView({
      messages: [
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "msg_1",
          role: "assistant",
          text: "done",
          status: "done",
          updatedAt: "2026-08-17T00:00:02.000Z",
          metadata: {},
        },
      ],
    }),
  );
  const repro = nativeTuiDaemonProjectionSignature(
    projectionView({
      work: {
        repro: {
          version: 10,
          reproId: "repro:test",
          status: "active",
          objective: "Reproduce the target",
          workItemId: "work:test",
          lanes: {
            implementation: {
              sessionId: "session:implementation",
              taskRef: "task:implementation",
              roleRef: "role:implementation",
            },
            exactness: {
              sessionId: "session:exactness",
              taskRef: "task:exactness",
              roleRef: "role:exactness",
            },
            formalize: {
              sessionId: "session:formalize",
              taskRef: "task:formalize",
              roleRef: "role:formalize",
            },
          },
          checkpoint: {
            checkpointId: "checkpoint:exactness",
            kind: "exactness",
            lane: "exactness",
            status: "running",
            sessionId: "session:exactness",
            taskRef: "task:exactness",
            runRef: "run:exactness",
            attempt: 1,
            evidenceRefs: [],
          },
          progress: { accepted: 1, total: 5 },
          updatedAt: "2026-08-17T00:00:03.000Z",
        },
      },
    }),
  );
  assert.notEqual(pending, baseline);
  assert.notEqual(message, baseline);
  assert.notEqual(repro, baseline);
});

test("idle TUI reconcile skips snapshot apply while the session is processing", async () => {
  let loaded = 0;
  let applied = 0;
  let widgets = 0;
  const signature = await reconcileIdleNativeTuiDaemonProjection({
    isProcessing: () => true,
    lastSignature: "seed",
    loadSnapshot: async () => {
      loaded += 1;
      return projectionView({ updatedAt: "2026-08-17T00:00:01.000Z" });
    },
    applySnapshot: () => {
      applied += 1;
    },
    refreshWidget: async () => {
      widgets += 1;
    },
  });
  assert.equal(signature, "seed");
  assert.equal(loaded, 0);
  assert.equal(applied, 0);
  assert.equal(widgets, 0);
});

test("idle TUI reconcile skips apply after the TUI aborts during snapshot load", async () => {
  const controller = new AbortController();
  let applied = 0;
  let widgets = 0;
  const signature = await reconcileIdleNativeTuiDaemonProjection({
    isProcessing: () => false,
    lastSignature: "seed",
    signal: controller.signal,
    loadSnapshot: async () => {
      controller.abort();
      return projectionView({ updatedAt: "2026-08-17T00:00:01.000Z" });
    },
    applySnapshot: () => {
      applied += 1;
    },
    refreshWidget: async () => {
      widgets += 1;
    },
  });
  assert.equal(signature, "seed");
  assert.equal(applied, 0);
  assert.equal(widgets, 0);
});

test("idle TUI reconcile skips apply when processing starts while the snapshot loads", async () => {
  let processing = false;
  let applied = 0;
  let widgets = 0;
  const signature = await reconcileIdleNativeTuiDaemonProjection({
    isProcessing: () => processing,
    lastSignature: "seed",
    loadSnapshot: async () => {
      processing = true;
      return projectionView({ updatedAt: "2026-08-17T00:00:01.000Z" });
    },
    applySnapshot: () => {
      applied += 1;
    },
    refreshWidget: async () => {
      widgets += 1;
    },
  });
  assert.equal(signature, "seed");
  assert.equal(applied, 0);
  assert.equal(widgets, 0);
});

test("idle TUI reconcile applies a changed snapshot and refreshes the widget", async () => {
  const snapshot = projectionView({
    updatedAt: "2026-08-17T00:00:01.000Z",
    pendingTurns: [
      {
        invocationId: "inv_tick",
        prompt: "continue",
        status: "queued",
        createdAt: "2026-08-17T00:00:01.000Z",
      },
    ],
  });
  const applied: SparkSessionView[] = [];
  let widgets = 0;
  const signature = await reconcileIdleNativeTuiDaemonProjection({
    isProcessing: () => false,
    lastSignature: nativeTuiDaemonProjectionSignature(projectionView()),
    loadSnapshot: async () => snapshot,
    applySnapshot: (next) => {
      applied.push(next);
    },
    refreshWidget: async () => {
      widgets += 1;
    },
  });
  assert.deepEqual(applied, [snapshot]);
  assert.equal(widgets, 1);
  assert.equal(signature, nativeTuiDaemonProjectionSignature(snapshot));
});

test("idle TUI reconcile refreshes the widget without reapplying an unchanged snapshot", async () => {
  const snapshot = projectionView({ updatedAt: "2026-08-17T00:00:00.000Z" });
  let applied = 0;
  let widgets = 0;
  const signature = await reconcileIdleNativeTuiDaemonProjection({
    isProcessing: () => false,
    lastSignature: nativeTuiDaemonProjectionSignature(snapshot),
    loadSnapshot: async () => snapshot,
    applySnapshot: () => {
      applied += 1;
    },
    refreshWidget: async () => {
      widgets += 1;
    },
  });
  assert.equal(applied, 0);
  assert.equal(widgets, 1);
  assert.equal(signature, nativeTuiDaemonProjectionSignature(snapshot));
});

test("idle TUI reconcile refreshes the widget when the daemon snapshot is unavailable", async () => {
  let applied = 0;
  let widgets = 0;
  const signature = await reconcileIdleNativeTuiDaemonProjection({
    isProcessing: () => false,
    lastSignature: "seed",
    loadSnapshot: async () => undefined,
    applySnapshot: () => {
      applied += 1;
    },
    refreshWidget: async () => {
      widgets += 1;
    },
  });
  assert.equal(signature, "seed");
  assert.equal(applied, 0);
  assert.equal(widgets, 1);
});

test("idle TUI reconcile loop applies a later snapshot then stops on abort", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const snapshots = [
    projectionView({ updatedAt: "2026-08-17T00:00:00.000Z" }),
    projectionView({
      updatedAt: "2026-08-17T00:00:01.000Z",
      pendingTurns: [
        {
          invocationId: "inv_later",
          prompt: "daemon tick",
          status: "running",
          createdAt: "2026-08-17T00:00:01.000Z",
        },
      ],
    }),
  ];
  let loads = 0;
  let applied = 0;
  try {
    startIdleNativeTuiDaemonProjectionReconcile({
      signal: controller.signal,
      lastSignature: nativeTuiDaemonProjectionSignature(snapshots[0]!),
      isProcessing: () => false,
      loadSnapshot: async () => snapshots[Math.min(loads++, snapshots.length - 1)]!,
      applySnapshot: () => {
        applied += 1;
      },
      refreshWidget: async () => undefined,
      intervalMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);
    await drainMicrotasks();
    assert.equal(applied, 0);
    await vi.advanceTimersByTimeAsync(250);
    await drainMicrotasks();
    assert.equal(applied, 1);
    controller.abort();
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});
