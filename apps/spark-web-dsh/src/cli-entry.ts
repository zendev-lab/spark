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
  spark-web-dsh [--host <host>] [--port <port>] [args...]

The DSH profile must already exist. Spark's access proxy owns every listener;
the DSH server itself stays on a private loopback port. Requests from an actual
loopback peer are tokenless. Local interface IPs are trusted automatically and
remote peers enter the Spark Access page backed by daemon-user tokens
(spark daemon access create). The server prints its URL without opening a browser.
`);
    return 0;
  }
  if (argv.some((arg) => arg === "--trusted-host" || arg.startsWith("--trusted-host="))) {
    process.stderr.write(
      "spark web-dsh: --trusted-host has been removed; local interface addresses are trusted automatically\n",
    );
    return 2;
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
