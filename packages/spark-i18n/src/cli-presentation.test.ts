import { describe, expect, it } from "vitest";

import { formatSparkCliError, SparkCliError, sparkCliExitCode } from "./cli-presentation.ts";

describe("Spark CLI error presentation", () => {
  it("renders a stable outcome, recovery hints, and separate technical detail", () => {
    const error = new SparkCliError({
      code: "DAEMON_START_FAILED",
      title: "Spark daemon failed to start",
      description: "The service did not become ready for the local web workbench.",
      hints: ['Run "spark doctor" to check the daemon state.', 'Run "spark daemon logs".'],
      detail: "no such column: serialization_key",
    });

    expect(formatSparkCliError(error)).toBe(
      "error [DAEMON_START_FAILED]: Spark daemon failed to start\n" +
        "  The service did not become ready for the local web workbench.\n" +
        'hint: Run "spark doctor" to check the daemon state.\n' +
        'hint: Run "spark daemon logs".\n' +
        "details: no such column: serialization_key\n",
    );
  });

  it("keeps unexpected errors concise and supports localized labels", () => {
    expect(
      formatSparkCliError(
        new Error("connect ENOENT /tmp/daemon.sock"),
        { code: "DAEMON_UNAVAILABLE", title: "Spark daemon is unavailable" },
        "zh",
      ),
    ).toBe(
      "错误 [DAEMON_UNAVAILABLE]: Spark daemon is unavailable\n" +
        "详情: connect ENOENT /tmp/daemon.sock\n",
    );
  });

  it("carries the intended process exit code", () => {
    expect(
      sparkCliExitCode(
        new SparkCliError({ code: "INVALID_ARGUMENT", title: "Invalid option", exitCode: 2 }),
      ),
    ).toBe(2);
    expect(sparkCliExitCode(new Error("boom"))).toBe(1);
  });
});
