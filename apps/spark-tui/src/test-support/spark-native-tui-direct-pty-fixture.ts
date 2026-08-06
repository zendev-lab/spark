import { appendFileSync } from "node:fs";

import { runNativeSparkTui } from "../native-tui/run.ts";

const reportPath = requiredEnvironmentVariable("SPARK_TUI_DIRECT_PTY_REPORT");

if (process.env.SPARK_TUI_DIRECT_PTY_IGNORE_SIGHUP === "1") {
  process.on("SIGHUP", () => report("hangup-ignored"));
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function report(event: string, details: Record<string, unknown> = {}): void {
  appendFileSync(
    reportPath,
    `${JSON.stringify({
      event,
      stdinIsTTY: process.stdin.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
      isRaw: process.stdin.isRaw === true,
      columns: process.stdout.columns,
      rows: process.stdout.rows,
      ...details,
    })}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  let rawModeProbe: ReturnType<typeof setInterval> | undefined;
  const recordResize = () => report("resize");
  process.stdout.on("resize", recordResize);
  report("boot");

  try {
    await runNativeSparkTui({
      responder: (input) => `direct response: ${input}`,
      configureApp(_app, session) {
        session.addSystemMessage("direct PTY ready");
        rawModeProbe = setInterval(() => {
          if (!process.stdin.isRaw) return;
          clearInterval(rawModeProbe);
          rawModeProbe = undefined;
          report("ready");
        }, 5);
      },
    });
    report("stopped");
  } finally {
    if (rawModeProbe) clearInterval(rawModeProbe);
    process.stdout.off("resize", recordResize);
    report("final");
  }
}

main().catch((error: unknown) => {
  report("error", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
