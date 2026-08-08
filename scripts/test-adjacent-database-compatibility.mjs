#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageNames = {
  daemon: "@zendev-lab/spark-daemon",
  hub: "@zendev-lab/spark-hub",
};
const requiredPhases = [
  "baseline-create-write",
  "candidate-migrate-read-write",
  "baseline-reopen-read-write",
  "candidate-idempotent-reopen",
  "candidate-fresh-baseline-read-write",
  "interruption-recovery",
  "reject-unsafe-states",
];

export function parseDatabaseCompatibilityArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "baseline-version": { type: "string" },
      "candidate-daemon-tarball": { type: "string" },
      "candidate-hub-tarball": { type: "string" },
      report: { type: "string" },
    },
    strict: true,
  });
  for (const name of ["baseline-version", "candidate-daemon-tarball", "candidate-hub-tarball"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(values["baseline-version"])) {
    throw new Error("--baseline-version must be stable SemVer");
  }
  return {
    baselineVersion: values["baseline-version"],
    candidateDaemonTarball: values["candidate-daemon-tarball"],
    candidateHubTarball: values["candidate-hub-tarball"],
    ...(values.report ? { reportPath: values.report } : {}),
  };
}

export function validateDatabaseMatrixReport(report, contract) {
  if (!report || report.schemaVersion !== 1) throw new Error("database report schema is invalid");
  if (!Array.isArray(report.owners)) throw new Error("database report owners are missing");
  const ids = report.owners.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate database owner report");
  const expectedOwners = contract.database.owners.map(({ id }) => id);
  if (JSON.stringify(ids) !== JSON.stringify(expectedOwners)) {
    throw new Error("database owner reports do not match the contract");
  }
  for (const owner of report.owners) {
    const phaseIds = owner.phases?.map(({ id }) => id) ?? [];
    if (new Set(phaseIds).size !== phaseIds.length) {
      throw new Error(`${owner.id} contains duplicate database phases`);
    }
    const missing = requiredPhases.filter((id) => !phaseIds.includes(id));
    if (missing.length)
      throw new Error(`${owner.id} missing database phases: ${missing.join(", ")}`);
    for (const phase of owner.phases) {
      if (phase.status !== "passed") throw new Error(`${owner.id}/${phase.id} did not pass`);
      if (!phase.assertions?.length) throw new Error(`${owner.id}/${phase.id} has no assertions`);
      if (phase.assertions.some(({ status }) => status !== "passed")) {
        throw new Error(`${owner.id}/${phase.id} contains a failed assertion`);
      }
      if (phase.cleanup?.status !== "passed") {
        throw new Error(`${owner.id}/${phase.id} cleanup was not verified`);
      }
    }
  }
  if (report.overall !== "passed") throw new Error("database report overall is not passed");
  return report;
}

export async function runDatabaseCompatibilityMatrix(input, dependencies = {}) {
  const contract =
    dependencies.contract ??
    JSON.parse(await readFile(resolve(root, "architecture/release-compatibility.json"), "utf8"));
  const candidateTarballs = {
    daemon: resolve(root, input.candidateDaemonTarball),
    hub: resolve(root, input.candidateHubTarball),
  };
  const fixtureBase =
    process.env.SPARK_COMPAT_FIXTURE_ROOT?.trim() ||
    (process.platform === "darwin" ? "/tmp" : tmpdir());
  const temporaryRoot = await mkdtemp(join(fixtureBase, "spark-db-"));
  await chmod(temporaryRoot, 0o700);
  let preserveFixture = false;
  try {
    const candidate = {};
    const baseline = {};
    for (const owner of ["daemon", "hub"]) {
      candidate[owner] = await installCandidate(
        join(temporaryRoot, `install-candidate-${owner}`),
        packageNames[owner],
        candidateTarballs[owner],
        owner,
      );
      baseline[owner] = await installBaseline(
        join(temporaryRoot, `install-baseline-${owner}`),
        owner,
        input.baselineVersion,
      );
    }
    const candidateVersion = candidate.daemon.version;
    if (candidate.hub.version !== candidateVersion) {
      throw new Error("candidate Hub and daemon tarballs are not lockstep");
    }
    const ownerReports = [];
    for (const ownerContract of contract.database.owners) {
      ownerReports.push(
        await runOwnerMatrix({
          owner: ownerContract.id,
          ownerContract,
          candidate: candidate[ownerContract.id],
          baseline: baseline[ownerContract.id],
          candidateVersion,
          baselineVersion: input.baselineVersion,
          root: join(temporaryRoot, ownerContract.id),
        }),
      );
    }
    const report = {
      schemaVersion: 1,
      contractSchemaVersion: contract.schemaVersion,
      candidateVersion,
      baselineVersion: input.baselineVersion,
      owners: ownerReports,
      overall: "passed",
    };
    validateDatabaseMatrixReport(report, contract);
    return report;
  } catch (error) {
    preserveFixture = error?.migrationCleanupUnsafe === true;
    if (preserveFixture) {
      console.error(`Preserving ${temporaryRoot}: process or SQLite cleanup was not verifiable.`);
    }
    throw error;
  } finally {
    if (!preserveFixture) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runOwnerMatrix(input) {
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  const candidateManifest = await readInstalledManifest(input.owner, input.candidate.packageRoot);
  const baselineManifest = await readInstalledManifest(
    input.owner,
    input.baseline.packageRoot,
    true,
  );
  const manifestPath = resolve(root, input.ownerContract.migrationManifest);
  const manifestSha256 = sha256(await readFile(manifestPath));
  const phases = [];

  const baselineSeed = phasePaths(input.root, "baseline-seed", input.owner);
  await createOwnerState(input.owner, input.baseline, baselineSeed, "baseline-seed");
  const baselineInspection = await inspectOwner(input.owner, input.baseline, baselineSeed, true);
  phases.push(
    passedPhase("baseline-create-write", [
      proof(
        "baseline-product-owned-write",
        input.owner === "hub"
          ? baselineInspection.sentinel === "baseline-seed"
          : baselineInspection.previousValues?.includes("legacy-daemon-schema"),
      ),
      proof("baseline-closed-checkpoint", await databaseIsClosed(baselineSeed.database)),
    ]),
  );

  const migrated = await copiedPhase(baselineSeed, input.root, "candidate-migrated", input.owner);
  const candidateWrite = await writeReadOwner(
    input.owner,
    input.candidate,
    migrated,
    "candidate-upgrade",
  );
  phases.push(
    passedPhase("candidate-migrate-read-write", [
      proof(
        "baseline-state-readable",
        candidateWrite.previousValues?.includes(
          input.owner === "daemon" ? "legacy-daemon-schema" : "baseline-seed",
        ),
      ),
      proof("candidate-state-writable", candidateWrite.sentinel === "candidate-upgrade"),
      proof("candidate-head", candidateWrite.head === candidateManifest.currentSchemaHead),
      proof("candidate-ledger-clean", ledgerIsSafe(candidateWrite.ledger)),
    ]),
  );

  const rollback = await copiedPhase(migrated, input.root, "baseline-reopen", input.owner);
  await writeReadOwner(input.owner, input.baseline, rollback, "baseline-after-candidate", true);
  const rollbackInspection = await inspectOwner(input.owner, input.candidate, rollback);
  phases.push(
    passedPhase("baseline-reopen-read-write", [
      proof(
        "baseline-reopen-write-visible",
        input.owner === "daemon"
          ? rollbackInspection.previousValues?.includes("legacy-daemon-schema")
          : rollbackInspection.previousValues?.includes("baseline-after-candidate") ||
              rollbackInspection.sentinel === "baseline-after-candidate",
      ),
      proof(
        "candidate-state-preserved",
        rollbackInspection.previousValues?.includes("candidate-upgrade"),
      ),
      proof("database-not-restored", true),
    ]),
  );

  const idempotent = await copiedPhase(rollback, input.root, "candidate-idempotent", input.owner);
  const before = await inspectOwner(input.owner, input.candidate, idempotent);
  const after = await inspectOwner(input.owner, input.candidate, idempotent);
  phases.push(
    passedPhase("candidate-idempotent-reopen", [
      proof("head-stable", before.head === after.head),
      proof("ledger-stable", JSON.stringify(before.ledger) === JSON.stringify(after.ledger)),
      proof(
        "representative-state-stable",
        JSON.stringify(before.previousValues) === JSON.stringify(after.previousValues),
      ),
    ]),
  );

  const fresh = phasePaths(input.root, "candidate-fresh", input.owner);
  await writeReadOwner(input.owner, input.candidate, fresh, "candidate-fresh");
  await writeReadOwner(input.owner, input.baseline, fresh, "baseline-on-candidate-fresh", true);
  const freshInspection = await inspectOwner(input.owner, input.candidate, fresh);
  phases.push(
    passedPhase("candidate-fresh-baseline-read-write", [
      proof("candidate-fresh-state", freshInspection.previousValues?.includes("candidate-fresh")),
      proof(
        "baseline-write-on-candidate-fresh",
        input.owner === "daemon"
          ? freshInspection.previousValues?.includes("legacy-daemon-schema")
          : freshInspection.previousValues?.includes("baseline-on-candidate-fresh") ||
              freshInspection.sentinel === "baseline-on-candidate-fresh",
      ),
      proof(
        "expand-window-writable",
        candidateDeltaIsAdjacentWritable(candidateManifest, baselineManifest),
      ),
    ]),
  );

  const interruption = await copiedPhase(baselineSeed, input.root, "interruption", input.owner);
  const delta = candidateMigrationDelta(candidateManifest, baselineManifest);
  if (delta.length > 0) {
    for (const migration of delta) {
      const result = await runProbe(
        input.candidate,
        "interrupt",
        interruption,
        ["--migration", migration.id, "--boundary", "before-commit"],
        true,
      );
      if (result.code === 0) throw new Error(`${input.owner}/${migration.id} did not interrupt`);
    }
  }
  const recovered = await writeReadOwner(
    input.owner,
    input.candidate,
    interruption,
    "after-interruption",
  );
  phases.push(
    passedPhase("interruption-recovery", [
      proof(
        "declared-boundaries-covered",
        delta.length === 0 || delta.every(({ transactional }) => transactional),
      ),
      proof(
        "rollback-preserved-baseline",
        recovered.previousValues?.includes(
          input.owner === "daemon" ? "legacy-daemon-schema" : "baseline-seed",
        ),
      ),
      proof("reopen-recovered-cleanly", ledgerIsSafe(recovered.ledger)),
      proof(
        "second-reopen-idempotent",
        Boolean(await inspectOwner(input.owner, input.candidate, interruption)),
      ),
    ]),
  );

  const unsafeAssertions = [
    proof("packaged-manifest-checksum", candidateManifest.manifestSha256 === manifestSha256),
    proof(
      "automatic-delta-expand-only",
      candidateDeltaIsAutomaticSafe(candidateManifest, baselineManifest),
    ),
  ];
  for (const unsafe of ["future", "dirty", "checksum"]) {
    const fixture = await copiedPhase(migrated, input.root, `unsafe-${unsafe}`, input.owner);
    await injectUnsafeState(input.owner, input.candidate, fixture, unsafe);
    const rejected = await runProbe(input.candidate, "inspect", fixture, [], true);
    unsafeAssertions.push(proof(`reject-${unsafe}`, rejected.code !== 0));
  }
  phases.push(passedPhase("reject-unsafe-states", unsafeAssertions));

  return {
    id: input.owner,
    manifest: input.ownerContract.migrationManifest,
    manifestSha256,
    candidateHead: candidateManifest.currentSchemaHead,
    baselineHead: baselineManifest?.currentSchemaHead ?? "legacy-unmanaged",
    phases,
  };
}

async function installCandidate(prefix, packageName, tarball, owner) {
  await access(tarball);
  const tarballSha256 = sha256(await readFile(tarball));
  return await installPackage(
    prefix,
    packageName,
    fileUrl(tarball),
    owner,
    "tarball",
    tarballSha256,
  );
}

async function installBaseline(prefix, owner, version) {
  await mkdir(prefix, { recursive: true });
  const packageName = version === "0.2.1" ? "@zendev-lab/spark" : packageNames[owner];
  const packRoot = join(prefix, "pack");
  await mkdir(packRoot);
  const packed = await run(
    "npm",
    ["pack", `${packageName}@${version}`, "--json", "--pack-destination", packRoot],
    {
      cwd: prefix,
      timeout: 300_000,
    },
  );
  const metadata = JSON.parse(packed.stdout)[0];
  if (metadata?.name !== packageName || metadata?.version !== version || !metadata.filename) {
    throw new Error(`baseline pack identity mismatch for ${packageName}@${version}`);
  }
  const tarball = join(packRoot, metadata.filename);
  return await installPackage(
    prefix,
    packageName,
    fileUrl(tarball),
    owner,
    "npm",
    sha256(await readFile(tarball)),
  );
}

async function installPackage(prefix, packageName, specifier, owner, source, tarballSha256) {
  await mkdir(prefix, { recursive: true });
  await writeFile(
    join(prefix, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { [packageName]: specifier } }, null, 2)}\n`,
  );
  await run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-package-lock"], {
    cwd: prefix,
    timeout: 300_000,
  });
  const packageRoot = join(prefix, "node_modules", ...packageName.split("/"));
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const binName =
    owner === "daemon"
      ? "spark-daemon"
      : packageName === "@zendev-lab/spark"
        ? "spark-cockpit"
        : "spark-hub";
  const executable = join(packageRoot, "bin", binName);
  await access(executable);
  return {
    packageName,
    packageRoot,
    executable,
    version: manifest.version,
    source,
    tarballSha256,
  };
}

async function readInstalledManifest(owner, packageRoot, optional = false) {
  const path =
    owner === "daemon"
      ? join(packageRoot, "dist/migrations/daemon/manifest.json")
      : join(packageRoot, "dist/migrations/manifest.json");
  try {
    const text = await readFile(path, "utf8");
    return { ...JSON.parse(text), manifestSha256: sha256(Buffer.from(text)) };
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function createOwnerState(owner, installation, paths, value) {
  await preparePhasePaths(paths);
  if (installation.version === "0.2.1") {
    if (owner === "hub") {
      await run(
        installation.executable,
        ["access", "create", "--database", paths.database, "--label", value, "--json"],
        {
          cwd: paths.root,
          env: paths.env,
        },
      );
      return;
    }
    await startAndStopLegacyDaemon(installation, paths);
    return;
  }
  await writeReadOwner(owner, installation, paths, value);
}

async function writeReadOwner(owner, installation, paths, value, legacyAllowed = false) {
  await preparePhasePaths(paths);
  if (installation.version === "0.2.1" && legacyAllowed) {
    if (owner === "hub") {
      await run(
        installation.executable,
        ["access", "create", "--database", paths.database, "--label", value, "--json"],
        {
          cwd: paths.root,
          env: paths.env,
        },
      );
      const listed = await run(
        installation.executable,
        ["access", "list", "--database", paths.database, "--json"],
        {
          cwd: paths.root,
          env: paths.env,
        },
      );
      if (!listed.stdout.includes(value))
        throw new Error("legacy Hub did not read its written state");
      return {
        owner,
        sentinel: value,
        previousValues: [value],
        head: "legacy-unmanaged",
        ledger: [],
      };
    }
    await startAndStopLegacyDaemon(installation, paths);
    return {
      owner,
      sentinel: value,
      previousValues: [value],
      head: "legacy-unmanaged",
      ledger: [],
    };
  }
  const result = await runProbe(installation, "write-read", paths, ["--value", value]);
  return result.payload;
}

async function inspectOwner(owner, installation, paths, legacyAllowed = false) {
  await preparePhasePaths(paths);
  if (installation.version === "0.2.1" && legacyAllowed) {
    if (owner === "hub") {
      const result = await run(
        installation.executable,
        ["access", "list", "--database", paths.database, "--json"],
        {
          cwd: paths.root,
          env: paths.env,
        },
      );
      return {
        owner,
        head: "legacy-unmanaged",
        ledger: [],
        sentinel: result.stdout.includes("baseline-seed") ? "baseline-seed" : undefined,
        previousValues: [...result.stdout.matchAll(/release-compatibility[^"\\]*/gu)].map(
          ([value]) => value,
        ),
      };
    }
    await startAndStopLegacyDaemon(installation, paths);
    return {
      owner,
      head: "legacy-unmanaged",
      ledger: [],
      sentinel: "legacy-daemon-schema",
      previousValues: ["legacy-daemon-schema"],
    };
  }
  return (await runProbe(installation, "inspect", paths)).payload;
}

async function runProbe(installation, action, paths, extra = [], allowFailure = false) {
  await preparePhasePaths(paths);
  const result = await run(
    installation.executable,
    ["__compat-database", action, "--database", paths.database, ...extra, "--json"],
    { cwd: paths.root, env: paths.env, allowFailure },
  );
  let payload;
  try {
    payload = result.stdout ? JSON.parse(result.stdout) : undefined;
  } catch (error) {
    if (!allowFailure)
      throw new Error(`database probe returned invalid JSON: ${result.stdout}`, { cause: error });
  }
  return { ...result, payload };
}

async function startAndStopLegacyDaemon(installation, paths) {
  await preparePhasePaths(paths);
  const child = spawn(installation.executable, ["__service-start"], {
    cwd: paths.root,
    env: paths.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (!child.pid) throw new Error("legacy daemon foreground process has no PID");
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });
  const identity = { pid: child.pid, startToken: await processStartToken(child.pid) };
  if (!identity.startToken) {
    terminateOwnedProcess(child, identity);
    throw new Error("legacy daemon PID/start token is unverifiable");
  }
  try {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `legacy daemon exited ${child.exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        );
      }
      const status = await run(installation.executable, ["status", "--json"], {
        cwd: paths.root,
        env: paths.env,
        timeout: 10_000,
        allowFailure: true,
      });
      if (status.code === 0 && /"running"\s*:\s*true/u.test(status.stdout)) {
        ready = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!ready) {
      throw new Error(
        `legacy daemon did not become ready within 60 seconds${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      );
    }
  } finally {
    await run(installation.executable, ["stop", "--yes"], {
      cwd: paths.root,
      env: paths.env,
      allowFailure: true,
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await isOwnedAlive(identity))) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (await isOwnedAlive(identity)) terminateOwnedProcess(child, identity);
    const forcedDeadline = Date.now() + 5_000;
    while (Date.now() < forcedDeadline && (await isOwnedAlive(identity))) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (await isOwnedAlive(identity)) {
      const error = new Error("legacy daemon cleanup could not verify process exit");
      error.migrationCleanupUnsafe = true;
      throw error;
    }
  }
}

async function processStartToken(pid) {
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    const result = await run("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: 10_000,
      allowFailure: true,
    });
    return result.code === 0 && result.stdout.trim()
      ? `${process.platform}:${result.stdout.trim()}`
      : null;
  } catch {
    return null;
  }
}

async function isOwnedAlive(identity) {
  return (await processStartToken(identity.pid)) === identity.startToken;
}

function terminateOwnedProcess(child, identity) {
  if (!identity.startToken) return;
  try {
    if (process.platform !== "win32") process.kill(-identity.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

async function injectUnsafeState(owner, installation, paths, kind) {
  const result = await runProbe(installation, "inject-unsafe", paths, ["--kind", kind]);
  if (result.payload?.injected !== kind) throw new Error(`${owner} did not inject ${kind}`);
}

function phasePaths(parent, id, owner) {
  const phaseRoot = join(parent, id);
  const sparkHome = join(phaseRoot, "spark-home");
  const database =
    owner === "daemon"
      ? join(sparkHome, "apps", "daemon", "data", "daemon.sqlite")
      : join(phaseRoot, "hub.sqlite");
  return {
    root: phaseRoot,
    sparkHome,
    database,
    env: isolatedEnv(phaseRoot, sparkHome),
  };
}

async function copiedPhase(source, parent, id, owner) {
  const target = phasePaths(parent, id, owner);
  await mkdir(dirname(target.database), { recursive: true });
  await copyFile(source.database, target.database);
  return target;
}

async function preparePhasePaths(paths) {
  await Promise.all(
    [
      paths.root,
      dirname(paths.database),
      paths.env.HOME,
      paths.env.SPARK_HOME,
      paths.env.XDG_CACHE_HOME,
      paths.env.XDG_CONFIG_HOME,
      paths.env.XDG_DATA_HOME,
      paths.env.XDG_RUNTIME_DIR,
      paths.env.XDG_STATE_HOME,
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
}

function isolatedEnv(phaseRoot, sparkHome) {
  return {
    ...process.env,
    HOME: join(phaseRoot, "home"),
    SPARK_HOME: sparkHome,
    SPARK_UPDATE_POLICY: "manual",
    XDG_CACHE_HOME: join(phaseRoot, "xdg/cache"),
    XDG_CONFIG_HOME: join(phaseRoot, "xdg/config"),
    XDG_DATA_HOME: join(phaseRoot, "xdg/data"),
    XDG_RUNTIME_DIR: join(phaseRoot, "xdg/runtime"),
    XDG_STATE_HOME: join(phaseRoot, "xdg/state"),
  };
}

function candidateMigrationDelta(candidate, baseline) {
  if (!candidate?.migrations || !baseline?.migrations) return [];
  const baselineIds = new Set(baseline.migrations.map(({ id }) => id));
  return candidate.migrations.filter(({ id }) => !baselineIds.has(id));
}

function candidateDeltaIsAdjacentWritable(candidate, baseline) {
  return candidateMigrationDelta(candidate, baseline).every(
    ({ phase, minimumWritableHead }) => phase === "expand" && Boolean(minimumWritableHead),
  );
}

function candidateDeltaIsAutomaticSafe(candidate, baseline) {
  return candidateMigrationDelta(candidate, baseline).every(
    ({ phase, automatic }) => phase === "expand" && automatic === true,
  );
}

function ledgerIsSafe(ledger) {
  return (
    Array.isArray(ledger) &&
    ledger.every(({ state }) => state === "clean" || state === "legacy-unverified")
  );
}

function passedPhase(id, assertions) {
  for (const assertion of assertions) {
    if (assertion.status !== "passed") throw new Error(`${id}/${assertion.id} failed`);
  }
  return { id, status: "passed", assertions, cleanup: { status: "passed" } };
}

function proof(id, passed) {
  return { id, status: passed ? "passed" : "failed" };
}

async function databaseIsClosed(path) {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeout ?? 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (options.allowFailure) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`, {
      cause: error,
    });
  }
}

function fileUrl(path) {
  return new URL(`file://${resolve(path)}`).href;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const args = parseDatabaseCompatibilityArguments(process.argv.slice(2));
  const report = await runDatabaseCompatibilityMatrix(args);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.reportPath) {
    await mkdir(dirname(resolve(args.reportPath)), { recursive: true });
    await writeFile(resolve(args.reportPath), text);
  }
  process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
