import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { acquireSparkNativeTuiLease } from "../native-tui/tty-lease.ts";

test("Spark native TUI lease rejects a second live owner and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-tui-live-lease-"));
  try {
    const first = await acquireSparkNativeTuiLease({
      terminalKey: "dev-1",
      lockRoot: root,
      pid: 101,
      isProcessAlive: (pid) => pid === 101,
    });
    assert.ok(first);
    await assert.rejects(
      acquireSparkNativeTuiLease({
        terminalKey: "dev-1",
        lockRoot: root,
        pid: 202,
        isProcessAlive: (pid) => pid === 101,
      }),
      /already attached to this terminal \(pid 101\)/u,
    );

    await first.release();
    const second = await acquireSparkNativeTuiLease({
      terminalKey: "dev-1",
      lockRoot: root,
      pid: 202,
      isProcessAlive: () => true,
    });
    assert.ok(second);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Spark native TUI lease reclaims a stale owner without letting it release its successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-tui-stale-lease-"));
  try {
    const stale = await acquireSparkNativeTuiLease({
      terminalKey: "dev-2",
      lockRoot: root,
      pid: 303,
      isProcessAlive: () => true,
    });
    assert.ok(stale);
    const successor = await acquireSparkNativeTuiLease({
      terminalKey: "dev-2",
      lockRoot: root,
      pid: 404,
      isProcessAlive: () => false,
    });
    assert.ok(successor);

    await stale.release();
    await assert.rejects(
      acquireSparkNativeTuiLease({
        terminalKey: "dev-2",
        lockRoot: root,
        pid: 505,
        isProcessAlive: (pid) => pid === 404,
      }),
      /already attached to this terminal \(pid 404\)/u,
    );
    await successor.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
