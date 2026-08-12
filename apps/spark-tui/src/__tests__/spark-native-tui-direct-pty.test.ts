import assert from "node:assert/strict";
import { test } from "vitest";

import { createSparkNativeTuiDirectPtyHarness } from "../test-support/spark-native-tui-direct-pty-harness.ts";

const CTRL_D = "\x04";
const ESC = String.fromCodePoint(27);
const BEL = String.fromCodePoint(7);
const ANSI_CONTROL_PATTERN = new RegExp(
  `${ESC}(?:\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|\\[[0-?]*[ -/]*[@-~])`,
  "gu",
);

function visiblePtyOutput(output: string): string {
  return output.replace(ANSI_CONTROL_PATTERN, "").replaceAll("\r", "");
}

test("direct PTY drives stdin/stdout, raw mode, rendering, and clean exit", async () => {
  const harness = await createSparkNativeTuiDirectPtyHarness({ columns: 72, rows: 18 });
  try {
    const ready = await harness.waitForReport((report) => report.event === "ready");
    assert.deepEqual(
      {
        stdinIsTTY: ready.stdinIsTTY,
        stdoutIsTTY: ready.stdoutIsTTY,
        isRaw: ready.isRaw,
        columns: ready.columns,
        rows: ready.rows,
      },
      {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        isRaw: true,
        columns: 72,
        rows: 18,
      },
    );
    await harness.waitForOutput("direct PTY ready");
    await harness.waitForOutput(/direct PTY ready/gu);
    await harness.waitForOutput(/direct PTY ready/gu);

    harness.write("direct input\r");
    const output = await harness.waitForOutput("direct response: direct input");
    const visible = visiblePtyOutput(output);
    assert.match(visible, /> direct input/u);
    assert.match(visible, /direct response: direct input/u);
    assert.doesNotMatch(visible, /(?:^|\n)spark> /u);

    harness.write(CTRL_D);
    assert.equal((await harness.waitForExit()).exitCode, 0);
    const final = await harness.waitForReport((report) => report.event === "final");
    assert.equal(final.isRaw, false);
    assert.equal(final.stdinIsTTY, true);
  } finally {
    await harness.dispose();
  }
});

test("direct PTY resize reaches ProcessTerminal and rerenders at the new width", async () => {
  const harness = await createSparkNativeTuiDirectPtyHarness({ columns: 90, rows: 30 });
  try {
    await harness.waitForReport((report) => report.event === "ready");
    await harness.waitForOutput("direct PTY ready");
    const outputBeforeResize = harness.output().length;

    harness.resize(57, 16);
    const resized = await harness.waitForReport(
      (report) => report.event === "resize" && report.columns === 57 && report.rows === 16,
    );
    assert.equal(resized.isRaw, true);
    const resizedOutput = await harness.waitForOutputAfter(
      outputBeforeResize,
      `${ESC}[2J${ESC}[H${ESC}[3J`,
    );
    assert.match(visiblePtyOutput(resizedOutput), /direct PTY ready/u);

    harness.write(CTRL_D);
    assert.equal((await harness.waitForExit()).exitCode, 0);
  } finally {
    await harness.dispose();
  }
});

test("direct PTY scrolls transcript history and opens sessions on batched double escape", async () => {
  const harness = await createSparkNativeTuiDirectPtyHarness({
    columns: 72,
    rows: 12,
    scenario: "navigation",
  });
  try {
    await harness.waitForReport((report) => report.event === "ready");
    await harness.waitForOutput("navigation-history-29");

    let outputOffset = harness.output().length;
    harness.write(`${ESC}[5~`);
    const scrolled = await harness.waitForOutputAfter(
      outputOffset,
      /history ↑ \d+ newer lines below/gu,
    );
    assert.doesNotMatch(visiblePtyOutput(scrolled), /navigation-history-29/u);

    outputOffset = harness.output().length;
    harness.write(`${ESC}[6~`);
    await harness.waitForOutputAfter(outputOffset, "navigation-history-29");

    harness.write(`${ESC}${ESC}`);
    await harness.waitForReport((report) => report.event === "sessions-opened");
    assert.equal((await harness.waitForExit()).exitCode, 0);
  } finally {
    await harness.dispose();
  }
});

test("direct PTY restores queued input from the macOS legacy Alt+Up byte stream", async () => {
  const harness = await createSparkNativeTuiDirectPtyHarness({
    columns: 72,
    rows: 18,
    scenario: "queue",
  });
  try {
    await harness.waitForReport((report) => report.event === "ready");
    await harness.waitForOutput("direct PTY ready");

    harness.write("hold\r");
    await harness.waitForOutput("> hold");
    harness.write("queued from PTY");
    harness.write(`${ESC}\r`);
    await harness.waitForOutput(/Input queue · local 1/gu);

    const outputOffset = harness.output().length;
    harness.write(`${ESC}${ESC}[A`);
    const restored = await harness.waitForOutputAfter(
      outputOffset,
      "Restored queued input to the editor.",
    );
    assert.match(visiblePtyOutput(restored), /queued from PTY/u);

    harness.write(CTRL_D);
    assert.equal((await harness.waitForExit()).exitCode, 0);
  } finally {
    await harness.dispose();
  }
});

test("direct PTY dispose surfaces a termination timeout after confirming forced exit", async () => {
  const harness = await createSparkNativeTuiDirectPtyHarness({
    columns: 60,
    rows: 16,
    ignoreHangup: true,
    terminationTimeoutMs: 100,
  });
  let disposed = false;
  try {
    await harness.waitForReport((report) => report.event === "ready");

    await assert.rejects(harness.dispose(), /Timed out terminating direct PTY fixture/u);
    disposed = true;
    await assert.rejects(harness.dispose(), /Timed out terminating direct PTY fixture/u);
    assert.equal(isProcessAlive(harness.pid), false);
  } finally {
    if (!disposed) await harness.dispose().catch(() => undefined);
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
