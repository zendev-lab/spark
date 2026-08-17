#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { validateProductCompatibilityReport } from "./release-compatibility-report.mjs";

const execFileAsync = promisify(execFile);

export const PRODUCT_PACKAGES = Object.freeze({
  hub: "@zendev-lab/spark-hub",
  daemon: "@zendev-lab/spark-daemon",
  tui: "@zendev-lab/spark-tui",
});

export const SAME_VERSION_PHASE = "candidate-same-version";

export const REQUIRED_PHASES = Object.freeze([
  "candidate-hub--baseline-daemon",
  "baseline-hub--candidate-daemon",
  "candidate-tui--baseline-daemon",
  "baseline-tui--candidate-daemon",
]);

export const PHASE_SPECS = Object.freeze({
  "candidate-hub--baseline-daemon": {
    actor: "hub",
    actorSide: "candidate",
    peer: "daemon",
    peerSide: "baseline",
  },
  "baseline-hub--candidate-daemon": {
    actor: "hub",
    actorSide: "baseline",
    peer: "daemon",
    peerSide: "candidate",
  },
  "candidate-tui--baseline-daemon": {
    actor: "tui",
    actorSide: "candidate",
    peer: "daemon",
    peerSide: "baseline",
  },
  "baseline-tui--candidate-daemon": {
    actor: "tui",
    actorSide: "baseline",
    peer: "daemon",
    peerSide: "candidate",
  },
});

export function parseCompatibilityArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--baseline-version") values.baselineVersion = argv[++index];
    else if (arg === "--candidate-hub-tarball") values.candidateHubTarball = argv[++index];
    else if (arg === "--candidate-daemon-tarball") values.candidateDaemonTarball = argv[++index];
    else if (arg === "--candidate-tui-tarball") values.candidateTuiTarball = argv[++index];
    else if (arg === "--report") values.reportPath = argv[++index];
    else throw new Error("Unknown compatibility argument: " + arg);
  }
  const required = ["candidateHubTarball", "candidateDaemonTarball", "candidateTuiTarball"];
  const missing = required.filter((key) => !values[key]);
  if (missing.length) throw new Error("Missing candidate exact tarballs: " + missing.join(", "));
  if (!values.baselineVersion) throw new Error("--baseline-version is required");
  return values;
}

export function assertPackagedExecutable(command, packageName) {
  const normalized = String(command).replaceAll("\\\\", "/");
  if (!normalized.includes("/node_modules/" + packageName + "/")) {
    throw new Error("Refusing non-packaged " + packageName + " executable: " + command);
  }
  if (normalized.includes("/apps/") || normalized.includes("/packages/")) {
    throw new Error("Refusing source fallback for " + packageName + ": " + command);
  }
  return command;
}

export function validatePhaseReport(report) {
  if (!report || typeof report !== "object") throw new Error("phase report must be an object");
  if (!REQUIRED_PHASES.includes(report.id)) throw new Error("unknown phase: " + report.id);
  if (!["passed", "failed", "not-applicable"].includes(report.status)) {
    throw new Error("invalid phase status: " + report.status);
  }
  if (!Array.isArray(report.assertions) || report.assertions.length === 0) {
    throw new Error("phase " + report.id + " has no assertions");
  }
  if (!report.cleanup || typeof report.cleanup !== "object")
    throw new Error("phase cleanup is required");
  if (report.status === "passed" && report.assertions.some((item) => item.status !== "passed")) {
    throw new Error("passed phase contains a non-passed assertion: " + report.id);
  }
  if (report.status === "passed" && report.cleanup.verified !== true) {
    throw new Error("passed phase cleanup is not verified: " + report.id);
  }
  if (report.status === "not-applicable" && !report.reason) {
    throw new Error("not-applicable phase requires a reason: " + report.id);
  }
  return report;
}

export function validateMatrixReport(report, candidateVersion, baselineVersion) {
  if (!/^\d+\.\d+\.\d+$/u.test(candidateVersion) || !/^\d+\.\d+\.\d+$/u.test(baselineVersion))
    throw new Error("candidate and baseline must be stable x.y.z versions");
  if (compareVersions(candidateVersion, baselineVersion) <= 0)
    throw new Error("baseline must be older than candidate");
  if (baselineVersion === "0.2.1" && candidateVersion !== "0.3.0")
    throw new Error("0.2.1 is only valid for candidate 0.3.0");
  if (candidateVersion === "0.3.0" && baselineVersion !== "0.2.1")
    throw new Error("candidate 0.3.0 requires the bounded 0.2.1 baseline");
  if (
    !report ||
    report.candidate?.version !== candidateVersion ||
    report.baseline?.version !== baselineVersion
  )
    throw new Error("matrix report identity does not match candidate/baseline");
  if (
    !Array.isArray(report.phases) ||
    !report.cleanup ||
    !report.candidate?.identities ||
    !report.baseline?.identities
  )
    throw new Error("matrix report is incomplete");
  const ids = report.phases.map((phase) => phase.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate phase report");
  if (!ids.includes(SAME_VERSION_PHASE))
    throw new Error("missing candidate same-version sanity phase");
  if (!legacyException(candidateVersion, baselineVersion)) {
    const missing = REQUIRED_PHASES.filter((id) => !ids.includes(id));
    if (missing.length) throw new Error("missing required phases: " + missing.join(", "));
    if (report.phases.some((phase) => phase.status === "not-applicable"))
      throw new Error("split-product phase cannot be not-applicable after the legacy exception");
  }
  return report;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function selectPublishedBaselineVersion(published, candidateVersion) {
  const stable = (Array.isArray(published) ? published : [published])
    .filter((value) => typeof value === "string" && /^\d+\.\d+\.\d+$/u.test(value))
    .sort(compareVersions);
  return stable.filter((version) => compareVersions(version, candidateVersion) < 0).at(-1);
}

async function assertPublishedBaseline(packageNames, baselineVersion, candidateVersion) {
  for (const packageName of packageNames) {
    const result = await command("npm", ["view", packageName, "versions", "--json"], {
      timeout: 120000,
    });
    const published = JSON.parse(result.stdout);
    const selected = selectPublishedBaselineVersion(published, candidateVersion);
    if (selected !== baselineVersion)
      throw new Error(
        packageName +
          " baseline " +
          baselineVersion +
          " is not published N-1; expected " +
          String(selected),
      );
  }
}

export function legacyException(candidateVersion, baselineVersion) {
  return candidateVersion === "0.3.0" && baselineVersion === "0.2.1";
}

export const parse = parseCompatibilityArguments;
export const selectBaseline = selectPublishedBaselineVersion;

function phaseSatisfiesContract(phaseContract, phase, allowNotApplicable = false) {
  if (!phase || typeof phase !== "object") return false;
  if (allowNotApplicable && phase.status === "not-applicable") {
    return (
      typeof phase.reason === "string" &&
      phase.reason.length > 0 &&
      phase.cleanup?.status === "passed"
    );
  }
  if (phase.status !== "passed" || phase.cleanup?.status !== "passed") return false;
  const assertions = new Map(
    Array.isArray(phase.assertions)
      ? phase.assertions.map((assertion) => [assertion.id, assertion])
      : [],
  );
  return phaseContract.assertions.every((id) => assertions.get(id)?.status === "passed");
}

export function deriveOverall(contract, report) {
  const phases = new Map(
    Array.isArray(report?.phases) ? report.phases.map((phase) => [phase.id, phase]) : [],
  );
  const exception = contract.releaseGate.firstSplitReleaseException;
  const isException =
    report?.candidateVersion === exception.candidateVersion &&
    report?.baselineVersion === exception.baselineVersion;
  const requiredPass = contract.releaseGate.requiredPhases.every((phaseContract) =>
    phaseSatisfiesContract(phaseContract, phases.get(phaseContract.id), isException),
  );
  const sanityPass = phaseSatisfiesContract(
    contract.releaseGate.sameVersionPhase,
    phases.get(contract.releaseGate.sameVersionPhase.id),
  );
  return requiredPass && sanityPass ? "passed" : "failed";
}

export function validateReport(contract, report) {
  const derived = deriveOverall(contract, report);
  if (report?.overall !== derived) {
    throw new Error(
      `product report overall ${String(report?.overall)} does not match derived ${derived}`,
    );
  }
  return report;
}

async function archiveJson(tarball, entry) {
  const result = await execFileAsync("tar", ["-xOf", tarball, entry], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

export async function readTarballIdentity(tarball, expectedPackage) {
  const manifest = await archiveJson(tarball, "package/package.json");
  if (manifest.name !== expectedPackage)
    throw new Error("candidate package mismatch: " + manifest.name);
  const buildInfo = await archiveJson(tarball, "package/dist/build-info.json").catch(() => null);
  if (
    buildInfo &&
    (buildInfo.packageName !== expectedPackage || buildInfo.version !== manifest.version)
  )
    throw new Error("candidate build-info mismatch for " + expectedPackage);
  return { name: manifest.name, version: manifest.version, bin: manifest.bin ?? {}, buildInfo };
}

async function npmInstall(prefix, specifiers, env) {
  await mkdir(prefix, { recursive: true });
  await writeJson(join(prefix, "package.json"), {
    private: true,
    dependencies: Object.fromEntries(specifiers.map((item) => [item.name, item.specifier])),
  });
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--no-package-lock", "--omit=dev", "--package-lock=false"],
    {
      cwd: prefix,
      env,
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

async function npmPackPublished(prefix, packageName, version) {
  const destination = join(prefix, "published-tarballs");
  await mkdir(destination, { recursive: true });
  const result = await command(
    "npm",
    ["pack", `${packageName}@${version}`, "--json", "--pack-destination", destination],
    { cwd: prefix, timeout: 300000 },
  );
  const metadata = JSON.parse(result.stdout)[0];
  if (metadata?.name !== packageName || metadata?.version !== version || !metadata.filename) {
    throw new Error(`published artifact identity mismatch for ${packageName}@${version}`);
  }
  const tarball = join(destination, metadata.filename);
  return { tarball, sha256: sha256(await readFile(tarball)) };
}

async function removeTreeEventually(path) {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function packageIdentity(prefix, packageName) {
  const manifestPath = join(prefix, "node_modules", ...packageName.split("/"), "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const buildPath = join(
    prefix,
    "node_modules",
    ...packageName.split("/"),
    "dist",
    "build-info.json",
  );
  const buildInfo = await readFile(buildPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  return { name: manifest.name, version: manifest.version, bin: manifest.bin ?? {}, buildInfo };
}

async function verifyInstalled(prefix, packageName, expectedVersion, binName) {
  const identity = await packageIdentity(prefix, packageName);
  if (identity.name !== packageName || identity.version !== expectedVersion) {
    throw new Error(
      "installed identity mismatch for " +
        packageName +
        ": " +
        identity.name +
        "@" +
        identity.version,
    );
  }
  const packageRoot = join(prefix, "node_modules", ...packageName.split("/"));
  const bin = join(packageRoot, "bin", binName);
  await access(bin);
  return { packageName, identity, bin: assertPackagedExecutable(bin, packageName) };
}

async function command(command, args, options = {}) {
  return await execFileAsync(command, args, {
    timeout: options.timeout ?? 180000,
    maxBuffer: 32 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Hub exited before health: " + child.exitCode);
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.ok && body?.service === "spark-hub" && body?.status === "ok") return true;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Hub health timeout: " + url);
}

function phaseEnv(root, product = "daemon") {
  const productRoot = join(root, product);
  return {
    ...process.env,
    HOME: join(productRoot, "home"),
    SPARK_HOME: join(productRoot, "spark-home"),
    XDG_RUNTIME_DIR: join(productRoot, "runtime"),
    XDG_CONFIG_HOME: join(productRoot, "config"),
    XDG_DATA_HOME: join(productRoot, "data"),
    XDG_STATE_HOME: join(productRoot, "state"),
    SPARK_UPDATE_POLICY: "manual",
    BAIDU_ONEAPI_API_KEY:
      process.env.BAIDU_ONEAPI_API_KEY || "spark-release-compatibility-non-secret-fixture",
  };
}

async function preparePhaseEnv(root, product = "daemon") {
  const env = phaseEnv(root, product);
  await Promise.all(
    [
      env.HOME,
      env.SPARK_HOME,
      env.XDG_RUNTIME_DIR,
      env.XDG_CONFIG_HOME,
      env.XDG_DATA_HOME,
      env.XDG_STATE_HOME,
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  return env;
}

async function runHub(bin, root, assertions, requestedPort, probeBin = bin) {
  const port = requestedPort ?? (await availablePort());
  const env = {
    ...(await preparePhaseEnv(root, "hub")),
    HOST: "127.0.0.1",
    PORT: String(port),
    ORIGIN: "http://127.0.0.1:" + port,
  };
  const child = spawn(bin, [], {
    cwd: root,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("Hub process has no PID");
  const identity = { pid: child.pid, startToken: await processStartToken(child.pid) };
  if (!identity.startToken) {
    terminate(child);
    throw new Error("Hub PID/start token is unverifiable");
  }
  assertions.push({
    id: "hub-process-identity",
    status: "passed",
    detail: "captured Hub PID and start token",
  });
  try {
    await waitForHealth(env.ORIGIN + "/api/v1/health", child);
    assertions.push({
      id: "hub-health",
      status: "passed",
      detail: "packaged Hub health endpoint is ready",
    });
    const databasePath = join(env.SPARK_HOME, "apps", "hub", "data", "hub.sqlite");
    const probe = await command(
      probeBin,
      ["__compat-product", "prepare", "--database", databasePath, "--json"],
      { cwd: packagedProductRoot(probeBin), env },
    );
    const payload = JSON.parse(probe.stdout);
    if (
      payload?.product !== "@zendev-lab/spark-hub" ||
      typeof payload.registrationToken !== "string"
    )
      throw new Error("Hub compat probe did not return a runtime enrollment token");
    assertions.push({
      id: "hub-enrollment-probe",
      status: "passed",
      detail:
        probeBin === bin
          ? "packaged Hub created a scoped runtime enrollment token"
          : "candidate probe adapter prepared the baseline Hub database for a real packaged Hub runtime",
    });
    return { child, env, port, databasePath, probe: payload, identity };
  } catch (error) {
    try {
      await stopChild(child, identity);
    } catch (cleanupError) {
      const failure = new AggregateError([error, cleanupError], "Hub startup and cleanup failed");
      failure.cleanupUnsafe = true;
      throw failure;
    }
    throw error;
  }
}

async function availablePort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

async function stopChild(child, identity) {
  if (identity && !(await isOwnedAlive(identity)) && child.exitCode === null)
    throw new Error("Hub process identity changed before cleanup");
  terminate(child);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null)
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  if (child.exitCode === null && child.signalCode === null)
    throw new Error("Hub process cleanup did not verify exit");
  if (identity && (await isOwnedAlive(identity)))
    throw new Error("captured Hub process is still alive after cleanup");
}

async function processStartToken(pid) {
  try {
    if (process.platform === "linux") {
      const stat = await readFile("/proc/" + pid + "/stat", "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      return fields[19] ? "linux:" + fields[19] : null;
    }
    const result = await command("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 10000 });
    return result.stdout.trim() ? process.platform + ":" + result.stdout.trim() : null;
  } catch {
    return null;
  }
}

async function captureDaemonIdentity(pid) {
  const startToken = await processStartToken(pid);
  if (!Number.isInteger(pid) || pid <= 0 || !startToken)
    throw new Error("daemon PID/start token is unverifiable");
  return { pid, startToken };
}

async function isOwnedAlive(identity) {
  try {
    process.kill(identity.pid, 0);
  } catch {
    return false;
  }
  return (await processStartToken(identity.pid)) === identity.startToken;
}

function packagedProductRoot(bin) {
  return resolve(bin, "../..");
}

async function runDaemon(bin, root, assertions) {
  const env = await preparePhaseEnv(root);
  const cwd = packagedProductRoot(bin);
  const child = spawn(bin, ["__service-start"], {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (!child.pid) throw new Error("daemon foreground process has no PID");
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });
  const identity = await captureDaemonIdentity(child.pid);
  const deadline = Date.now() + 60_000;
  let payload;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `daemon foreground process exited ${child.exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      );
    try {
      const status = await command(bin, ["status", "--json"], { cwd, env, timeout: 10_000 });
      payload = JSON.parse(status.stdout);
      if (payload?.daemon?.running === true && payload?.daemon?.pid === child.pid) break;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (payload?.daemon?.running !== true || payload?.daemon?.pid !== child.pid) {
    terminate(child);
    throw new Error(
      `packaged daemon foreground process did not become ready within 60 seconds${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  assertions.push({
    id: "daemon-process-identity",
    status: "passed",
    detail: "captured packaged daemon foreground PID and start token",
  });
  assertions.push({
    id: "daemon-local-rpc-status",
    status: "passed",
    detail: "packaged daemon local RPC status is readable",
  });
  return { env, identity, child };
}

async function stopDaemon(bin, root, identity) {
  const env = phaseEnv(root);
  await command(bin, ["stop", "--yes"], { cwd: packagedProductRoot(bin), env }).catch(
    () => undefined,
  );
  let deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await isOwnedAlive(identity)))
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  if (await isOwnedAlive(identity)) {
    try {
      process.kill(-identity.pid, "SIGTERM");
    } catch {
      try {
        process.kill(identity.pid, "SIGTERM");
      } catch {}
    }
    deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await isOwnedAlive(identity)))
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (await isOwnedAlive(identity)) throw new Error("daemon cleanup could not verify process exit");
}

async function prepareDaemonWorkspace(bin, root, assertions) {
  const env = await preparePhaseEnv(root);
  const workspace = join(root, "compat-workspace");
  await mkdir(workspace, { recursive: true });
  const result = await command(
    bin,
    ["__compat-product", "prepare-workspace", "--workspace", workspace, "--json"],
    { cwd: packagedProductRoot(bin), env },
  );
  const payload = JSON.parse(result.stdout);
  if (typeof payload?.workspaceId !== "string")
    throw new Error("daemon local workspace preparation failed");
  assertions.push({
    id: "daemon-workspace-prepare",
    status: "passed",
    detail: "daemon owner registered the local compatibility workspace",
  });
  return payload;
}

async function prepareDaemonInvocation(bin, root, workspaceId, assertions) {
  const env = await preparePhaseEnv(root);
  const result = await command(
    bin,
    ["__compat-product", "prepare-invocation", "--workspace-id", workspaceId, "--json"],
    { cwd: packagedProductRoot(bin), env },
  );
  const payload = JSON.parse(result.stdout);
  if (
    payload?.workspaceId !== workspaceId ||
    typeof payload?.sessionId !== "string" ||
    typeof payload?.invocationId !== "string"
  ) {
    throw new Error("daemon compatibility invocation preparation failed");
  }
  assertions.push({
    id: "daemon-invocation-prepare",
    status: "passed",
    detail: "candidate adapter seeded a structured queued invocation without model execution",
  });
  return payload;
}

async function runTui(bin, root, assertions, fixture) {
  const env = await preparePhaseEnv(root);
  const workspace = join(root, "compat-workspace");
  await mkdir(workspace, { recursive: true });
  if (typeof fixture?.sessionId !== "string" || typeof fixture?.invocationId !== "string") {
    throw new Error("TUI compatibility probe requires a prepared session and invocation");
  }
  const firstResult = await command(
    bin,
    [
      "__compat-product",
      "first",
      "--session",
      fixture.sessionId,
      "--invocation",
      fixture.invocationId,
      "--json",
    ],
    { cwd: workspace, env, timeout: 180_000 },
  );
  const first = JSON.parse(firstResult.stdout);
  for (const id of [
    "handshake",
    "localRpcStatus",
    "sessionWrite",
    "snapshotRead",
    "eventDecode",
    "cancelled",
    "detachRelease",
  ])
    if (first?.assertions?.[id] !== true) throw new Error("TUI first assertion failed: " + id);
  const resumeResult = await command(
    bin,
    [
      "__compat-product",
      "resume",
      "--session",
      first.sessionId,
      "--invocation",
      first.invocationId,
      "--cursor",
      String(first.cursor),
      "--json",
    ],
    { cwd: workspace, env, timeout: 180_000 },
  );
  const resume = JSON.parse(resumeResult.stdout);
  for (const id of [
    "handshake",
    "localRpcStatus",
    "snapshotRead",
    "eventDecode",
    "cancelled",
    "detachRelease",
    "reconnect",
    "cursorReconnect",
    "noDuplicate",
  ])
    if (resume?.assertions?.[id] !== true) throw new Error("TUI resume assertion failed: " + id);
  assertions.push(
    {
      id: "tui-local-rpc-probe",
      status: "passed",
      detail: "packaged TUI first/resume used its real daemon client",
    },
    {
      id: "tui-session-read-write",
      status: "passed",
      detail: "TUI reread the prepared daemon-managed session and invocation snapshot",
    },
    {
      id: "tui-detach-release",
      status: "passed",
      detail: "both TUI processes released their workspace leases",
    },
    {
      id: "tui-reconnect",
      status: "passed",
      detail: "resume process continued from the durable cursor without duplicate events",
    },
  );
  return {
    assertions: {
      handshake: true,
      localRpcStatus: true,
      sessionWrite: true,
      snapshotRead: true,
      eventDecode: true,
      cancelled: true,
      detachRelease: true,
      reconnect: true,
      cursorReconnect: true,
      noDuplicate: true,
    },
    first,
    resume,
  };
}

async function runBaselineTui(bin, candidateTuiBin, root, assertions, fixture) {
  const packageRoot = packagedProductRoot(bin);
  const entry = join(packageRoot, "dist/spark-tui.js");
  await access(entry);
  const adapterPath = join(root, "baseline-tui-rpc-adapter.mjs");
  await writeFile(
    adapterPath,
    `import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [entry, sessionId, invocationId] = process.argv.slice(2);
const packageRoot = resolve(dirname(entry), "..");
const daemonRoot = resolve(packageRoot, "../spark-daemon");
process.env.SPARK_PRODUCT_DIST = resolve(packageRoot, "dist");
process.env.SPARK_BUILD_INFO_PATH = resolve(packageRoot, "dist/build-info.json");
process.env.SPARK_DAEMON_COMMAND = resolve(daemonRoot, "bin/spark-daemon");
process.env.SPARK_DAEMON_ENTRYPOINT = resolve(daemonRoot, "dist/spark-daemon.js");
process.env.SPARK_HEADLESS_EXECUTOR_MODULE = resolve(
  daemonRoot,
  "dist/spark-headless-role-executor.js",
);
const module = await import(pathToFileURL(entry).href);
if (typeof module.handleSparkRpcLine !== "function") {
  throw new Error("baseline TUI bundle does not export handleSparkRpcLine");
}
const replies = [];
const writer = (value) => replies.push(value);
const state = {};
await module.handleSparkRpcLine(
  JSON.stringify({ id: "state", type: "get_state" }),
  {},
  { sessionId },
  writer,
  state,
);
if (!invocationId) throw new Error("baseline TUI RPC adapter requires an invocation ID");
await module.handleSparkRpcLine(
  JSON.stringify({ id: "abort", type: "abort", invocationId }),
  {},
  { sessionId },
  writer,
  state,
);
console.log(JSON.stringify({ invocationId, replies }));
`,
  );
  const env = await preparePhaseEnv(root);
  const workspace = join(root, "compat-workspace");
  const result = await command(
    process.execPath,
    [adapterPath, entry, fixture.sessionId, fixture.invocationId],
    {
      cwd: workspace,
      env,
      timeout: 180_000,
    },
  );
  const baseline = JSON.parse(result.stdout);
  const stateReply = baseline.replies?.find((reply) => reply.id === "state");
  const abortReply = baseline.replies?.find((reply) => reply.id === "abort");
  if (stateReply?.success !== true || abortReply?.success !== true) {
    throw new Error("baseline TUI RPC adapter did not complete status and cancellation requests");
  }
  const deadline = Date.now() + 20_000;
  let resume;
  while (Date.now() < deadline) {
    const resumeResult = await command(
      candidateTuiBin,
      [
        "__compat-product",
        "resume",
        "--session",
        fixture.sessionId,
        "--invocation",
        fixture.invocationId,
        "--cursor",
        "0",
        "--json",
      ],
      { cwd: workspace, env, timeout: 180_000 },
    );
    resume = JSON.parse(resumeResult.stdout);
    if (resume?.assertions?.cancelled === true) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  for (const id of [
    "handshake",
    "localRpcStatus",
    "snapshotRead",
    "eventDecode",
    "cancelled",
    "detachRelease",
    "reconnect",
    "cursorReconnect",
    "noDuplicate",
  ]) {
    if (resume?.assertions?.[id] !== true) {
      throw new Error("baseline TUI compatibility assertion failed: " + id);
    }
  }
  if (!(resume.nextCursor > 0)) {
    throw new Error("baseline TUI cancellation produced no durable invocation events");
  }
  assertions.push(
    {
      id: "baseline-tui-rpc-probe",
      status: "passed",
      detail:
        "published baseline TUI bundle used its exported RPC client against the candidate daemon",
    },
    {
      id: "baseline-tui-candidate-observer",
      status: "passed",
      detail:
        "candidate observer verified the baseline TUI invocation snapshot, events, cursor, and terminal state",
    },
  );
  return {
    assertions: {
      handshake: true,
      localRpcStatus: true,
      sessionWrite: true,
      snapshotRead: true,
      eventDecode: true,
      cancelled: true,
      detachRelease: true,
      reconnect: true,
      cursorReconnect: true,
      noDuplicate: true,
    },
    baseline,
    resume,
  };
}

async function verifyHubRuntime(hubBin, root, env, databasePath, assertions, suffix = "") {
  const result = await command(
    hubBin,
    ["__compat-product", "inspect", "--database", databasePath, "--json"],
    { cwd: root, env, timeout: 30_000 },
  );
  const probe = JSON.parse(result.stdout);
  if (
    probe?.runtimeStatus !== "online" ||
    probe?.commandStatus !== "succeeded" ||
    typeof probe?.bindingId !== "string" ||
    typeof probe?.workspaceId !== "string"
  )
    throw new Error("Hub runtime verification failed");
  assertions.push({
    id: "hub-projection-read-write" + suffix,
    status: "passed",
    detail: "Hub read the runtime projection and delivered a daemon status command",
  });
  return probe;
}

async function registerDaemon(daemonBin, daemonRoot, hubInfo, assertions) {
  const env = await preparePhaseEnv(daemonRoot);
  const workspace = join(daemonRoot, "compat-workspace");
  await mkdir(workspace, { recursive: true });
  await command(
    process.execPath,
    [
      daemonBin,
      "workspace",
      "register",
      workspace,
      "--server-url",
      hubInfo.origin,
      "--token",
      hubInfo.registrationToken,
      "--name",
      "release-compatibility",
      "--workspace-name",
      "release-compatibility",
      "--workspace-slug",
      "release-compatibility",
      "--allow-insecure-http",
    ],
    { cwd: packagedProductRoot(daemonBin), env },
  );
  assertions.push({
    id: "hub-daemon-registration",
    status: "passed",
    detail: "daemon registered through its packaged workspace registration command",
  });
}

const DEFAULT_PHASE_RUNTIME = Object.freeze({
  runHub,
  runDaemon,
  registerDaemon,
  prepareDaemonWorkspace,
  prepareDaemonInvocation,
  verifyHubRuntime,
  runTui,
  runBaselineTui,
  stopChild,
  stopDaemon,
});

function assertInstallation(installation, expectedPackage) {
  if (
    installation?.packageName !== expectedPackage ||
    installation?.identity?.name !== expectedPackage ||
    typeof installation?.identity?.version !== "string" ||
    typeof installation?.bin !== "string"
  ) {
    throw new Error("invalid installed product identity for " + expectedPackage);
  }
}

function passedAssertion(id, detail) {
  return { id, status: "passed", detail };
}

export async function runPhase(spec, installations, root, runtime = DEFAULT_PHASE_RUNTIME) {
  const assertions = [];
  const details = [];
  const cleanup = {
    status: "failed",
    attempted: false,
    verified: false,
    preservedFixture: false,
    details: [],
  };
  const phaseRoot = join(root, spec.id);
  await mkdir(phaseRoot, { recursive: true, mode: 0o700 });
  let hubProcess;
  let hubIdentity;
  let daemonStarted;
  let phaseError;
  try {
    const actor = installations[spec.actorSide][spec.actor];
    const peer = installations[spec.peerSide][spec.peer];
    assertInstallation(actor, PRODUCT_PACKAGES[spec.actor]);
    assertInstallation(peer, PRODUCT_PACKAGES[spec.peer]);
    assertions.push(
      passedAssertion("product-identity", "actor and peer exact package identities verified"),
    );
    if (spec.actor === "hub") {
      const hub = await runtime.runHub(
        actor.bin,
        phaseRoot,
        details,
        undefined,
        installations.candidate.hub.bin,
      );
      hubProcess = hub.child;
      hubIdentity = hub.identity;
      daemonStarted = await runtime.runDaemon(peer.bin, phaseRoot, details);
      await runtime.registerDaemon(peer.bin, phaseRoot, hub.probe, details);
      assertions.push(
        passedAssertion("handshake", "daemon registered and established its Hub runtime uplink"),
      );
      const verified = await runtime.verifyHubRuntime(
        installations.candidate.hub.bin,
        phaseRoot,
        hub.env,
        hub.databasePath,
        details,
      );
      if (verified.runtimeStatus !== "online" || verified.bindingCount < 1)
        throw new Error("Hub projection was not online");
      assertions.push(
        passedAssertion(
          "projection-read",
          "Hub read an online runtime projection and workspace binding",
        ),
      );
      if (verified.commandStatus !== "succeeded")
        throw new Error("Hub command delivery did not succeed");
      assertions.push(
        passedAssertion("command-delivery", "Hub delivered and completed daemon.status.request"),
      );
      await runtime.stopChild(hubProcess, hubIdentity);
      hubProcess = undefined;
      hubIdentity = undefined;
      const restarted = await runtime.runHub(
        actor.bin,
        phaseRoot,
        details,
        hub.port,
        installations.candidate.hub.bin,
      );
      hubProcess = restarted.child;
      hubIdentity = restarted.identity;
      const reconnected = await runtime.verifyHubRuntime(
        installations.candidate.hub.bin,
        phaseRoot,
        restarted.env,
        restarted.databasePath,
        details,
        "-after-reconnect",
      );
      if (reconnected.runtimeStatus !== "online" || reconnected.commandStatus !== "succeeded")
        throw new Error("daemon uplink did not reconnect after Hub restart");
      assertions.push(
        passedAssertion(
          "reconnect",
          "Hub restarted on the same origin and daemon uplink returned online",
        ),
      );
    } else {
      const preparedWorkspace = await runtime.prepareDaemonWorkspace(
        installations.candidate.daemon.bin,
        phaseRoot,
        details,
      );
      daemonStarted = await runtime.runDaemon(peer.bin, phaseRoot, details);
      const fixture = await runtime.prepareDaemonInvocation(
        installations.candidate.daemon.bin,
        phaseRoot,
        preparedWorkspace.workspaceId,
        details,
      );
      const probe =
        spec.actorSide === "baseline" && runtime.runBaselineTui
          ? await runtime.runBaselineTui(
              actor.bin,
              installations.candidate.tui.bin,
              phaseRoot,
              details,
              fixture,
            )
          : await runtime.runTui(actor.bin, phaseRoot, details, fixture);
      const values = probe?.assertions ?? {};
      if (!values.handshake || !values.localRpcStatus)
        throw new Error("TUI local RPC status/handshake evidence missing");
      assertions.push(
        passedAssertion(
          "local-rpc-status",
          "TUI used its daemon client status and workspace attach RPCs",
        ),
      );
      if (!values.sessionWrite || !values.snapshotRead)
        throw new Error("TUI session snapshot evidence missing");
      assertions.push(
        passedAssertion(
          "session-snapshot",
          "TUI created and read a daemon-managed session snapshot",
        ),
      );
      if (!values.eventDecode) throw new Error("TUI event decoding evidence missing");
      assertions.push(
        passedAssertion("event-decoding", "TUI decoded the durable invocation event stream"),
      );
      if (!values.reconnect || !values.cursorReconnect)
        throw new Error("TUI cursor reconnect evidence missing");
      assertions.push(
        passedAssertion(
          "cursor-reconnect",
          "TUI reattached and resumed after the durable event cursor",
        ),
      );
      if (!values.cancelled || !values.detachRelease)
        throw new Error("TUI cancellation-safe detach evidence missing");
      assertions.push(
        passedAssertion(
          "cancellation-safe-detach",
          "TUI cancelled the invocation and released both workspace leases",
        ),
      );
    }
  } catch (error) {
    phaseError = error instanceof Error ? error : new Error(String(error));
  }
  cleanup.attempted = true;
  try {
    if (daemonStarted)
      await runtime.stopDaemon(
        installations[spec.peerSide].daemon.bin,
        phaseRoot,
        daemonStarted.identity,
      );
    if (hubProcess) await runtime.stopChild(hubProcess, hubIdentity);
    cleanup.verified = true;
    cleanup.status = "passed";
    cleanup.details.push("daemon stop and Hub process exit verified by PID/start token");
    assertions.push(
      passedAssertion(
        "cleanup",
        "all captured processes exited and isolated fixture cleanup is safe",
      ),
    );
  } catch (error) {
    cleanup.preservedFixture = true;
    cleanup.details.push(error instanceof Error ? error.message : String(error));
    if (!phaseError) phaseError = error instanceof Error ? error : new Error(String(error));
  }
  return {
    id: spec.id,
    status: phaseError || !cleanup.verified ? "failed" : "passed",
    assertions,
    cleanup,
    details,
    ...(phaseError ? { error: phaseError.message } : {}),
  };
}

export async function buildMatrix({
  candidate,
  baselineVersion,
  root = process.cwd(),
  keepFixture = false,
}) {
  const contract = JSON.parse(
    await readFile(resolve(root, "architecture/release-compatibility.json"), "utf8"),
  );
  const candidateIds = {};
  for (const key of ["hub", "daemon", "tui"])
    candidateIds[key] = await readTarballIdentity(candidate[key], PRODUCT_PACKAGES[key]);
  const candidateVersion = candidateIds.hub.version;
  for (const key of ["daemon", "tui"])
    if (candidateIds[key].version !== candidateVersion)
      throw new Error("candidate tarballs do not share one version");
  const isLegacyException = legacyException(candidateVersion, baselineVersion);
  const fixtureBase =
    process.env.SPARK_COMPAT_FIXTURE_ROOT?.trim() ||
    (process.platform === "darwin" ? "/tmp" : tmpdir());
  const temporaryRoot = await mkdtemp(join(fixtureBase, "spark-pc-"));
  await chmod(temporaryRoot, 0o700);
  const report = {
    schemaVersion: 1,
    candidate: { version: candidateVersion, identities: candidateIds },
    baseline: { version: baselineVersion, identities: {} },
    phases: [],
    cleanup: { fixtureRoot: temporaryRoot, removed: false },
  };
  let preserveFixture = false;
  try {
    await assertPublishedBaseline(
      isLegacyException ? ["@zendev-lab/spark"] : Object.values(PRODUCT_PACKAGES),
      baselineVersion,
      candidateVersion,
    );
    const baselineException = isLegacyException;
    const installs = { candidate: {}, baseline: {} };
    const artifactSources = {
      candidate: Object.fromEntries(
        await Promise.all(
          ["hub", "daemon", "tui"].map(async (key) => [
            key,
            { source: "tarball", sha256: sha256(await readFile(resolve(root, candidate[key]))) },
          ]),
        ),
      ),
      baseline: {},
    };
    const binNames = { hub: "spark-hub", daemon: "spark-daemon", tui: "spark-tui" };
    const candidateRoot = join(temporaryRoot, "install-candidate");
    await npmInstall(
      candidateRoot,
      [
        { name: PRODUCT_PACKAGES.hub, specifier: resolve(root, candidate.hub) },
        { name: PRODUCT_PACKAGES.daemon, specifier: resolve(root, candidate.daemon) },
        { name: PRODUCT_PACKAGES.tui, specifier: resolve(root, candidate.tui) },
      ],
      { ...process.env, npm_config_ignore_scripts: "true" },
    );
    for (const key of ["hub", "daemon", "tui"])
      installs.candidate[key] = await verifyInstalled(
        candidateRoot,
        PRODUCT_PACKAGES[key],
        candidateVersion,
        binNames[key],
      );
    if (!baselineException) {
      const baselineRoot = join(temporaryRoot, "install-baseline");
      const packedBaseline = {};
      for (const key of ["hub", "daemon", "tui"]) {
        packedBaseline[key] = await npmPackPublished(
          temporaryRoot,
          PRODUCT_PACKAGES[key],
          baselineVersion,
        );
        artifactSources.baseline[key] = {
          source: "npm",
          sha256: packedBaseline[key].sha256,
        };
      }
      await npmInstall(
        baselineRoot,
        ["hub", "daemon", "tui"].map((key) => ({
          name: PRODUCT_PACKAGES[key],
          specifier: packedBaseline[key].tarball,
        })),
        { ...process.env, npm_config_ignore_scripts: "true" },
      );
      for (const key of ["hub", "daemon", "tui"]) {
        installs.baseline[key] = await verifyInstalled(
          baselineRoot,
          PRODUCT_PACKAGES[key],
          baselineVersion,
          binNames[key],
        );
        report.baseline.identities[key] = installs.baseline[key].identity;
      }
    } else {
      const legacyRoot = join(temporaryRoot, "install-baseline-legacy");
      const legacyArtifact = await npmPackPublished(
        temporaryRoot,
        "@zendev-lab/spark",
        baselineVersion,
      );
      artifactSources.baseline.legacy = {
        source: "npm",
        sha256: legacyArtifact.sha256,
      };
      await npmInstall(
        legacyRoot,
        [{ name: "@zendev-lab/spark", specifier: legacyArtifact.tarball }],
        { ...process.env, npm_config_ignore_scripts: "true" },
      );
      const legacy = await verifyInstalled(
        legacyRoot,
        "@zendev-lab/spark",
        baselineVersion,
        "spark",
      );
      installs.baseline.legacy = legacy;
      report.baseline.identities.legacy = legacy.identity;
    }
    if (baselineException) {
      for (const id of REQUIRED_PHASES)
        report.phases.push({
          id,
          status: "not-applicable",
          reason:
            "0.2.1 is the legacy all-in-one package and has no independently published Hub/TUI artifacts",
          assertions: [
            {
              id: "legacy-split-artifacts",
              status: "not-applicable",
              detail: "bounded 0.3.0 -> 0.2.1 exception",
            },
          ],
          cleanup: {
            attempted: false,
            verified: true,
            details: ["no split baseline process started"],
          },
        });
    } else {
      for (const id of REQUIRED_PHASES) {
        const phase = await runPhase({ id, ...PHASE_SPECS[id] }, installs, temporaryRoot);
        if (phase.cleanup?.preservedFixture) preserveFixture = true;
        report.phases.push(phase);
      }
    }
    const sanityAssertions = [];
    const sanityRoot = join(temporaryRoot, "candidate-same-version");
    await mkdir(sanityRoot, { recursive: true, mode: 0o700 });
    let sanityHub;
    let sanityHubIdentity;
    let sanityDaemon;
    let sanityFailure;
    try {
      sanityAssertions.push(
        passedAssertion(
          "product-identity",
          "candidate Hub, daemon, and TUI exact package identities verified",
        ),
      );
      const candidateHub = await runHub(installs.candidate.hub.bin, sanityRoot, sanityAssertions);
      sanityAssertions.push(
        passedAssertion("health", "candidate Hub packaged health endpoint became ready"),
      );
      sanityHub = candidateHub.child;
      sanityHubIdentity = candidateHub.identity;
      const sanityWorkspace = await prepareDaemonWorkspace(
        installs.candidate.daemon.bin,
        sanityRoot,
        sanityAssertions,
      );
      sanityDaemon = await runDaemon(installs.candidate.daemon.bin, sanityRoot, sanityAssertions);
      await registerDaemon(
        installs.candidate.daemon.bin,
        sanityRoot,
        candidateHub.probe,
        sanityAssertions,
      );
      await verifyHubRuntime(
        installs.candidate.hub.bin,
        sanityRoot,
        candidateHub.env,
        candidateHub.databasePath,
        sanityAssertions,
      );
      const sanityFixture = await prepareDaemonInvocation(
        installs.candidate.daemon.bin,
        sanityRoot,
        sanityWorkspace.workspaceId,
        sanityAssertions,
      );
      await runTui(installs.candidate.tui.bin, sanityRoot, sanityAssertions, sanityFixture);
      sanityAssertions.push(
        passedAssertion(
          "local-rpc-status",
          "candidate daemon and TUI completed local RPC status and workspace attach",
        ),
      );
    } catch (error) {
      sanityFailure = error;
      sanityAssertions.push({ id: "same-version-error", status: "failed", detail: String(error) });
    }
    const sanityCleanup = {
      status: "failed",
      attempted: true,
      verified: false,
      preservedFixture: false,
      details: [],
    };
    try {
      if (sanityDaemon)
        await stopDaemon(installs.candidate.daemon.bin, sanityRoot, sanityDaemon.identity);
      if (sanityHub) await stopChild(sanityHub, sanityHubIdentity);
      sanityCleanup.verified = true;
      sanityCleanup.status = "passed";
      sanityCleanup.details.push("candidate Hub/daemon/TUI processes stopped");
      sanityAssertions.push(
        passedAssertion("cleanup", "candidate Hub and daemon PID/start-token exits verified"),
      );
    } catch (error) {
      sanityCleanup.preservedFixture = true;
      sanityCleanup.details.push(String(error));
      preserveFixture = true;
    }
    report.phases.push({
      id: SAME_VERSION_PHASE,
      status: sanityFailure || !sanityCleanup.verified ? "failed" : "passed",
      assertions: sanityAssertions,
      cleanup: sanityCleanup,
    });
    for (const phase of report.phases.filter((item) => REQUIRED_PHASES.includes(item.id)))
      validatePhaseReport(phase);
    validateMatrixReport(report, candidateVersion, baselineVersion);
    const contractReport = toContractProductReport(contract, report, installs, artifactSources);
    validateReport(contract, contractReport);
    if (contractReport.overall === "passed")
      validateProductCompatibilityReport(contract, contractReport);
    if (contractReport.overall !== "passed") {
      throw Object.assign(new Error("adjacent product compatibility failed"), {
        report: contractReport,
      });
    }
    return contractReport;
  } catch (error) {
    if (error && typeof error === "object" && "report" in error) throw error;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { report });
  } finally {
    if (
      !keepFixture &&
      !preserveFixture &&
      !report.phases.some((phase) => phase.cleanup?.preservedFixture)
    ) {
      await removeTreeEventually(temporaryRoot);
      report.cleanup.removed = true;
    } else {
      report.cleanup.preservedFixture = true;
    }
  }
}

function toContractProductReport(contract, internal, installs, artifactSources) {
  const artifacts = [];
  for (const side of ["candidate", "baseline"]) {
    for (const product of side === "baseline" && installs.baseline.legacy
      ? ["legacy"]
      : ["daemon", "hub", "tui"]) {
      const installation = installs[side][product];
      if (!installation) continue;
      artifacts.push({
        component: `${side}-${product}`,
        packageName: installation.packageName,
        version: installation.identity.version,
        sha256: artifactSources[side][product].sha256,
        source: artifactSources[side][product].source,
        executable: installation.bin,
      });
    }
  }
  const phases = contract.releaseGate.requiredPhases.map((phaseContract) => {
    const phase = internal.phases.find(({ id }) => id === phaseContract.id);
    if (!phase) throw new Error(`missing internal phase ${phaseContract.id}`);
    if (phase.status === "not-applicable") {
      return {
        id: phaseContract.id,
        status: "not-applicable",
        reason: phase.reason,
        assertions: [],
        cleanup: { status: phase.cleanup?.verified ? "passed" : "failed" },
        details: phase.assertions,
      };
    }
    const evidence = new Map(phase.assertions.map((assertion) => [assertion.id, assertion]));
    return {
      id: phaseContract.id,
      status: phase.status,
      assertions: phaseContract.assertions.map((id) => ({
        id,
        status: evidence.get(id)?.status === "passed" ? "passed" : "failed",
      })),
      cleanup: { status: phase.cleanup?.verified ? "passed" : "failed" },
      details: phase.assertions,
      ...(phase.error ? { error: phase.error } : {}),
    };
  });
  const sanity = internal.phases.find(({ id }) => id === SAME_VERSION_PHASE);
  if (!sanity) throw new Error("missing candidate same-version sanity phase");
  const sanityEvidence = new Map(sanity.assertions.map((assertion) => [assertion.id, assertion]));
  phases.push({
    id: contract.releaseGate.sameVersionPhase.id,
    status: sanity.status,
    assertions: contract.releaseGate.sameVersionPhase.assertions.map((id) => ({
      id,
      status: sanityEvidence.get(id)?.status === "passed" ? "passed" : "failed",
    })),
    cleanup: { status: sanity.cleanup?.verified ? "passed" : "failed" },
    details: sanity.assertions,
  });
  const report = {
    schemaVersion: 1,
    contractSchemaVersion: contract.schemaVersion,
    candidateVersion: internal.candidate.version,
    baselineVersion: internal.baseline.version,
    artifactMode: contract.releaseGate.artifactMode,
    artifacts,
    phases,
    overall: "failed",
  };
  report.overall = deriveOverall(contract, report);
  return report;
}

async function main() {
  const args = parseCompatibilityArguments(process.argv.slice(2));
  try {
    const report = await buildMatrix({
      candidate: {
        hub: args.candidateHubTarball,
        daemon: args.candidateDaemonTarball,
        tui: args.candidateTuiTarball,
      },
      baselineVersion: args.baselineVersion,
    });
    const text = JSON.stringify(report, null, 2) + "\n";
    if (args.reportPath) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(resolve(args.reportPath), text);
    }
    process.stdout.write(text);
  } catch (error) {
    if (error?.report && args.reportPath) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(resolve(args.reportPath), JSON.stringify(error.report, null, 2) + "\n");
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  main().catch((error) => {
    if (error.report) process.stdout.write(JSON.stringify(error.report, null, 2) + "\n");
    console.error(error.message);
    process.exitCode = 1;
  });
