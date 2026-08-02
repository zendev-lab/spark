#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dispositions = new Set(["owner-local", "root-integration"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function readBaselinePaths(root = defaultRoot, commit) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit))
    throw new Error("test ownership baselineCommit must be a complete 40-hex commit OID");
  try {
    execFileSync("git", ["cat-file", "-e", commit + "^{commit}"], { cwd: root, stdio: "ignore" });
  } catch {
    throw new Error(`test ownership baselineCommit does not resolve to a commit: ${commit}`);
  }
  const output = execFileSync("git", ["ls-tree", "-r", "--name-only", commit, "test"], {
    cwd: root,
    encoding: "utf8",
  });
  return output
    .split(String.fromCharCode(10))
    .filter((path) => path.endsWith(".test.ts"))
    .sort();
}

function executableGate(command, root, architecture) {
  if (typeof command !== "string" || !command.trim() || !/^pnpm\s/u.test(command)) return false;
  const filter = command.match(/pnpm\s+--filter\s+(\S+)/u)?.[1];
  if (filter) {
    const meta = architecture.packages?.[filter];
    if (!meta) return false;
    const manifest = readJson(join(root, meta.path, "package.json"));
    const script = command.match(/\srun\s+([\w:-]+)/u)?.[1];
    return Boolean(script && manifest.scripts?.[script]);
  }
  const script = command.match(/^pnpm\s+(?:run\s+)?([\w:-]+)/u)?.[1];
  return Boolean(script && readJson(join(root, "package.json")).scripts?.[script]);
}
function deepSourceImports(source) {
  const file = ts.createSourceFile(
    "ownership.test.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports.filter((specifier) =>
    /^(?:\.\.\/)+(?:apps|packages)\/[^/]+\/src(?:\/|$)/u.test(specifier),
  );
}
export function validateTestOwnership({
  ledger,
  architecture,
  root = defaultRoot,
  baselinePaths,
  strict = true,
}) {
  const structuralErrors = [];
  const pendingMigration = [];
  const integrationDeepImports = [];
  const baseline = [...(baselinePaths ?? readBaselinePaths(root, ledger?.baselineCommit))].sort(
    (left, right) => left.localeCompare(right),
  );
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  if (ledger?.schemaVersion !== 2) structuralErrors.push("test ownership schemaVersion must be 2");
  if (typeof ledger?.baselineCommit !== "string" || !/^[0-9a-f]{40}$/u.test(ledger.baselineCommit))
    structuralErrors.push("test ownership baselineCommit must be a complete 40-hex OID");
  if (ledger?.baselineSource !== "origin/main")
    structuralErrors.push("test ownership baselineSource must be origin/main");
  if (ledger?.architectureSource !== "architecture/packages.json")
    structuralErrors.push("test ownership architectureSource is invalid");
  if (ledger?.baselineCount !== 130 || baseline.length !== 130)
    structuralErrors.push("test ownership baseline must contain exactly 130 root tests");
  const baselineCounts = new Map();
  const currentCounts = new Map();
  for (const entry of entries) {
    if (!isRecord(entry)) {
      structuralErrors.push("test ownership entries must be objects");
      continue;
    }
    baselineCounts.set(entry.baselinePath, (baselineCounts.get(entry.baselinePath) ?? 0) + 1);
    currentCounts.set(entry.currentPath, (currentCounts.get(entry.currentPath) ?? 0) + 1);
  }
  for (const path of baseline) {
    const count = baselineCounts.get(path) ?? 0;
    if (count === 0) structuralErrors.push("missing baseline test: " + path);
    if (count > 1) structuralErrors.push("duplicate baseline test: " + path);
  }
  for (const [path, count] of baselineCounts) {
    if (!baseline.includes(path)) structuralErrors.push("extra baseline test: " + path);
    if (count > 1 && !baseline.includes(path))
      structuralErrors.push("duplicate extra baseline test: " + path);
  }
  for (const [path, count] of currentCounts)
    if (count > 1) structuralErrors.push("duplicate currentPath: " + path);
  const counts = { "owner-local": 0, "root-integration": 0 };
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const label = typeof entry.baselinePath === "string" ? entry.baselinePath : "<invalid>";
    if (!dispositions.has(entry.disposition))
      structuralErrors.push(label + " has invalid disposition");
    else counts[entry.disposition] += 1;
    if (
      !Array.isArray(entry.owners) ||
      entry.owners.length === 0 ||
      new Set(entry.owners).size !== entry.owners.length
    ) {
      structuralErrors.push(label + " must declare unique owner workspaces");
      continue;
    }
    for (const owner of entry.owners)
      if (!architecture.packages?.[owner])
        structuralErrors.push(label + " has unknown owner: " + owner);
    if (typeof entry.currentPath !== "string" || !existsSync(join(root, entry.currentPath)))
      structuralErrors.push(label + " currentPath does not exist: " + entry.currentPath);
    if (typeof entry.reason !== "string" || !entry.reason.trim())
      structuralErrors.push(label + " requires a reason");
    if (!executableGate(entry.gate, root, architecture))
      structuralErrors.push(label + " gate is not executable: " + entry.gate);
    if (entry.disposition === "owner-local") {
      if (entry.owners.length !== 1)
        structuralErrors.push(label + " owner-local entries must have exactly one owner");
      const ownerPath = architecture.packages?.[entry.owners[0]]?.path;
      if (ownerPath && !entry.currentPath.startsWith(ownerPath + "/")) {
        pendingMigration.push({
          baselinePath: label,
          currentPath: entry.currentPath,
          owner: entry.owners[0],
        });
      }
    }
    if (entry.disposition === "root-integration") {
      if (!entry.currentPath.startsWith("test/"))
        structuralErrors.push(label + " root-integration currentPath must remain under test/");
      if (entry.owners.length < 2)
        structuralErrors.push(label + " root-integration requires at least two owners");
      if (typeof entry.currentPath === "string" && existsSync(join(root, entry.currentPath))) {
        const imports = deepSourceImports(readFileSync(join(root, entry.currentPath), "utf8"));
        if (imports.length > 0)
          integrationDeepImports.push({
            baselinePath: label,
            currentPath: entry.currentPath,
            imports,
          });
      }
    }
  }
  const strictErrors = [
    ...structuralErrors,
    ...pendingMigration.map(
      (debt) => debt.baselinePath + " owner-local test is still at " + debt.currentPath,
    ),
    ...integrationDeepImports.map(
      (debt) =>
        debt.baselinePath +
        " root integration uses deep source imports: " +
        debt.imports.join(", "),
    ),
  ];
  return {
    ok: strict ? strictErrors.length === 0 : structuralErrors.length === 0,
    strictOk: strictErrors.length === 0,
    errors: strict ? strictErrors : structuralErrors,
    structuralErrors,
    counts,
    total: entries.length,
    baselineTotal: baseline.length,
    pending: { migrations: pendingMigration, integrationDeepImports },
    pendingCount: pendingMigration.length + integrationDeepImports.length,
  };
}
export function checkTestOwnership(root = defaultRoot, { strict = true } = {}) {
  return validateTestOwnership({
    ledger: readJson(join(root, "test/test-ownership.json")),
    architecture: readJson(join(root, "architecture/packages.json")),
    root,
    strict,
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = process.argv.includes("--report");
  try {
    const result = checkTestOwnership(defaultRoot, { strict: !report });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
