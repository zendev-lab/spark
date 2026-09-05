import { builtinModules } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import ts from "typescript";

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function packageName(specifier) {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    builtins.has(specifier)
  ) {
    return undefined;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function literalSpecifier(node) {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function importedSpecifiers(source) {
  const specifiers = new Set();
  const file = ts.createSourceFile("product.js", source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier && literalSpecifier(node.moduleSpecifier);
      if (specifier) specifiers.add(specifier);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const specifier = node.arguments[0] && literalSpecifier(node.arguments[0]);
        if (specifier) specifiers.add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

async function filesBelow(directory, predicate) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path, predicate)));
    else if (entry.isFile() && predicate(entry.name)) files.push(path);
  }
  return files;
}

export async function discoverProductRuntimePackages(productDirectory) {
  const packages = new Set();
  for (const file of await filesBelow(productDirectory, (name) => name.endsWith(".js"))) {
    for (const specifier of importedSpecifiers(await readFile(file, "utf8"))) {
      const name = packageName(specifier);
      if (name) packages.add(name);
    }
  }
  return [...packages].sort((left, right) => left.localeCompare(right));
}

async function workspaceManifestPaths(root) {
  const paths = [join(root, "package.json")];
  for (const workspaceRoot of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, workspaceRoot), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(root, workspaceRoot, entry.name, "package.json"));
    }
  }
  return paths;
}

async function runtimeDependencyOwners(root) {
  const owners = new Map();
  for (const path of await workspaceManifestPaths(root)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const [name, range] of Object.entries(dependencies)) {
      if (String(range).startsWith("workspace:")) continue;
      const directories = owners.get(name) ?? [];
      directories.push(dirname(path));
      owners.set(name, directories);
    }
  }
  return owners;
}

export async function resolveProductRuntimeDependencies(
  root,
  productDirectory,
  exactWorkspacePackages = [],
  declaredRuntimePackages = [],
) {
  const owners = await runtimeDependencyOwners(root);
  const dependencies = {};
  const exactWorkspacePackageSet = new Set(exactWorkspacePackages);
  const runtimePackages = new Set([
    ...(await discoverProductRuntimePackages(productDirectory)),
    ...declaredRuntimePackages,
  ]);
  for (const name of [...runtimePackages].sort((left, right) => left.localeCompare(right))) {
    if (exactWorkspacePackageSet.has(name)) continue;
    const directories = owners.get(name);
    if (!directories?.length) {
      throw new Error(`Published runtime package ${name} is not a workspace runtime dependency`);
    }
    const versions = new Set();
    for (const directory of directories) {
      const installedManifest = JSON.parse(
        await readFile(join(directory, "node_modules", name, "package.json"), "utf8"),
      );
      if (installedManifest.name !== name || !installedManifest.version) {
        throw new Error(`Unable to resolve installed runtime dependency ${name}`);
      }
      versions.add(installedManifest.version);
    }
    if (versions.size !== 1) {
      throw new Error(`Published runtime package ${name} resolves to ${[...versions].join(", ")}`);
    }
    dependencies[name] = [...versions][0];
  }
  return dependencies;
}
