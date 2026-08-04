import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SparkVersionedDataError } from "@zendev-lab/spark-protocol/versioned-data";

import { emptySparkUpdateState, readSparkUpdateState, writeSparkUpdateState } from "./state.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStatePath(): Promise<{ directory: string; stateFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), "spark-update-state-diagnostics-"));
  temporaryDirectories.push(directory);
  const stateFile = join(directory, "state.json");
  return { directory, stateFile };
}

async function captureVersionedError(
  operation: Promise<unknown>,
): Promise<SparkVersionedDataError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(SparkVersionedDataError);
    if (error instanceof SparkVersionedDataError) return error;
  }
  throw new Error("expected SparkVersionedDataError");
}

describe("Spark updater state diagnostics", () => {
  it("defaults only when the state file is absent", async () => {
    const { stateFile } = await createStatePath();

    await expect(readSparkUpdateState({ stateFile })).resolves.toEqual(emptySparkUpdateState());
  });

  it("reports malformed JSON with the exact file and recovery action", async () => {
    const { stateFile } = await createStatePath();
    await writeFile(stateFile, '{"schemaVersion":', "utf8");

    const error = await captureVersionedError(readSparkUpdateState({ stateFile }));
    expect(error.diagnostic).toMatchObject({
      code: "invalid_json",
      source: stateFile,
      dataKind: "Spark updater state",
      supportedVersions: [1],
    });
    expect(error.message).toContain("not valid JSON");
    expect(error.message).toContain("move the file aside");
  });

  it("reports received and supported state versions", async () => {
    const { stateFile } = await createStatePath();
    await writeFile(
      stateFile,
      `${JSON.stringify({ schemaVersion: 2, quarantined: [] })}\n`,
      "utf8",
    );

    const error = await captureVersionedError(readSparkUpdateState({ stateFile }));
    expect(error.diagnostic).toEqual({
      code: "version_mismatch",
      source: stateFile,
      dataKind: "Spark updater state",
      versionField: "schemaVersion",
      supportedVersions: [1],
      receivedVersion: "2",
      message: `Spark updater state version mismatch at ${stateFile}: schemaVersion must be 1; received 2.`,
      action:
        "Upgrade Spark to a build that supports this state, or move the file aside to reset updater history.",
    });
  });

  it("reports exact invalid field paths after version validation", async () => {
    const { stateFile } = await createStatePath();
    await writeFile(
      stateFile,
      `${JSON.stringify({
        schemaVersion: 1,
        currentVersion: 123,
        quarantined: [{ version: "0.2.0", quarantinedAt: "now" }],
        failure: {
          code: "network",
          message: "offline",
          count: 0,
          firstAt: "now",
          lastAt: "now",
          nextRetryAt: "later",
        },
      })}\n`,
      "utf8",
    );

    const error = await captureVersionedError(readSparkUpdateState({ stateFile }));
    expect(error.diagnostic).toMatchObject({
      code: "invalid_schema",
      receivedVersion: "1",
      issues: expect.arrayContaining([
        { path: "$.currentVersion", message: "expected a string when present" },
        { path: "$.quarantined[0].reason", message: "expected a string" },
        { path: "$.failure.count", message: "expected a positive integer" },
      ]),
    });
    expect(error.message).toContain("$.quarantined[0].reason");
    expect(error.message).toContain("Action:");
  });

  it("rejects invalid writes with a producer-directed action", async () => {
    const { directory, stateFile } = await createStatePath();
    await mkdir(directory, { recursive: true });

    const error = await captureVersionedError(
      writeSparkUpdateState({ stateFile }, { schemaVersion: 1, quarantined: "invalid" } as never),
    );
    expect(error.diagnostic).toMatchObject({
      code: "invalid_schema",
      source: stateFile,
      issues: [{ path: "$.quarantined", message: "expected an array" }],
    });
    expect(error.diagnostic.action).toContain("Fix the updater state producer");
  });
});
