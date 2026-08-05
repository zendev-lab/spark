import { describe, expect, it } from "vitest";

import { isSparkBuildInfo } from "./build-info.ts";

const baseBuildInfo = {
  schemaVersion: 1 as const,
  version: "0.2.1",
  gitSha: "abc123",
  protocolVersion: 1,
  minimumNodeVersion: ">=26 <27",
  migrationHead: "001.sql",
  migrationMode: "manual" as const,
  fingerprint: "sha256:test",
};

describe("Spark distribution build info", () => {
  it.each(["@zendev-lab/spark", "@zendev-lab/spark-hub"] as const)(
    "accepts the %s distribution identity",
    (packageName) => {
      expect(isSparkBuildInfo({ ...baseBuildInfo, packageName })).toBe(true);
    },
  );

  it("rejects unknown distribution identities", () => {
    expect(isSparkBuildInfo({ ...baseBuildInfo, packageName: "@zendev-lab/other" })).toBe(false);
  });
});
