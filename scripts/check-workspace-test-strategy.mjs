#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const strategies = new Set([
  "local-test",
  "browser-test",
  "process-test",
  "boundary-contract",
  "generated-only",
]);
const expectedCounts = {
  "local-test": 30,
  "browser-test": 1,
  "process-test": 1,
  "boundary-contract": 7,
  "generated-only": 1,
};
const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(errors, message) {
  errors.push(message);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function literalPrefix(pattern) {
  const raw = pattern.split(/[?*[{]/u, 1)[0];
  return raw.endsWith("/") ? raw.slice(0, -1) : dirname(raw);
}
function commandIsExecutable(command, root, manifests) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (!/^(?:pnpm|node)\s/u.test(command)) return false;
  const filter = command.match(/pnpm\s+--filter\s+(\S+)/u)?.[1];
  if (filter && !manifests.has(filter)) return false;
  const script = command.match(/pnpm(?:\s+--filter\s+\S+)?\s+(?:run\s+)?([\w:-]+)/u)?.[1];
  if (!script || ["test", "exec"].includes(script)) return true;
  const manifest = filter ? manifests.get(filter) : manifests.get("root");
  return Boolean(manifest?.scripts?.[script]);
}
function workspaceManifests(root, architecture) {
  const manifests = new Map([["root", readJson(join(root, "package.json"))]]);
  for (const [name, meta] of Object.entries(architecture.packages)) {
    const manifestPath = join(root, meta.path, "package.json");
    if (existsSync(manifestPath)) manifests.set(name, readJson(manifestPath));
  }
  return manifests;
}
function validateGate(gate, label, root, manifests, errors) {
  if (!isRecord(gate)) return fail(errors, label + " must be an object");
  if (!commandIsExecutable(gate.command, root, manifests))
    fail(errors, label + ".command is not an executable repository gate");
  if (!Array.isArray(gate.paths) || !gate.paths.length)
    fail(errors, label + ".paths must be non-empty");
  if (!Array.isArray(gate.rules)) fail(errors, label + ".rules must be an array");
  for (const pattern of gate.paths ?? []) {
    if (typeof pattern !== "string" || !pattern.trim()) {
      fail(errors, label + ".paths contains an invalid path");
      continue;
    }
    const prefix = literalPrefix(pattern);
    if (prefix && !existsSync(join(root, prefix)))
      fail(errors, label + ".paths missing prefix: " + prefix);
  }
}
export function validateWorkspaceTestStrategy({ ledger, architecture, root = defaultRoot }) {
  const errors = [];
  if (!isRecord(ledger) || ledger.schemaVersion !== 1)
    fail(errors, "workspace strategy schemaVersion must be 1");
  if (ledger.architectureSource !== "architecture/packages.json")
    fail(errors, "workspace strategy architectureSource is invalid");
  const architectureNames = Object.keys(architecture?.packages ?? {});
  const entries = isRecord(ledger?.workspaces) ? ledger.workspaces : {};
  const ledgerNames = Object.keys(entries);
  for (const name of architectureNames)
    if (!(name in entries)) fail(errors, "unclassified workspace: " + name);
  for (const name of ledgerNames)
    if (!(name in (architecture?.packages ?? {}))) fail(errors, "extra workspace: " + name);
  if (ledger.workspaceCount !== architectureNames.length)
    fail(errors, "workspace strategy count must equal architecture package count");
  const manifests = workspaceManifests(root, architecture);
  const counts = Object.fromEntries([...strategies].map((strategy) => [strategy, 0]));
  for (const [name, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) {
      fail(errors, name + " entry must be an object");
      continue;
    }
    const meta = architecture.packages?.[name];
    if (entry.path !== meta?.path || !existsSync(join(root, entry.path ?? "")))
      fail(errors, name + " path does not match an existing architecture workspace");
    if (!strategies.has(entry.strategy))
      fail(errors, name + " has invalid strategy: " + entry.strategy);
    else counts[entry.strategy] += 1;
    validateGate(entry.primaryGate, name + ".primaryGate", root, manifests, errors);
    if (!Array.isArray(entry.supplementalGates))
      fail(errors, name + ".supplementalGates must be an array");
    else
      entry.supplementalGates.forEach((gate, index) =>
        validateGate(gate, name + ".supplementalGates[" + index + "]", root, manifests, errors),
      );
  }
  for (const [strategy, expected] of Object.entries(expectedCounts)) {
    if (counts[strategy] !== expected || ledger.counts?.[strategy] !== expected)
      fail(errors, strategy + " count must be " + expected);
  }
  const i18n = entries["@zendev-lab/spark-i18n"];
  if (
    i18n?.strategy !== "generated-only" ||
    !i18n.primaryGate?.command?.includes("git diff --exit-code") ||
    !i18n.supplementalGates?.some((gate) => gate.command.includes("run test"))
  )
    fail(
      errors,
      "spark-i18n must use deterministic generated-only strategy with supplemental hand tests",
    );
  if (
    !i18n.supplementalGates?.some(
      (gate) =>
        gate.command.includes("run test") &&
        gate.paths?.includes("packages/spark-i18n/src/cockpit/index.test.ts"),
    )
  )
    fail(errors, "spark-i18n must own the Cockpit catalog test after package consolidation");
  if (entries["@zendev-lab/spark-cockpit-i18n"])
    fail(errors, "retired spark-cockpit-i18n must not remain in the workspace strategy ledger");
  if (entries["@zendev-lab/spark-ui"]?.strategy !== "local-test")
    fail(errors, "spark-ui must remain local-test");
  const cli = entries["@zendev-lab/spark-cli"];
  if (
    cli?.strategy !== "process-test" ||
    cli.primaryGate?.command !== "pnpm run test:process:source" ||
    cli.primaryGate?.paths?.length !== 1 ||
    cli.primaryGate.paths[0] !== "test/process/spark-source-cli.test.ts" ||
    cli.supplementalGates?.length !== 1 ||
    cli.supplementalGates[0]?.command !== "pnpm --filter @zendev-lab/spark-cli run check" ||
    cli.supplementalGates[0]?.paths?.length !== 1 ||
    cli.supplementalGates[0].paths[0] !== "apps/spark-cli/src/**/*.test.ts"
  )
    fail(
      errors,
      "spark-cli must retain its process primary gate and package-local supplemental check",
    );
  const tui = entries["@zendev-lab/spark-tui-app"];
  if (
    tui?.strategy !== "local-test" ||
    tui.primaryGate?.command !== "pnpm --filter @zendev-lab/spark-tui-app run test" ||
    tui.primaryGate?.paths?.length !== 1 ||
    tui.primaryGate.paths[0] !== "apps/spark-tui/src/**/*.test.ts"
  )
    fail(errors, "spark-tui-app must use its package-local check and test path");
  const ownerLocalPackages = [
    "spark-memory",
    "spark-phases",
    "spark-graft",
    "spark-files",
    "spark-workflows",
  ];
  for (const packageId of ownerLocalPackages) {
    const name = "@zendev-lab/" + packageId;
    const entry = entries[name];
    if (
      entry?.strategy !== "local-test" ||
      entry.primaryGate?.command !== "pnpm --filter " + name + " run check" ||
      entry.primaryGate?.paths?.length !== 1 ||
      entry.primaryGate.paths[0] !== "packages/" + packageId + "/src/**/*.test.ts"
    )
      fail(errors, name + " must use its package-local check and test path");
  }
  const runtime = entries["@zendev-lab/spark-runtime"];
  if (
    runtime?.strategy !== "local-test" ||
    runtime.primaryGate?.command !== "pnpm --filter @zendev-lab/spark-runtime run check" ||
    runtime.primaryGate?.paths?.length !== 1 ||
    runtime.primaryGate.paths[0] !== "packages/spark-runtime/src/**/*.test.ts"
  )
    fail(errors, "spark-runtime must use its package-local check and test path");
  const roles = entries["@zendev-lab/spark-roles"];
  if (
    roles?.strategy !== "local-test" ||
    roles.primaryGate?.command !== "pnpm --filter @zendev-lab/spark-roles run check" ||
    roles.primaryGate?.paths?.length !== 1 ||
    roles.primaryGate.paths[0] !== "packages/spark-roles/src/**/*.test.ts" ||
    readdirSync(join(root, "packages/spark-roles/src")).filter((path) => path.endsWith(".test.ts"))
      .length !== 6
  )
    fail(errors, "spark-roles must use its package-local check and test path");
  return {
    ok: errors.length === 0,
    errors,
    counts,
    total: ledgerNames.length,
    unclassified: architectureNames.filter((name) => !(name in entries)).length,
  };
}
export function checkWorkspaceTestStrategy(root = defaultRoot) {
  const result = validateWorkspaceTestStrategy({
    ledger: readJson(join(root, "test/workspace-test-strategy.json")),
    architecture: readJson(join(root, "architecture/packages.json")),
    root,
  });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(checkWorkspaceTestStrategy()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
