import { sparkHubHelpText } from "./cli/coordination.ts";
import { runSparkHubCli as runHubCoordinationCli } from "./cli/hub.ts";
import { startHubProductionHost } from "./cli/production-start.ts";
import { helpFlagRequested } from "./cli/shared.ts";
import { runHubWebCli } from "./cli/web-cli.ts";

/** Canonical process entry for `spark-hub`. */
export async function runSparkHubAppCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0) return await startHubProductionHost();

  const [first, ...rest] = argv;
  switch (first) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(sparkHubAppHelpText());
      return 0;
    case "start":
      if (helpFlagRequested(rest)) {
        process.stdout.write(sparkHubAppHelpText());
        return 0;
      }
      return await startHubProductionHost(rest);
    case "web":
      return await runHubWebCli(rest);
    default:
      return await runHubCoordinationCli(argv);
  }
}

export function sparkHubAppHelpText(): string {
  return `spark-hub - Spark control plane and embedded management UI

Usage:
  spark-hub
  spark-hub web <start|status|stop|logs> [args...]
  spark-hub status [--json]
  spark-hub workspace list [--json]
  spark-hub delegation <create|list|show|reply|cancel> [args...]
  spark-hub access <create|list|revoke> [args...]
  spark-hub instance <status|backup|restore> [args...]

The top-level "spark hub ..." dispatcher form forwards to this executable.
`;
}

export { sparkHubHelpText } from "./cli/coordination.ts";
