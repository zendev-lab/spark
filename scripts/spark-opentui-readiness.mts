#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_NODE = Object.freeze({ major: 26, minor: 4, patch: 0 });

export interface OpenTuiReadinessInput {
  nodeVersion: string;
  ffiFlagSupported: boolean;
  ffiFlagActive: boolean;
  packageInstalled: boolean;
  productionDependency: boolean;
  launcherCarriesFfiFlag: boolean;
  nativeArtifactMatrixVerified: boolean;
  ptyContractVerified: boolean;
}

export interface OpenTuiReadinessReport {
  renderer: "opentui";
  ready: boolean;
  productionDependencyAllowed: boolean;
  requiredNode: ">=26.4.0 <27";
  observed: OpenTuiReadinessInput;
  failedGates: string[];
  decision: string;
}

export function evaluateOpenTuiReadiness(input: OpenTuiReadinessInput): OpenTuiReadinessReport {
  const failedGates: string[] = [];
  if (!nodeAtLeast(input.nodeVersion, REQUIRED_NODE)) {
    failedGates.push(`node_runtime:${input.nodeVersion}`);
  }
  if (!input.ffiFlagSupported) failedGates.push("experimental_ffi_unsupported");
  if (!input.ffiFlagActive) failedGates.push("launcher_missing_experimental_ffi");
  if (!input.packageInstalled) failedGates.push("opentui_not_installed");
  if (input.productionDependency) failedGates.push("premature_production_dependency");
  if (!input.launcherCarriesFfiFlag) failedGates.push("launcher_not_verified");
  if (!input.nativeArtifactMatrixVerified) failedGates.push("native_artifact_matrix_unverified");
  if (!input.ptyContractVerified) failedGates.push("pty_contract_unverified");
  const ready = failedGates.length === 0;
  return {
    renderer: "opentui",
    ready,
    productionDependencyAllowed: ready,
    requiredNode: ">=26.4.0 <27",
    observed: input,
    failedGates,
    decision: ready
      ? "Submit a separate renderer architecture decision with the captured release and PTY evidence."
      : "Keep the Pi renderer behind SparkTerminalController; do not raise Node or add OpenTUI to production dependencies.",
  };
}

export function inspectOpenTuiReadiness(root = repositoryRoot()): OpenTuiReadinessReport {
  const rootManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const require = createRequire(import.meta.url);
  let packageInstalled = false;
  try {
    require.resolve("@opentui/core/package.json", { paths: [root] });
    packageInstalled = true;
  } catch {
    packageInstalled = false;
  }
  const productionDependency = Boolean(
    rootManifest.dependencies?.["@opentui/core"] ??
    rootManifest.optionalDependencies?.["@opentui/core"],
  );
  const launcherCarriesFfiFlag =
    existsSync(resolve(root, "apps/spark-tui/bin/spark-tui")) &&
    readFileSync(resolve(root, "apps/spark-tui/bin/spark-tui"), "utf8").includes(
      "--experimental-ffi",
    );
  const ptyContractVerified =
    process.env.SPARK_OPENTUI_PTY_EVIDENCE === "verified" &&
    existsSync(resolve(root, "scripts/spark-zellij-harness.mts"));
  return evaluateOpenTuiReadiness({
    nodeVersion: process.versions.node,
    ffiFlagSupported: process.allowedNodeEnvironmentFlags.has("--experimental-ffi"),
    ffiFlagActive: process.execArgv.includes("--experimental-ffi"),
    packageInstalled,
    productionDependency,
    launcherCarriesFfiFlag,
    nativeArtifactMatrixVerified: process.env.SPARK_OPENTUI_NATIVE_ARTIFACTS === "verified",
    ptyContractVerified,
  });
}

function nodeAtLeast(
  version: string,
  minimum: { major: number; minor: number; patch: number },
): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (major !== minimum.major) return major > minimum.major;
  if (minor !== minimum.minor) return minor > minimum.minor;
  return patch >= minimum.patch;
}

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === import.meta.url);
}

if (isMainModule()) {
  const report = inspectOpenTuiReadiness();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--require-ready") && !report.ready) process.exitCode = 1;
}
