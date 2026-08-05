import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

// @ts-expect-error The executable release script intentionally has no declaration surface.
import * as migrationGate from "../scripts/test-release-migration.mjs";

const {
  parseMigrationArguments,
  readCandidateArtifactIdentity,
  runMixedVersionIpcMatrix,
  selectPublishedBaselineVersion,
} = migrationGate;

test("release migration arguments require an explicit published baseline older than the candidate", () => {
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
