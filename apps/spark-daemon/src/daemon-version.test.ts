import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveSparkDaemonVersion } from "./daemon.ts";

describe("Spark daemon release identity", () => {
  it("derives the runtime version from build-info with the root manifest as source fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-daemon-version-"));
    try {
      const rootManifest = JSON.parse(
        await readFile(resolve(import.meta.dirname, "../../..", "package.json"), "utf8"),
      ) as { version: string };
      expect(resolveSparkDaemonVersion({ cwd: root, env: {} })).toBe(rootManifest.version);

      const buildInfoPath = join(root, "build-info.json");
      await writeFile(
        buildInfoPath,
        JSON.stringify({
          schemaVersion: 1,
          packageName: "@zendev-lab/spark",
          version: "9.8.7",
          gitSha: "test-sha",
          protocolVersion: 1,
          minimumNodeVersion: ">=24.0.0",
          migrationHead: "test",
          migrationMode: "expand-only",
          fingerprint: "sha256:test",
        }),
      );
      expect(
        resolveSparkDaemonVersion({
          cwd: root,
          env: { SPARK_BUILD_INFO_PATH: buildInfoPath },
        }),
      ).toBe("9.8.7");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
