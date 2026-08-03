import {
  runSparkCockpitCliCommand,
  parseSparkCockpitCliArgs,
  sparkCockpitHelpText,
  type SparkCockpitCliOptions,
} from "./cli/coordination.ts";
import { startCockpitProductionHost } from "./cli/production-start.ts";
import { helpFlagRequested } from "./cli/shared.ts";
import { runCockpitWebCli } from "./cli/web-cli.ts";
import { runSparkHubCli } from "./cli/hub.ts";

/**
 * Single surface entry for `spark cockpit`.
 * Shell bin only launches this file; command tables live here / in submodules.
 */
export async function runSparkCockpitCli(
  argv: string[] = process.argv.slice(2),
  options: SparkCockpitCliOptions = {},
): Promise<number> {
  if (argv.length === 0) {
    return await startCockpitProductionHost();
  }

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
      process.stderr.write(
        'Deprecated: use "spark cockpit web start" for Cockpit Web lifecycle.\n',
      );
      return await startCockpitProductionHost(rest);
    case "web":
      return await runCockpitWebCli(rest);
    case "hub":
      return await runSparkHubCli(rest);
    default:
      process.stderr.write(
        `Deprecated: coordination commands moved to "spark hub". Use "spark hub ${argv.join(" ")}".\n`,
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
