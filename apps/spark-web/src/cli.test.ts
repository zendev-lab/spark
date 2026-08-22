import assert from "node:assert/strict";
import { test } from "vitest";

import { SparkDaemonStartupError } from "@zendev-lab/spark-daemon-client";
import { formatSparkCliError, SparkCliError } from "@zendev-lab/spark-i18n/cli";

import { runSparkWebCli, sparkWebHelpText } from "./cli.ts";

test("spark web help documents opt-in HMR", () => {
  assert.match(sparkWebHelpText(), /\[--hmr\]/);
  assert.match(sparkWebHelpText(), /Vite development server/);
});

test("spark web reports invalid options with the shared usage-error surface", async () => {
  await assert.rejects(
    () => runSparkWebCli(["--port", "not-a-port"]),
    (error: unknown) =>
      error instanceof SparkCliError &&
      error.code === "INVALID_ARGUMENT" &&
      error.exitCode === 2 &&
      formatSparkCliError(error).includes('hint: Run "spark web --help"'),
  );
});

test("spark web preserves the daemon startup root cause and actionable recovery", async () => {
  const startup = new SparkDaemonStartupError({
    diagnostic: "no such column: serialization_key",
    connectionDetail: "connect ENOENT /tmp/daemon.sock",
    serviceLogPath: "/tmp/service.stderr.log",
  });

  await assert.rejects(
    () =>
      runSparkWebCli(["--port", "3999"], {
        ensureDaemonRunning: async () => {
          throw startup;
        },
      }),
    (error: unknown) => {
      if (!(error instanceof SparkCliError)) return false;
      const rendered = formatSparkCliError(error);
      assert.equal(error.code, "DAEMON_START_FAILED");
      assert.match(rendered, /Spark daemon failed to start/u);
      assert.match(rendered, /spark doctor/u);
      assert.match(rendered, /spark daemon logs --lines 100/u);
      assert.match(rendered, /no such column: serialization_key/u);
      assert.doesNotMatch(rendered, /connect ENOENT/u);
      return true;
    },
  );
});
