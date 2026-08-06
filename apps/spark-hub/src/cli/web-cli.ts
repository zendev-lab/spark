import {
  formatHubWebStatus,
  getHubWebStatus,
  readHubWebLogs,
  runHubWebService,
  startHubWebService,
  stopHubWebService,
} from "./web-service.ts";
import { helpFlagRequested } from "./shared.ts";

/** Handle `spark hub web …` after the surface dispatcher peels off `web`. */
export async function runHubWebCli(argv: string[]): Promise<number> {
  if (helpFlagRequested(argv)) {
    process.stdout.write(hubWebHelpText());
    return 0;
  }

  const [command = "status"] = argv;
  const json = argv.includes("--json");
  switch (command) {
    case "run":
      await runHubWebService();
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    case "start": {
      const result = await startHubWebService();
      process.stdout.write(`${formatHubWebStatus(result.status, json)}\n`);
      return 0;
    }
    case "status":
      process.stdout.write(`${formatHubWebStatus(getHubWebStatus(), json)}\n`);
      return 0;
    case "stop": {
      const result = await stopHubWebService();
      process.stdout.write(`${formatHubWebStatus(result.status, json)}\n`);
      return 0;
    }
    case "logs": {
      const linesIndex = argv.findIndex((arg) => arg === "--lines" || arg === "-n");
      const lines = linesIndex < 0 ? 100 : Number(argv[linesIndex + 1]);
      const result = readHubWebLogs(process.env, lines);
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else if (result.text) process.stdout.write(result.text);
      else process.stdout.write(`no logs yet: ${result.logFile}\n`);
      return 0;
    }
    default:
      throw new Error(`Unknown spark hub web command: ${command}`);
  }
}

function hubWebHelpText(): string {
  return `spark hub web - manage the background Hub Web service

Usage:
  spark hub web start [--json]
  spark hub web status [--json]
  spark hub web stop [--json]
  spark hub web logs [--lines <n>] [--json]
  spark hub web --help
`;
}
