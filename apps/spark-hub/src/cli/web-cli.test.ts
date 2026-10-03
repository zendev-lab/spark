import assert from "node:assert/strict";
import { test } from "vitest";

import { formatSparkCliError, SparkCliError } from "@zendev-lab/spark-i18n/cli";

import { runHubWebCli } from "./web-cli.ts";

test("Hub web CLI rejects unknown commands with the shared error surface", async () => {
  await assert.rejects(
    () => runHubWebCli(["not-a-command"]),
    (error: unknown) => {
      if (!(error instanceof SparkCliError)) return false;
      assert.equal(error.code, "UNKNOWN_COMMAND");
      assert.equal(error.exitCode, 2);
      assert.match(formatSparkCliError(error), /spark hub web --help/u);
      return true;
    },
  );
});

test("Hub web CLI separates invalid option detail from its recovery hint", async () => {
  await assert.rejects(
    () => runHubWebCli(["logs", "--lines", "many"]),
    (error: unknown) => {
      if (!(error instanceof SparkCliError)) return false;
      const rendered = formatSparkCliError(error);
      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(rendered, /Invalid --lines value/u);
      assert.match(rendered, /spark hub web --help/u);
      return true;
    },
  );
});
