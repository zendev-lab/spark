#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const statuses = new Set(["included", "deferred"]);
const risks = new Set(["low", "medium", "high"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walk(path, root = path, output = []) {
  if (!existsSync(path)) return output;
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, root, output);
    else output.push(relative(root, full).replaceAll("\\", "/"));
  }
  return output;
}

function globRegex(pattern) {
  const escaped = [...pattern]
    .map((char) => (".+^$()|[]\\".includes(char) ? "\\" + char : char))
    .join("")
    .replaceAll("**/", "\u0001")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0001", "(?:.*/)?")
    .replaceAll("\u0000", ".*");
  return new RegExp("^" + escaped + "$", "u");
}

function mutationFilePattern(pattern) {
  return pattern.replace(/:\d+(?::\d+)?-\d+(?::\d+)?$/u, "");
}

function packageRelativeMutationPattern(pattern, packagePath) {
  const filePattern = mutationFilePattern(pattern);
  const packagePrefix = `${packagePath}/`;
  return filePattern.startsWith(packagePrefix)
    ? filePattern.slice(packagePrefix.length)
    : filePattern;
}

function executableGate(command, manifests) {
  if (typeof command !== "string" || !/^(?:pnpm|node)\s/u.test(command)) return false;
  if (/^pnpm(?:\s+--(?:filter|dir)\s+\S+)*\s+exec\s+/u.test(command)) return true;
  const filter = command.match(/pnpm\s+--filter\s+(\S+)/u)?.[1];
  if (filter && !manifests.has(filter)) return false;
  const script = command.match(/pnpm(?:\s+--(?:filter|dir)\s+\S+)*\s+(?:run\s+)?([\w:-]+)/u)?.[1];
  if (!script || ["test", "exec"].includes(script)) return true;
  return Boolean((filter ? manifests.get(filter) : manifests.get("root"))?.scripts?.[script]);
}

function manifests(root, architecture) {
  const map = new Map([["root", readJson(join(root, "package.json"))]]);
  for (const [name, meta] of Object.entries(architecture.packages))
    map.set(name, readJson(join(root, meta.path, "package.json")));
  return map;
}

function defaultMutationCommand(name) {
  return `pnpm --filter ${name} exec stryker run`;
}

export function validateMutationOwnership({
  ledger,
  architecture,
  root = defaultRoot,
  runnerSource,
}) {
  const errors = [];
  const entries = isRecord(ledger?.workspaces) ? ledger.workspaces : {};
  const architectureNames = Object.keys(architecture?.packages ?? {});
  if (ledger?.schemaVersion !== 1) errors.push("mutation ownership schemaVersion must be 1");
  if (ledger?.architectureSource !== "architecture/packages.json")
    errors.push("mutation architectureSource is invalid");
  if (!Number.isInteger(ledger?.minimumIncludedCount) || ledger.minimumIncludedCount < 0)
    errors.push("mutation minimumIncludedCount must be a non-negative integer");
  for (const name of architectureNames)
    if (!(name in entries)) errors.push("unclassified mutation workspace: " + name);
  for (const name of Object.keys(entries))
    if (!(name in architecture.packages)) errors.push("extra mutation workspace: " + name);

  const counts = { included: 0, deferred: 0 };
  const packageManifests = manifests(root, architecture);
  for (const [name, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) {
      errors.push(name + " entry must be an object");
      continue;
    }
    if (
      entry.path !== architecture.packages?.[name]?.path ||
      !existsSync(join(root, entry.path ?? ""))
    )
      errors.push(name + " path is invalid");
    if (!statuses.has(entry.status)) errors.push(name + " has invalid mutation status");
    else counts[entry.status] += 1;
    if (!risks.has(entry.risk) || typeof entry.riskReason !== "string" || !entry.riskReason.trim())
      errors.push(name + " requires risk and riskReason");
    if (!executableGate(entry.alternateGate, packageManifests))
      errors.push(name + " alternateGate is not executable");

    if (entry.status === "included") {
      const mutationCommand = entry.command ?? defaultMutationCommand(name);
      if (!executableGate(mutationCommand, packageManifests))
        errors.push(name + " mutation command is not executable");
      const configPath = join(root, entry.config ?? "");
      if (!existsSync(configPath)) {
        errors.push(name + " is missing Stryker config");
        continue;
      }
      const config = readJson(configPath);
      if (config.testRunner !== "vitest" || !Array.isArray(config.mutate) || !config.mutate.length)
        errors.push(name + " Stryker config must use Vitest with explicit mutate paths");
      const packageRoot = join(root, entry.path);
      const files = walk(join(packageRoot, "src"), packageRoot);
      const positiveMutate = (config.mutate ?? []).filter((value) => !value.startsWith("!"));
      if (
        !positiveMutate.some((pattern) =>
          files.some((file) =>
            globRegex(packageRelativeMutationPattern(pattern, entry.path)).test(file),
          ),
        )
      )
        errors.push(name + " mutate paths match no workspace files");
      for (const pattern of positiveMutate)
        if (!packageRelativeMutationPattern(pattern, entry.path).startsWith("src/"))
          errors.push(name + " mutate path must stay under src/: " + pattern);
      if (
        name === "@zendev-lab/spark-i18n" &&
        (config.mutate ?? []).some((pattern) => pattern.includes("paraglide"))
      )
        errors.push("spark-i18n mutation must exclude generated paraglide output");
    } else {
      if ("config" in entry)
        errors.push(name + " deferred entry must not declare a Stryker config");
      if ("command" in entry)
        errors.push(name + " deferred entry must not declare a mutation command");
    }
  }

  if (
    ledger.workspaceCount !== architectureNames.length ||
    Object.keys(entries).length !== architectureNames.length
  )
    errors.push("mutation workspace count must equal architecture package count");
  if (ledger.includedCount !== counts.included)
    errors.push("included mutation count must match classified included workspaces");
  if (counts.included < (ledger.minimumIncludedCount ?? 0))
    errors.push("included mutation count is below minimumIncludedCount");
  const expectedDeferredCount = architectureNames.length - counts.included;
  if (ledger.deferredCount !== expectedDeferredCount || counts.deferred !== expectedDeferredCount)
    errors.push("deferred mutation count must match non-included architecture packages");

  const source = runnerSource ?? readFileSync(join(root, ledger.runner ?? ""), "utf8");
  if (!source.includes("loadMutationLedger") || /const\s+packages\s*=\s*\[/u.test(source))
    errors.push(
      "mutation runner must derive packages from the ownership ledger without a third list",
    );
  return {
    ok: errors.length === 0,
    errors,
    counts,
    total: Object.keys(entries).length,
    unclassified: architectureNames.filter((name) => !(name in entries)).length,
  };
}

export function loadMutationLedger(root = defaultRoot) {
  const ledger = readJson(join(root, "test/mutation-ce-ownership.json"));
  const architecture = readJson(join(root, "architecture/packages.json"));
  const result = validateMutationOwnership({ ledger, architecture, root });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  const includedEntries = Object.entries(ledger.workspaces)
    .filter(([, entry]) => entry.status === "included")
    .map(([name, entry]) => ({
      name,
      command: entry.command ?? defaultMutationCommand(name),
    }));
  return {
    ledger,
    result,
    includedEntries,
    includedPackageIds: includedEntries.map((entry) => entry.name),
  };
}

export function checkMutationOwnership(root = defaultRoot) {
  return loadMutationLedger(root).result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(checkMutationOwnership()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
