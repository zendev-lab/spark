import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseSparkWebArgs, runSparkWeb } from "./web.ts";

function isDirectRun(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return false;
  }
}

export async function runSparkWebCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`spark-web-dsh - Spark product workbench hosted by DeepSeek Harness

Usage:
  spark-web-dsh [--host <host>] [--port <port>] [--trusted-host <host>] [args...]

The DSH profile must already exist. Explicit non-loopback binds expose the
Harness agent surface to that network and should be used only on trusted hosts.
The server prints its URL without opening a browser.
`);
    return 0;
  }
  try {
    return await runSparkWeb(parseSparkWebArgs(argv));
  } catch (error) {
    process.stderr.write(
      `spark web-dsh: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runSparkWebCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}
