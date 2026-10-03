import { formatSparkCliError, sparkCliExitCode } from "@zendev-lab/spark-i18n/cli";

import { runHubWebCli } from "./web-cli.ts";

async function main(argv = process.argv.slice(2)): Promise<number> {
  return await runHubWebCli(argv);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      formatSparkCliError(error, {
        code: "HUB_WEB_COMMAND_FAILED",
        title: "Spark Hub web command failed",
        hints: ['Run "spark hub web --help" to inspect the supported commands.'],
      }),
    );
    process.exitCode = sparkCliExitCode(error);
  },
);
