import { appendFileSync } from "node:fs";

import { runNativeSparkTui } from "../native-tui/run.ts";
import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";
import { sparkNativeReproSessionView } from "./spark-native-repro-view-fixture.ts";

const reportPath = requiredEnvironmentVariable("SPARK_TUI_DIRECT_PTY_REPORT");
const scenario = process.env.SPARK_TUI_DIRECT_PTY_SCENARIO;

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
    const reason = await runNativeSparkTui({
      responder: (input) =>
        scenario === "queue" && input === "hold"
          ? new Promise<string>(() => undefined)
          : `direct response: ${input}`,
      slashCommands:
        scenario === "navigation"
          ? {
              sessions: {
                description: "Open sessions",
                handler: (_args, context) => {
                  report("sessions-opened");
                  context.exit();
                },
              },
            }
          : undefined,
      configureApp(app, session) {
        session.addSystemMessage("direct PTY ready");
        if (scenario === "repro") {
          app.applyViewModelEvent({
            version: SPARK_PROTOCOL_VERSION,
            type: "session.snapshot",
            session: sparkNativeReproSessionView({ includeMessages: true }),
          });
        }
        if (scenario === "navigation") {
          for (let index = 0; index < 30; index += 1) {
            session.addSystemMessage(`navigation-history-${index}`);
          }
        }
        rawModeProbe = setInterval(() => {
          if (!process.stdin.isRaw) return;
          clearInterval(rawModeProbe);
          rawModeProbe = undefined;
          report("ready");
        }, 5);
      },
    });
    report("stopped", { reason });
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
