import {
  parseSparkCockpitCliArgs,
  runSparkCockpitCliCommand,
  sparkCockpitHelpText,
  type SparkCockpitCliOptions,
} from "./cli/coordination.ts";
import { runSparkHubCli } from "./cli/hub.ts";
import { startCockpitProductionHost } from "./cli/production-start.ts";
import { helpFlagRequested } from "./cli/shared.ts";
import { runCockpitWebCli } from "./cli/web-cli.ts";

const LEGACY_COCKPIT_ENV = "SPARK_LEGACY_COCKPIT";

/** Canonical process entry for `spark-hub`. */
export async function runSparkHubAppCli(
  argv: string[] = process.argv.slice(2),
  options: SparkCockpitCliOptions = {},
): Promise<number> {
  if (process.env[LEGACY_COCKPIT_ENV] === "1") {
    return await runLegacySparkCockpitCli(argv, options);
  }

  if (argv.length === 0) return await startCockpitProductionHost();

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
      return await startCockpitProductionHost(rest);
    case "web":
      return await runCockpitWebCli(rest);
    default:
      return await runSparkHubCli(argv);
  }
}

/** Source-only compatibility surface for the retired `spark-cockpit` wrapper. */
export async function runSparkCockpitCli(
  argv: string[] = process.argv.slice(2),
  options: SparkCockpitCliOptions = {},
): Promise<number> {
  return await runLegacySparkCockpitCli(argv, options);
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

async function runLegacySparkCockpitCli(
  argv: string[],
  options: SparkCockpitCliOptions,
): Promise<number> {
  if (argv.length === 0) return await startCockpitProductionHost();

  const [first, ...rest] = argv;
  switch (first) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(sparkCockpitHelpText());
      return 0;
    case "start":
      if (helpFlagRequested(rest)) {
        process.stdout.write(sparkCockpitHelpText());
        return 0;
      }
      process.stderr.write('Deprecated: use "spark-hub web start" for the Hub Web lifecycle.\n');
      return await startCockpitProductionHost(rest);
    case "web":
      return await runCockpitWebCli(rest);
    case "hub":
      return await runSparkHubCli(rest);
    default:
      process.stderr.write(
        `Deprecated: coordination commands moved to "spark-hub". Use "spark-hub ${argv.join(" ")}".\n`,
      );
      return await runSparkCockpitCliCommand(parseSparkCockpitCliArgs(argv), undefined, options);
  }
}

export { parseSparkCockpitCliArgs, sparkCockpitHelpText } from "./cli/coordination.ts";
export type {
  SparkCockpitCliCommand,
  SparkCockpitCliOptions,
  SparkCockpitCliResult,
} from "./cli/coordination.ts";
