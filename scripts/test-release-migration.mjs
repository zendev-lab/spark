#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageName = "@zendev-lab/spark";

export function parseMigrationArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "baseline-version": { type: "string" },
      tarball: { type: "string" },
    },
    strict: true,
  });
  const candidateTarball = values.tarball;
  if (!candidateTarball) {
    throw new Error(
      "Usage: test-release-migration.mjs --tarball <candidate.tgz> [--baseline-version <published-version>]",
    );
  }
  const baselineVersion = values["baseline-version"];
  if (baselineVersion && !isStableVersion(baselineVersion)) {
    throw new Error(`Baseline version must be a stable x.y.z release: ${baselineVersion}`);
  }
  return { candidateTarball, baselineVersion };
}

export function selectPublishedBaselineVersion(published, currentVersion, explicitVersion) {
  const stable = (Array.isArray(published) ? published : [published])
    .filter((version) => typeof version === "string" && isStableVersion(version))
    .sort(compareVersions);
  if (explicitVersion) {
    if (!stable.includes(explicitVersion)) {
      throw new Error(`${packageName}@${explicitVersion} is not a published stable release.`);
    }
    if (compareVersions(explicitVersion, currentVersion) >= 0) {
      throw new Error(
        `Explicit baseline ${explicitVersion} must be older than candidate ${currentVersion}.`,
      );
    }
    return explicitVersion;
  }
  return stable.filter((version) => compareVersions(version, currentVersion) < 0).at(-1);
}

export async function readCandidateArtifactIdentity(
  candidatePath,
  expectedVersion,
  dependencies = {},
) {
  const readArchiveEntry =
    dependencies.readArchiveEntry ??
    (async (entry) => {
      const result = await execFileAsync("tar", ["-xOf", candidatePath, entry], {
        maxBuffer: 4 * 1024 * 1024,
      });
      return result.stdout;
    });
  const [manifestText, buildInfoText] = await Promise.all([
    readArchiveEntry("package/package.json"),
    readArchiveEntry("package/dist/build-info.json"),
  ]);
  let manifest;
  let buildInfo;
  try {
    manifest = JSON.parse(manifestText);
    buildInfo = JSON.parse(buildInfoText);
  } catch (error) {
    throw new Error(`Candidate tarball contains invalid release identity JSON: ${candidatePath}`, {
      cause: error,
    });
  }
  return assertCandidateArtifactIdentity({ manifest, buildInfo, expectedVersion, candidatePath });
}

export function assertCandidateArtifactIdentity({
  manifest,
  buildInfo,
  expectedVersion,
  candidatePath = "<candidate tarball>",
}) {
  const manifestIdentity = `${String(manifest?.name)}@${String(manifest?.version)}`;
  const buildIdentity = `${String(buildInfo?.packageName)}@${String(buildInfo?.version)}`;
  if (manifest?.name !== packageName || manifest?.version !== expectedVersion) {
    throw new Error(
      `${candidatePath} package identity ${manifestIdentity} does not match ${packageName}@${expectedVersion}.`,
    );
  }
  if (buildInfo?.packageName !== packageName || buildInfo?.version !== expectedVersion) {
    throw new Error(
      `${candidatePath} build-info identity ${buildIdentity} does not match ${packageName}@${expectedVersion}.`,
    );
  }
  if (manifest.version !== buildInfo.version) {
    throw new Error(
      `${candidatePath} package version ${manifest.version} does not match build-info version ${buildInfo.version}.`,
    );
  }
  return { packageName, version: expectedVersion };
}

export async function runMixedVersionIpcMatrix(
  { baselineSpark, candidateSpark, temporaryRoot, baseEnv = process.env, cwd = process.cwd() },
  dependencies = {},
) {
  const runSpark =
    dependencies.runSpark ??
    (async (spark, args, { env }) => await runCommand(spark, args, { cwd, env }));
  const log = dependencies.log ?? console.log;
  const processControl = {
    isAlive: dependencies.isProcessAlive ?? isProcessAlive,
    readStartToken: dependencies.readProcessStartToken ?? readProcessStartToken,
    signal: dependencies.signalProcess ?? signalProcess,
    sleep: dependencies.sleep ?? delay,
    timeoutMs: dependencies.cleanupTimeoutMs ?? 5_000,
    pollIntervalMs: dependencies.cleanupPollIntervalMs ?? 50,
  };
  const phases = [
    ["candidate-to-published-legacy", baselineSpark, candidateSpark, "orpc", false],
    ["published-to-candidate-legacy", candidateSpark, baselineSpark, "orpc", true],
    ["candidate-to-candidate-orpc", candidateSpark, candidateSpark, "legacy", true],
  ];
  const results = [];

  for (const [index, [id, owner, client, hiddenSocket, requireDual]] of phases.entries()) {
    const root = join(temporaryRoot, `p${index}`);
    const env = phaseEnvironment(baseEnv, root);
    const paths = daemonPaths(env.SPARK_HOME);
    await Promise.all(
      [env.HOME, env.SPARK_HOME, env.XDG_RUNTIME_DIR].map(async (path) => {
        await mkdir(path, { recursive: true, mode: 0o700 });
      }),
    );

    let failure;
    let daemonIdentity;
    let restoreSocket = async () => {};
    try {
      assertRunning(
        await runSpark(owner, ["daemon", "start", "--json"], { env }),
        `${id} owner did not start`,
      );
      daemonIdentity = await captureDaemonIdentity(paths, processControl);
      if (!(await exists(paths.legacy))) {
        throw new Error(`${id}: daemon.sock is required`);
      }
      if (requireDual) {
        await assertSockets(paths, "dual", `${id} before transport isolation`);
      }
      restoreSocket = await hideSocket(paths[hiddenSocket]);
      const expected = hiddenSocket === "orpc" ? "legacy" : "orpc";
      await assertSockets(paths, expected, id);
      assertRunning(
        await runSpark(client, ["daemon", "status", "--json"], { env }),
        `${id} status failed`,
      );
      await assertSockets(paths, expected, `${id} after status`);
    } catch (error) {
      failure = error;
    }

    try {
      await restoreSocket();
      daemonIdentity ??= await captureDaemonIdentityIfPresent(paths, processControl);
      if (daemonIdentity) {
        await stopDaemon([owner, client], paths, env, runSpark, id, daemonIdentity, processControl);
      } else {
        await assertNoRuntimeArtifacts(paths, id);
      }
    } catch (cleanupError) {
      const unsafeCleanup = new AggregateError(
        failure ? [failure, cleanupError] : [cleanupError],
        failure ? `${id} and cleanup failed` : `${id} daemon cleanup failed`,
      );
      unsafeCleanup.migrationCleanupUnsafe = true;
      throw unsafeCleanup;
    }
    if (failure) throw failure;
    log(`Mixed-version IPC phase passed: ${id}.`);
    results.push({ id, sparkHome: env.SPARK_HOME, runtimeDir: paths.runtime });
  }
  return results;
}

async function main() {
  const { candidateTarball, baselineVersion: explicitBaseline } = parseMigrationArguments(
    process.argv.slice(2),
  );
  const root = process.cwd();
  const candidatePath = resolve(root, candidateTarball);
  await access(candidatePath);
  const currentVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  await readCandidateArtifactIdentity(candidatePath, currentVersion);
  const npm = (args) => runCommand("npm", args, { cwd: root, env: process.env });
  const versions = await runOptional(["view", packageName, "versions", "--json"], npm);
  if (!versions) {
    if (explicitBaseline) {
      throw new Error(`Cannot verify ${packageName}@${explicitBaseline}: package not found.`);
    }
    console.log("No published Spark version exists; N-1 migration gate is not applicable.");
    return;
  }
  const baselineVersion = selectPublishedBaselineVersion(
    JSON.parse(versions.stdout),
    currentVersion,
    explicitBaseline,
  );
  if (!baselineVersion) {
    console.log("No earlier stable Spark version exists; N-1 migration gate is not applicable.");
    return;
  }

  const temporaryRoot = await mkdtemp("/tmp/spark-rpc-");
  await chmod(temporaryRoot, 0o700);
  let preserveTemporaryRoot = false;
  try {
    const baselineRoot = join(temporaryRoot, "baseline");
    const candidateRoot = join(temporaryRoot, "candidate");
    await Promise.all([mkdir(baselineRoot), mkdir(candidateRoot)]);
    await Promise.all([
      install(baselineRoot, `${packageName}@${baselineVersion}`, npm),
      install(candidateRoot, candidatePath, npm),
    ]);
    await runMixedVersionIpcMatrix({
      baselineSpark: join(baselineRoot, "node_modules", ".bin", "spark"),
      candidateSpark: join(candidateRoot, "node_modules", ".bin", "spark"),
      temporaryRoot,
      cwd: root,
    });
    console.log(
      `Mixed-version IPC gate passed: published ${baselineVersion} <-> candidate ${currentVersion}.`,
    );
  } catch (error) {
    preserveTemporaryRoot = error?.migrationCleanupUnsafe === true;
    throw error;
  } finally {
    if (preserveTemporaryRoot) {
      console.error(
        `Preserving ${temporaryRoot} because daemon process cleanup could not be verified.`,
      );
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function install(prefix, specifier, npm) {
  await npm([
    "install",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--omit=dev",
    "--no-package-lock",
    "--no-save",
    specifier,
  ]);
}

async function hideSocket(path) {
  const hiddenPath = `${path}.release-gate-hidden`;
  try {
    await rename(path, hiddenPath);
  } catch (error) {
    if (error?.code === "ENOENT") return async () => {};
    throw error;
  }
  return async () => {
    if (!(await exists(path)) && (await exists(hiddenPath))) {
      await rename(hiddenPath, path);
    }
  };
}

async function stopDaemon(sparks, paths, env, runSpark, label, daemonIdentity, processControl) {
  const errors = [];
  for (const spark of new Set(sparks)) {
    try {
      await runSpark(spark, ["daemon", "stop", "--yes"], { env });
      await waitForOwnedProcessExit(daemonIdentity, processControl);
      await removeStoppedRuntimeArtifacts(paths, daemonIdentity, processControl, label);
      return;
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await terminateOwnedDaemon(daemonIdentity, processControl);
    await removeStoppedRuntimeArtifacts(paths, daemonIdentity, processControl, label);
  } catch (error) {
    errors.push(error);
    throw new AggregateError(errors, `${label} daemon cleanup failed`);
  }
}

function phaseEnvironment(baseEnv, root) {
  const env = { ...baseEnv };
  const inheritedPaths =
    "SPARK_BUILD_INFO_PATH SPARK_HUB_SERVER_ENTRYPOINT SPARK_HUB_WEB_SERVICE_ENTRYPOINT SPARK_DAEMON_ENTRYPOINT SPARK_DEPLOYMENT_WATCH_PATH SPARK_HEADLESS_EXECUTOR_MODULE SPARK_MANAGED_CACHE_DIR SPARK_MANAGED_CONFIG_FILE SPARK_MANAGED_STATE_DIR SPARK_MANAGED_VERSIONS_DIR SPARK_PRODUCT_DIST SPARK_STABLE_LAUNCHER";
  for (const key of inheritedPaths.split(" ")) {
    delete env[key];
  }
  return {
    ...env,
    HOME: join(root, "home"),
    SPARK_HOME: join(root, "h"),
    SPARK_UPDATE_POLICY: "manual",
    XDG_CACHE_HOME: join(root, "xdg", "cache"),
    XDG_CONFIG_HOME: join(root, "xdg", "config"),
    XDG_DATA_HOME: join(root, "xdg", "data"),
    XDG_RUNTIME_DIR: join(root, "xdg", "runtime"),
    XDG_STATE_HOME: join(root, "xdg", "state"),
  };
}

function daemonPaths(sparkHome) {
  const runtime = join(sparkHome, "apps", "daemon", "run");
  const legacy = join(runtime, "daemon.sock");
  const orpc = join(runtime, "daemon-orpc.sock");
  return {
    runtime,
    legacy,
    legacyHidden: `${legacy}.release-gate-hidden`,
    orpc,
    orpcHidden: `${orpc}.release-gate-hidden`,
    pid: join(runtime, "daemon.pid"),
    identity: join(runtime, "daemon.identity.json"),
  };
}

async function assertSockets(paths, expected, label) {
  const [legacy, orpc] = await Promise.all([exists(paths.legacy), exists(paths.orpc)]);
  const matches =
    (expected === "legacy" && legacy && !orpc) ||
    (expected === "orpc" && !legacy && orpc) ||
    (expected === "dual" && legacy && orpc);
  if (!matches) {
    throw new Error(
      `${label}: expected ${expected} sockets, observed legacy=${legacy} orpc=${orpc}`,
    );
  }
}

async function captureDaemonIdentityIfPresent(paths, processControl) {
  if (!(await exists(paths.pid))) return null;
  return await captureDaemonIdentity(paths, processControl);
}

async function captureDaemonIdentity(paths, processControl) {
  const pid = Number((await readFile(paths.pid, "utf8")).trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Spark daemon pidfile contains an invalid PID: ${paths.pid}`);
  }
  if (!(await processControl.isAlive(pid))) {
    throw new Error(`Spark daemon process ${pid} exited before its identity was captured.`);
  }
  const startToken = await processControl.readStartToken(pid);
  if (!startToken) {
    throw new Error(`Cannot capture a process start token for Spark daemon ${pid}.`);
  }
  return { pid, startToken };
}

async function observeOwnedProcess(identity, processControl) {
  if (!(await processControl.isAlive(identity.pid))) return "exited";
  const currentToken = await processControl.readStartToken(identity.pid);
  if (!currentToken) {
    return (await processControl.isAlive(identity.pid)) ? "unverifiable" : "exited";
  }
  return currentToken === identity.startToken ? "owned" : "reused";
}

async function waitForOwnedProcessExit(identity, processControl) {
  const deadline = Date.now() + processControl.timeoutMs;
  let state = await observeOwnedProcess(identity, processControl);
  while (state === "owned" && Date.now() <= deadline) {
    await processControl.sleep(processControl.pollIntervalMs);
    state = await observeOwnedProcess(identity, processControl);
  }
  if (state === "exited" || state === "reused") return state;
  if (state === "unverifiable") {
    throw new Error(
      `Spark daemon process ${identity.pid} is alive but its identity cannot be verified.`,
    );
  }
  throw new Error(`Spark daemon process ${identity.pid} did not exit within the cleanup timeout.`);
}

async function terminateOwnedDaemon(identity, processControl) {
  const initial = await observeOwnedProcess(identity, processControl);
  if (initial === "exited") return;
  if (initial !== "owned") {
    throw new Error(
      `Refusing to signal Spark daemon PID ${identity.pid}: process identity is ${initial}.`,
    );
  }

  try {
    await processControl.signal(identity.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  try {
    await waitForOwnedProcessExit(identity, processControl);
    return;
  } catch {
    // Escalate only after proving the same process still owns this PID.
  }

  const beforeKill = await observeOwnedProcess(identity, processControl);
  if (beforeKill === "exited") return;
  if (beforeKill !== "owned") {
    throw new Error(
      `Refusing to SIGKILL Spark daemon PID ${identity.pid}: process identity is ${beforeKill}.`,
    );
  }
  try {
    await processControl.signal(identity.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await waitForOwnedProcessExit(identity, processControl);
}

async function removeStoppedRuntimeArtifacts(paths, identity, processControl, label) {
  const state = await observeOwnedProcess(identity, processControl);
  if (state === "owned" || state === "unverifiable") {
    throw new Error(`${label}: daemon process ${identity.pid} is still ${state}.`);
  }
  const artifacts = runtimeArtifacts(paths);
  const present = await Promise.all(artifacts.map(exists));
  if (!present.some(Boolean)) return;
  if (state === "reused") {
    throw new Error(
      `${label}: PID ${identity.pid} was reused while daemon runtime artifacts still exist.`,
    );
  }
  if (await exists(paths.pid)) {
    const currentPid = Number((await readFile(paths.pid, "utf8")).trim());
    if (Number.isInteger(currentPid) && currentPid !== identity.pid) {
      throw new Error(
        `${label}: replacement daemon PID ${currentPid} owns ${paths.runtime}; refusing cleanup.`,
      );
    }
  }
  await Promise.all(artifacts.map((path) => rm(path, { force: true })));
  await assertNoRuntimeArtifacts(paths, label);
}

async function assertNoRuntimeArtifacts(paths, label) {
  const remaining = (
    await Promise.all(
      runtimeArtifacts(paths).map(async (path) => ((await exists(path)) ? path : undefined)),
    )
  ).filter(Boolean);
  if (remaining.length > 0) {
    throw new Error(`${label}: daemon runtime artifacts remain: ${remaining.join(", ")}`);
  }
}

function runtimeArtifacts(paths) {
  return [
    paths.pid,
    paths.identity,
    paths.legacy,
    paths.legacyHidden,
    paths.orpc,
    paths.orpcHidden,
  ];
}

async function readProcessStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      return startTime ? `linux:${startTime}` : null;
    } catch {
      return null;
    }
  }
  try {
    const result = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      maxBuffer: 64 * 1024,
    });
    const startedAt = result.stdout.trim();
    return startedAt ? `${process.platform}:${startedAt}` : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function signalProcess(pid, signal) {
  process.kill(pid, signal);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertRunning(output, message) {
  const result = JSON.parse(output.stdout);
  const values = [
    result?.running,
    result?.daemon?.running,
    result?.result?.running,
    result?.result?.daemon?.running,
  ];
  if (!values.includes(true)) throw new Error(`${message}: daemon.running was not true`);
}

async function runCommand(command, args, { cwd, env }) {
  return await execFileAsync(command, args, {
    cwd,
    env,
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function runOptional(args, npm) {
  try {
    return await npm(args);
  } catch (error) {
    const text = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (/E404|is not in this registry/u.test(text)) return null;
    throw error;
  }
}

function isStableVersion(version) {
  return /^\d+\.\d+\.\d+$/u.test(version);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
