import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveSparkUpdatePaths } from "@zendev-lab/spark-deployment";
import { readHubUpdateProjection } from "./update-projection.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Hub reads a bounded updater projection without installation paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-hub-update-"));
  roots.push(root);
  const env = { SPARK_HOME: root, HOME: root };
  const paths = resolveSparkUpdatePaths({ env });
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(
    paths.stateFile,
    `${JSON.stringify({
      schemaVersion: 2,
      generation: "native",
      currentVersion: "0.1.0",
      availableVersion: "0.1.1",
      pendingVersion: "0.1.1",
      quarantined: [
        {
          version: "0.1.2",
          reason: "candidate health failed",
          quarantinedAt: "2026-07-24T00:00:00.000Z",
        },
      ],
    })}\n`,
  );

  await expect(readHubUpdateProjection({ env })).resolves.toMatchObject({
    managed: false,
    installation: "source",
    automaticUpdates: false,
    checkIntervalHours: 24,
    policy: "notify",
    channel: "latest",
    current: "0.1.0",
    available: "0.1.1",
    pending: "0.1.1",
    quarantined: [{ version: "0.1.2" }],
  });
});
