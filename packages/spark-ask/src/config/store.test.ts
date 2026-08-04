import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AskConfigStoreFormatError, createAskConfigStore, getDefaultConfig } from "./store.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "spark-ask-config-diagnostics-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "ask.json");
  return { filePath, store: createAskConfigStore({ filePath }) };
}

function captureFormatError(operation: () => unknown): AskConfigStoreFormatError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AskConfigStoreFormatError);
    if (error instanceof AskConfigStoreFormatError) return error;
  }
  throw new Error("expected AskConfigStoreFormatError");
}

describe("Spark ask config diagnostics", () => {
  it("preserves legacy missing-version migration", () => {
    const { filePath, store } = createStore();
    writeFileSync(filePath, "{}\n", "utf8");

    expect(store.load()).toEqual(getDefaultConfig());
  });

  it("reports malformed JSON with file and recovery action", () => {
    const { filePath, store } = createStore();
    writeFileSync(filePath, '{"schemaVersion":', "utf8");

    const error = captureFormatError(() => store.load());
    expect(error.filePath).toBe(filePath);
    expect(error.diagnostic).toMatchObject({
      code: "invalid_json",
      source: filePath,
      dataKind: "Spark ask config",
      supportedVersions: [1],
    });
    expect(error.message).toContain("not valid JSON");
    expect(error.message).toContain("move the file aside");
  });

  it("reports the received and supported schema versions", () => {
    const { filePath, store } = createStore();
    writeFileSync(filePath, `${JSON.stringify({ schemaVersion: "1" })}\n`, "utf8");

    const error = captureFormatError(() => store.load());
    expect(error.diagnostic).toEqual({
      code: "version_mismatch",
      source: filePath,
      dataKind: "Spark ask config",
      versionField: "schemaVersion",
      supportedVersions: [1],
      receivedVersion: '"1"',
      message: `Spark ask config version mismatch at ${filePath}: schemaVersion must be 1; received "1".`,
      action:
        "Upgrade Spark to a build that supports this config, or move the file aside so Spark can regenerate defaults.",
    });
    expect(error.message).toContain("Action:");
  });

  it("rejects invalid in-memory writes before touching disk", () => {
    const { filePath, store } = createStore();
    const error = captureFormatError(() => store.save({ schemaVersion: 2 } as never));

    expect(error.diagnostic).toMatchObject({
      code: "version_mismatch",
      source: filePath,
      receivedVersion: "2",
      supportedVersions: [1],
    });
  });
});
