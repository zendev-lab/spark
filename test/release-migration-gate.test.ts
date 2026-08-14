import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import * as migrationGate from "../scripts/test-release-migration.mjs";

const {
  parseMigrationArguments,
  readCandidateArtifactIdentity,
  resolveReleaseMigrationExemption,
  resolvePublishedHubProbe,
  runMixedVersionHubMigrationMatrix,
  runMixedVersionIpcMatrix,
  selectPublishedBaselineVersion,
} = migrationGate;

test("0.4.0 alone carries the declared one-time N-1 migration exemption", () => {
  const sparkRelease = {
    nMinusOneMigrationExemptions: {
      "0.4.0": " coordinated view-model v2 hard cut ",
    },
  };

  assert.deepEqual(resolveReleaseMigrationExemption(sparkRelease, "0.4.0"), {
    candidateVersion: "0.4.0",
    reason: "coordinated view-model v2 hard cut",
  });
  assert.equal(resolveReleaseMigrationExemption(sparkRelease, "0.4.1"), undefined);
  assert.equal(resolveReleaseMigrationExemption({}, "0.4.0"), undefined);
  assert.throws(
    () => resolveReleaseMigrationExemption({ nMinusOneMigrationExemptions: [] }, "0.4.0"),
    /must be an object/u,
  );
  assert.throws(
    () =>
      resolveReleaseMigrationExemption({ nMinusOneMigrationExemptions: { "0.4.0": "" } }, "0.4.0"),
    /must have a reason/u,
  );
});

test("release migration arguments support automatic and explicit published baselines", () => {
  assert.deepEqual(parseMigrationArguments(["--tarball", "dist/release/spark-v0.1.1.tgz"]), {
    candidateTarball: "dist/release/spark-v0.1.1.tgz",
    baselineVersion: undefined,
  });
  assert.deepEqual(
    parseMigrationArguments([
      "--tarball",
      "dist/release/spark-v0.1.1.tgz",
      "--cli-tarball",
      "dist/release/spark-cli-v0.1.1.tgz",
      "--daemon-tarball",
      "dist/release/spark-daemon-v0.1.1.tgz",
      "--hub-tarball",
      "dist/release/spark-hub-v0.1.1.tgz",
      "--tui-tarball",
      "dist/release/spark-tui-v0.1.1.tgz",
      "--baseline-version",
      "0.1.0",
    ]),
    {
      candidateTarball: "dist/release/spark-v0.1.1.tgz",
      baselineVersion: "0.1.0",
      cliTarball: "dist/release/spark-cli-v0.1.1.tgz",
      daemonTarball: "dist/release/spark-daemon-v0.1.1.tgz",
      hubTarball: "dist/release/spark-hub-v0.1.1.tgz",
      tuiTarball: "dist/release/spark-tui-v0.1.1.tgz",
    },
  );
  assert.equal(selectPublishedBaselineVersion(["0.0.9", "0.1.0"], "0.1.1", "0.1.0"), "0.1.0");
  assert.equal(selectPublishedBaselineVersion(["0.0.9", "0.1.0", "0.1.1"], "0.1.1"), "0.1.0");
  assert.equal(
    selectPublishedBaselineVersion(["0.3.0", "0.2.1", "0.3.0-rc.1", "0.3.0", "invalid"], "0.3.1"),
    "0.3.0",
  );
  assert.throws(
    () => selectPublishedBaselineVersion(["0.1.0"], "0.1.0", "0.1.0"),
    /must be older than candidate/u,
  );
  assert.throws(
    () => selectPublishedBaselineVersion(["0.1.0", "0.1.1"], "0.1.0", "0.1.1"),
    /must be older than candidate/u,
  );
  assert.throws(
    () => selectPublishedBaselineVersion(["0.1.0"], "0.1.1", "0.0.9"),
    /not a published stable release/u,
  );
});

test("published Hub probe prefers the current command and falls back to the legacy command", async () => {
  const baselineRoot = "/fixture/published";
  const currentHub = join(baselineRoot, "node_modules", ".bin", "spark-hub");
  const legacyHub = join(baselineRoot, "node_modules", ".bin", "spark-cockpit");

  assert.deepEqual(
    await resolvePublishedHubProbe(baselineRoot, {
      exists: async (path: string) => path === currentHub || path === legacyHub,
    }),
    { command: currentHub, listArgs: ["delegation", "list"] },
  );
  assert.deepEqual(
    await resolvePublishedHubProbe(baselineRoot, {
      exists: async (path: string) => path === legacyHub,
    }),
    { command: legacyHub, listArgs: ["access", "list"] },
  );
  await assert.rejects(
    resolvePublishedHubProbe(baselineRoot, { exists: async () => false }),
    /neither spark-hub nor spark-cockpit/u,
  );
});

test("candidate artifact package and build-info identities must both match the release version", async () => {
  const entries = new Map([
    ["package/package.json", JSON.stringify({ name: "@zendev-lab/spark", version: "0.1.1" })],
    [
      "package/dist/build-info.json",
      JSON.stringify({ packageName: "@zendev-lab/spark", version: "0.1.1" }),
    ],
  ]);
  assert.deepEqual(
    await readCandidateArtifactIdentity("/fixture/spark-v0.1.1.tgz", "0.1.1", {
      readArchiveEntry: async (entry: string) => entries.get(entry),
    }),
    { packageName: "@zendev-lab/spark", version: "0.1.1" },
  );

  entries.set(
    "package/dist/build-info.json",
    JSON.stringify({ packageName: "@zendev-lab/spark", version: "0.1.0" }),
  );
  await assert.rejects(
    readCandidateArtifactIdentity("/fixture/spark-v0.1.1.tgz", "0.1.1", {
      readArchiveEntry: async (entry: string) => entries.get(entry),
    }),
    /build-info identity .*0\.1\.0.*0\.1\.1/u,
  );
});

test("mixed-version Hub gate uses the selected published command contract around candidate migration", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "spark-release-hub-migration-test-"));
  const baselineHub = "/fixture/published/spark-hub";
  const candidateHub = "/fixture/candidate/spark-hub";
  const observations: Array<{ command: string; args: string[]; sparkHome: string }> = [];

  try {
    const result = await runMixedVersionHubMigrationMatrix(
      {
        baselineHub,
        baselineHubListArgs: ["delegation", "list"],
        candidateHub,
        temporaryRoot,
        baseEnv: { PATH: process.env.PATH },
        cwd: temporaryRoot,
      },
      {
        runHub: async (
          command: string,
          args: string[],
          options: { env: Record<string, string> },
        ) => {
          observations.push({ command, args, sparkHome: options.env.SPARK_HOME });
          return { stdout: "{}", stderr: "" };
        },
      },
    );

    assert.equal(result.databasePath, join(temporaryRoot, "hub-migration.sqlite"));
    assert.deepEqual(
      observations.map(({ command, args }) => ({ command, args })),
      [
        {
          command: baselineHub,
          args: ["delegation", "list", "--database", result.databasePath, "--json"],
        },
        {
          command: candidateHub,
          args: ["delegation", "list", "--database", result.databasePath, "--json"],
        },
        {
          command: baselineHub,
          args: ["delegation", "list", "--database", result.databasePath, "--json"],
        },
      ],
    );
    assert.equal(new Set(observations.map((entry) => entry.sparkHome)).size, 1);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("mixed-version IPC gate isolates phases and proves both compatibility directions plus oRPC", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "spark-release-matrix-test-"));
  const baselineSpark = "/fixture/published/spark";
  const candidateSpark = "/fixture/candidate/spark";
  const observations: Array<{
    spark: string;
    action: string;
    sparkHome: string;
    legacy: boolean;
    orpc: boolean;
  }> = [];
  const alive = new Set<number>();
  let nextPid = 100;

  try {
    const results = await runMixedVersionIpcMatrix(
      {
        baselineSpark,
        candidateSpark,
        temporaryRoot,
        baseEnv: { PATH: process.env.PATH },
        cwd: temporaryRoot,
      },
      {
        isProcessAlive: (pid: number) => alive.has(pid),
        log: () => undefined,
        readProcessStartToken: async (pid: number) => (alive.has(pid) ? `fixture:${pid}` : null),
        runSpark: async (
          spark: string,
          args: string[],
          options: { env: Record<string, string> },
        ) => {
          const sparkHome = options.env.SPARK_HOME;
          const runtimeDir = join(sparkHome, "apps", "daemon", "run");
          const legacySocket = join(runtimeDir, "daemon.sock");
          const orpcSocket = join(runtimeDir, "daemon-orpc.sock");
          const pidFile = join(runtimeDir, "daemon.pid");
          const action = args[1] ?? "";

          if (action === "start") {
            const pid = nextPid++;
            alive.add(pid);
            await mkdir(runtimeDir, { recursive: true });
            await Promise.all([
              writeFile(legacySocket, ""),
              writeFile(orpcSocket, ""),
              writeFile(pidFile, `${pid}\n`),
            ]);
          } else if (action === "status") {
            const [legacy, orpc] = await Promise.all([exists(legacySocket), exists(orpcSocket)]);
            observations.push({ spark, action, sparkHome, legacy, orpc });
            if (spark === baselineSpark && !legacy) {
              throw new Error("published client requires legacy socket");
            }
            if (spark === candidateSpark && !legacy && !orpc) {
              throw new Error("candidate client has no available transport");
            }
          } else if (action === "stop") {
            const [legacy, orpc] = await Promise.all([exists(legacySocket), exists(orpcSocket)]);
            if (!legacy || !orpc)
              throw new Error("gate must restore hidden sockets before cleanup");
            alive.delete(Number((await readFile(pidFile, "utf8")).trim()));
            await Promise.all([
              rm(pidFile, { force: true }),
              rm(legacySocket, { force: true }),
              rm(orpcSocket, { force: true }),
            ]);
          }
          return { stdout: JSON.stringify({ daemon: { running: true } }), stderr: "" };
        },
      },
    );

    assert.equal(results.length, 3);
    assert.equal(alive.size, 0);
    assert.equal(new Set(results.map((result: { sparkHome: string }) => result.sparkHome)).size, 3);
    assert.deepEqual(
      observations.map(({ spark, legacy, orpc }) => ({ spark, legacy, orpc })),
      [
        { spark: candidateSpark, legacy: true, orpc: false },
        { spark: baselineSpark, legacy: true, orpc: false },
        { spark: candidateSpark, legacy: false, orpc: true },
      ],
    );
    for (const result of results) {
      assert.equal(await exists(join(result.runtimeDir, "daemon.pid")), false);
      assert.equal(await exists(join(result.runtimeDir, "daemon.sock")), false);
      assert.equal(await exists(join(result.runtimeDir, "daemon-orpc.sock")), false);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("mixed-version IPC gate terminates the captured process when phase and CLI cleanup fail", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "spark-release-cleanup-test-"));
  const pid = 777;
  let alive = false;
  const signals: string[] = [];
  const runtimeDir = join(temporaryRoot, "p0", "h", "apps", "daemon", "run");
  const legacySocket = join(runtimeDir, "daemon.sock");
  const orpcSocket = join(runtimeDir, "daemon-orpc.sock");
  const pidFile = join(runtimeDir, "daemon.pid");

  try {
    await assert.rejects(
      runMixedVersionIpcMatrix(
        {
          baselineSpark: "/fixture/published/spark",
          candidateSpark: "/fixture/candidate/spark",
          temporaryRoot,
          baseEnv: { PATH: process.env.PATH },
          cwd: temporaryRoot,
        },
        {
          cleanupPollIntervalMs: 1,
          cleanupTimeoutMs: 5,
          isProcessAlive: () => alive,
          log: () => undefined,
          readProcessStartToken: async () => (alive ? `fixture:${pid}` : null),
          runSpark: async (_spark: string, args: string[]) => {
            const action = args[1] ?? "";
            if (action === "start") {
              alive = true;
              await mkdir(runtimeDir, { recursive: true });
              await Promise.all([
                writeFile(legacySocket, ""),
                writeFile(orpcSocket, ""),
                writeFile(pidFile, `${pid}\n`),
              ]);
              return { stdout: JSON.stringify({ daemon: { running: true } }), stderr: "" };
            }
            if (action === "status") throw new Error("forced status failure");
            throw new Error("forced CLI cleanup failure");
          },
          signalProcess: async (actualPid: number, signal: string) => {
            assert.equal(actualPid, pid);
            signals.push(signal);
            if (signal === "SIGKILL") alive = false;
          },
        },
      ),
      /forced status failure/u,
    );

    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(alive, false);
    assert.equal(await exists(pidFile), false);
    assert.equal(await exists(legacySocket), false);
    assert.equal(await exists(orpcSocket), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
