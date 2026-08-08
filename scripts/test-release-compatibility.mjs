#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { deriveCombinedCompatibilityReport } from "./release-compatibility-report.mjs";
import { loadAndValidateReleaseCompatibility } from "./validate-release-compatibility.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseReleaseCompatibilityArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "baseline-version": { type: "string" },
      tarball: { type: "string" },
      "cli-tarball": { type: "string" },
      "daemon-tarball": { type: "string" },
      "hub-tarball": { type: "string" },
      "tui-tarball": { type: "string" },
    },
    strict: true,
  });
  for (const name of ["tarball", "cli-tarball", "daemon-tarball", "hub-tarball", "tui-tarball"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  return {
    ...(values["baseline-version"] ? { baselineVersion: values["baseline-version"] } : {}),
    tarball: values.tarball,
    cliTarball: values["cli-tarball"],
    daemonTarball: values["daemon-tarball"],
    hubTarball: values["hub-tarball"],
    tuiTarball: values["tui-tarball"],
  };
}

export function selectRequiredBaseline(contract, candidateVersion, publishedVersions, explicit) {
  if (candidateVersion === contract.firstSplitRelease) {
    const baseline = contract.releaseGate.firstSplitReleaseException.baselineVersion;
    if (explicit && explicit !== baseline) {
      throw new Error(
        `The first split release baseline is fixed at ${baseline}; received ${explicit}.`,
      );
    }
    return baseline;
  }
  const stable = publishedVersions
    .filter((version) => /^\d+\.\d+\.\d+$/u.test(version))
    .filter((version) => compareVersions(version, candidateVersion) < 0)
    .sort(compareVersions);
  const baseline = stable.at(-1);
  if (!baseline) throw new Error(`No published stable baseline exists before ${candidateVersion}.`);
  if (baseline === contract.releaseGate.firstSplitReleaseException.baselineVersion) {
    throw new Error(
      `Candidate ${candidateVersion} requires a published split-product baseline; legacy ${baseline} is invalid.`,
    );
  }
  if (explicit && explicit !== baseline) {
    throw new Error(
      `Explicit baseline ${explicit} is not the newest published stable baseline ${baseline}.`,
    );
  }
  return baseline;
}

export async function runReleaseCompatibilityGate(input, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const npmVersions = dependencies.npmVersions ?? publishedVersions;
  const contract = dependencies.contract ?? (await loadAndValidateReleaseCompatibility(root));
  const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const candidateVersion = packageManifest.version;
  if (!/^\d+\.\d+\.\d+$/u.test(candidateVersion)) {
    throw new Error(
      `Release compatibility requires a stable candidate version: ${candidateVersion}`,
    );
  }
  const baselineVersion = selectRequiredBaseline(
    contract,
    candidateVersion,
    await npmVersions(),
    input.baselineVersion,
  );
  const productReportPath = resolve(root, contract.releaseGate.reportPath);
  const databaseReportPath = resolve(root, contract.database.reportPath);
  const combinedReportPath = resolve(root, "dist/release/release-compatibility.json");
  await mkdir(dirname(productReportPath), { recursive: true });

  await run(
    contract.releaseGate.productHarness,
    [
      "--candidate-hub-tarball",
      resolve(root, input.hubTarball),
      "--candidate-daemon-tarball",
      resolve(root, input.daemonTarball),
      "--candidate-tui-tarball",
      resolve(root, input.tuiTarball),
      "--baseline-version",
      baselineVersion,
      "--report",
      productReportPath,
    ],
    { cwd: root },
  );

  await run(
    contract.database.harness,
    [
      "--candidate-daemon-tarball",
      resolve(root, input.daemonTarball),
      "--candidate-hub-tarball",
      resolve(root, input.hubTarball),
      "--baseline-version",
      baselineVersion,
      "--report",
      databaseReportPath,
    ],
    { cwd: root },
  );

  await run(
    "scripts/test-release-migration.mjs",
    [
      "--tarball",
      resolve(root, input.tarball),
      "--cli-tarball",
      resolve(root, input.cliTarball),
      "--daemon-tarball",
      resolve(root, input.daemonTarball),
      "--hub-tarball",
      resolve(root, input.hubTarball),
      "--tui-tarball",
      resolve(root, input.tuiTarball),
      "--baseline-version",
      baselineVersion,
    ],
    { cwd: root },
  );

  const [productReport, databaseReport] = await Promise.all([
    readJson(productReportPath),
    readJson(databaseReportPath),
  ]);
  const combined = deriveCombinedCompatibilityReport(contract, productReport, databaseReport);
  await writeFile(combinedReportPath, `${JSON.stringify(combined, null, 2)}\n`);
  return combined;
}

async function publishedVersions() {
  const result = await execFileAsync("npm", ["view", "@zendev-lab/spark", "versions", "--json"], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function runCommand(script, args, options) {
  await execFileAsync(process.execPath, [resolve(root, script), ...args], {
    cwd: options.cwd,
    env: process.env,
    timeout: 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseReleaseCompatibilityArguments(process.argv.slice(2));
  const report = await runReleaseCompatibilityGate(args);
  console.log(
    `Adjacent release compatibility passed: ${report.baselineVersion} <-> ${report.candidateVersion}.`,
  );
}
