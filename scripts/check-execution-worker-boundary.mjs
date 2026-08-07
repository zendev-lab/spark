#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultEntry = "apps/spark-daemon/src/execution/worker-entry.ts";
const entry = canonicalPath(resolve(root, process.argv[2] ?? defaultEntry));
const contract = canonicalPath(resolve(root, "apps/spark-daemon/src/execution/contract.ts"));
const workerLocalRoot = canonicalPath(resolve(dirname(entry), "worker"));
const allowedPackages = [
  "@zendev-lab/spark-host",
  "@zendev-lab/spark-protocol",
  "@zendev-lab/spark-turn",
];
const visited = new Set();
const violations = [];
let importCount = 0;

await visit(entry);

if (violations.length > 0) {
  process.stderr.write(
    `Execution worker boundary failed for ${displayPath(entry)}:\n${violations
      .map(
        ({ importer, specifier, reason }) =>
          `- forbidden import: ${specifier} (${reason}; imported by ${displayPath(importer)})`,
      )
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Execution worker boundary passed for ${displayPath(entry)} ` +
      `(${visited.size} file${visited.size === 1 ? "" : "s"}, ${importCount} static import${importCount === 1 ? "" : "s"}).\n`,
  );
}

async function visit(file) {
  const canonical = canonicalPath(file);
  if (visited.has(canonical)) return;
  visited.add(canonical);

  let source;
  try {
    source = await readFile(canonical, "utf8");
  } catch {
    violations.push({
      importer: canonical,
      specifier: displayPath(canonical),
      reason: "worker-local import cannot be resolved",
    });
    return;
  }

  const sourceFile = ts.createSourceFile(
    canonical,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(canonical),
  );
  for (const imported of staticImports(sourceFile)) {
    importCount += 1;
    if (imported.invalid) {
      violations.push({
        importer: canonical,
        specifier: imported.specifier,
        reason: "dynamic module specifier is not statically auditable",
      });
      continue;
    }
    const specifier = imported.specifier;
    if (allowedPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
      continue;
    }
    if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
      violations.push({
        importer: canonical,
        specifier,
        reason: "package or runtime is outside the host/turn/protocol allowlist",
      });
      continue;
    }

    const target = resolveLocalImport(canonical, specifier);
    if (!target) {
      violations.push({
        importer: canonical,
        specifier,
        reason: "local import cannot be resolved",
      });
      continue;
    }
    if (target !== contract && !isWithin(workerLocalRoot, target)) {
      violations.push({
        importer: canonical,
        specifier,
        reason: `resolved path ${displayPath(target)} is outside contract.ts and worker-local modules`,
      });
      continue;
    }
    await visit(target);
  }
}

function staticImports(sourceFile) {
  const specifiers = [];
  const collect = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push({ specifier: node.moduleSpecifier.text, invalid: false });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push({ specifier: node.moduleReference.expression.text, invalid: false });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      if (node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
        specifiers.push({ specifier: node.arguments[0].text, invalid: false });
      } else {
        specifiers.push({ specifier: "<dynamic module specifier>", invalid: true });
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  return specifiers;
}

function resolveLocalImport(importer, specifier) {
  const base = canonicalPath(
    isAbsolute(specifier) ? specifier : resolve(dirname(importer), specifier),
  );
  const candidates = extname(base)
    ? [base]
    : [
        base,
        ...[".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((extension) => `${base}${extension}`),
        ...[".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((extension) =>
          resolve(base, `index${extension}`),
        ),
      ];
  const match = candidates.find((candidate) => existsSync(candidate));
  return match ? canonicalPath(match) : undefined;
}

function canonicalPath(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function displayPath(path) {
  const display = relative(root, path);
  return display || ".";
}

function scriptKind(path) {
  switch (extname(path)) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}
