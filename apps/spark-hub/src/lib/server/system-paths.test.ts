import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultArtifactCacheRoot } from "@zendev-lab/spark-hub-coordination/artifact-cache";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Hub system paths", () => {
  it("uses the default XDG cache root for artifact previews", () => {
    process.env = { HOME: "/Users/example" };

    expect(defaultArtifactCacheRoot()).toBe(
      join("/Users/example", ".cache", "spark", "hub", "artifacts"),
    );
  });

  it("relocates artifact previews with SPARK_HOME", () => {
    process.env = { HOME: "/Users/example", SPARK_HOME: "/Users/example/spark-home" };

    expect(defaultArtifactCacheRoot()).toBe(
      join("/Users/example/spark-home", "apps", "hub", "cache", "artifacts"),
    );
  });
});
