import { formatSparkCliError, sparkCliExitCode } from "@zendev-lab/spark-i18n/cli";

import { runSparkHubAppCli } from "./cli.ts";

runSparkHubAppCli()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      formatSparkCliError(error, {
        code: "HUB_COMMAND_FAILED",
        title: "Spark Hub command failed",
        hints: ['Run "spark hub --help" to inspect the supported commands.'],
      }),
    );
    process.exitCode = sparkCliExitCode(error);
  });
