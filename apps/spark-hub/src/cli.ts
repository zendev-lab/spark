import { object, or } from "@optique/core/constructs";
import { withDefault } from "@optique/core/modifiers";
import { parse } from "@optique/core/parser";
import { command, constant, flag, passThrough } from "@optique/core/primitives";

import { sparkHubHelpText } from "./cli/coordination.ts";
import { runSparkHubCli as runHubCoordinationCli } from "./cli/hub.ts";
import { startHubProductionHost } from "./cli/production-start.ts";
import { runHubWebCli } from "./cli/web-cli.ts";

const remainingArgv = () => passThrough({ format: "greedy" });

const sparkHubAppParser = or(
  command("help", object({ kind: constant("help" as const), argv: remainingArgv() })),
  command("--help", object({ kind: constant("help" as const), argv: remainingArgv() })),
  command("-h", object({ kind: constant("help" as const), argv: remainingArgv() })),
  command(
    "start",
    object({
      kind: constant("start" as const),
      help: withDefault(flag("-h", "--help"), false),
      argv: remainingArgv(),
    }),
  ),
  command("web", object({ kind: constant("web" as const), argv: remainingArgv() })),
);

/** Canonical process entry for `spark-hub`. */
export async function runSparkHubAppCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0) return await startHubProductionHost();

  const classified = classifySparkHubAppCommand(argv);
  switch (classified.kind) {
    case "help":
      process.stdout.write(sparkHubAppHelpText());
      return 0;
    case "start": {
      if (classified.help) {
        process.stdout.write(sparkHubAppHelpText());
        return 0;
      }
      return await startHubProductionHost([...classified.argv]);
    }
    case "web":
      return await runHubWebCli([...classified.argv]);
    case "coordination":
      return await runHubCoordinationCli(classified.argv);
    default: {
      const exhaustive: never = classified;
      return exhaustive;
    }
  }
}

function classifySparkHubAppCommand(argv: string[]) {
  const result = parse(sparkHubAppParser, argv);
  if (result.success) return { ...result.value, argv: [...result.value.argv] };
  return { kind: "coordination" as const, argv };
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
