import { describe, expect, it } from "vitest";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";
import { SparkDaemonControlError } from "./control-error.ts";

import { runtimeCommandFailure } from "./runtime-command-error.ts";

describe("runtime command failure projection", () => {
  it("preserves typed Side Thread errors for remote projections", () => {
    expect(
      runtimeCommandFailure(
        new SparkSessionRegistryError("side_thread_not_found", "no active child"),
      ),
    ).toEqual({ reasonCode: "side_thread_not_found", message: "no active child" });
  });

  it("does not expose non-Side Thread session error codes", () => {
    expect(
      runtimeCommandFailure(new SparkSessionRegistryError("session_not_found", "missing")),
    ).toEqual({
      reasonCode: "COMMAND_EXECUTION_FAILED",
      message: "missing",
    });
  });

  it("preserves trusted Workbench stale and provenance failures over runtime control", () => {
    expect(
      runtimeCommandFailure(
        new SparkDaemonControlError("workbench_action_stale", "refresh the Workbench"),
      ),
    ).toEqual({
      reasonCode: "workbench_action_stale",
      message: "refresh the Workbench",
    });
  });
});
