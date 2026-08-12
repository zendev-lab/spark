import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findSparkProtocolRootReferences,
  isSparkProductionSourcePath,
  sparkProtocolSubpathBoundaryViolations,
} from "./spark-protocol-governance.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const architecture = readJson(join(root, "architecture/packages.json"));

function runArchitectureRatchets() {
  const failures = [];
  const workspacePackages = ["apps", "packages"].flatMap((workspaceDir) =>
    readdirSync(join(root, workspaceDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => isFile(join(root, workspaceDir, entry.name, "package.json")))
      .map((entry) => {
        const path = `${workspaceDir}/${entry.name}`;
        return { path, manifest: readJson(join(root, path, "package.json")) };
      }),
  );
  const workspaceByName = new Map(
    workspacePackages.map((workspacePackage) => [workspacePackage.manifest.name, workspacePackage]),
  );
  const declaredPackages = architecture.packages ?? {};

  for (const { path, manifest } of workspacePackages) {
    const declaration = declaredPackages[manifest.name];
    if (!declaration) {
      failures.push(`${path} (${manifest.name}) is missing from architecture/packages.json.`);
      continue;
    }
    if (declaration.path !== path) {
      failures.push(
        `${manifest.name} is declared at ${declaration.path}, but its manifest is at ${path}.`,
      );
    }
    const declaredRuntimeDependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const workspaceRuntimeDependencies = [...declaredRuntimeDependencies].filter((dependency) =>
      workspaceByName.has(dependency),
    );
    if (declaration.allowedWorkspaceDependencies) {
      const allowed = new Set(declaration.allowedWorkspaceDependencies);
      for (const dependency of workspaceRuntimeDependencies) {
        if (!allowed.has(dependency)) {
          failures.push(
            `${manifest.name} may depend only on [${[...allowed].join(", ")}], but declares ${dependency}.`,
          );
        }
      }
    }

    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target !== "string" || !target.startsWith("./")) continue;
      if (!isFile(join(root, path, target))) {
        failures.push(`${manifest.name} export ${subpath} points to missing file ${target}.`);
      }
    }

    if (path.startsWith("packages/")) {
      const policyViolations = workspacePackagePolicyViolations({
        manifest,
        hasTests: workspaceContainsTests(join(root, path)),
        hasStrykerConfig: isFile(join(root, path, "stryker.config.json")),
      });
      for (const violation of policyViolations) failures.push(`${path} ${violation}.`);
    }
  }

  for (const [name, declaration] of Object.entries(declaredPackages)) {
    const workspacePackage = workspaceByName.get(name);
    if (!workspacePackage) {
      failures.push(
        `architecture/packages.json declares removed or missing package ${name} at ${declaration.path}.`,
      );
    }
  }

  checkSparkProtocolRootImportCeiling(failures);

  if (failures.length > 0) {
    console.error(
      ["Architecture ratchet failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"),
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Architecture inventory passed (${workspacePackages.length} workspaces classified; declared dependency boundaries, exports, workspace test discovery, and mutation ownership verified).`,
    );
  }
}

function workspacePackagePolicyViolations({ manifest, hasTests, hasStrykerConfig }) {
  const violations = [];
  if (hasTests && !manifest.scripts?.test) violations.push("must expose package-local tests");

  const hasMutationOwnership =
    hasStrykerConfig || manifest.scripts?.["test:mutation"] !== undefined;
  if (!hasMutationOwnership) return violations;

  if (manifest.scripts?.["test:mutation"] === undefined) {
    violations.push("mutation package must expose test:mutation");
  } else if (manifest.scripts["test:mutation"] !== "stryker run") {
    violations.push("mutation command must be stryker run");
  }
  if (manifest.devDependencies?.["@stryker-mutator/core"] !== "catalog:") {
    violations.push("mutation core dependency must use catalog:");
  }
  if (manifest.devDependencies?.["@stryker-mutator/vitest-runner"] !== "catalog:") {
    violations.push("mutation runner dependency must use catalog:");
  }
  if (!hasStrykerConfig) violations.push("mutation package must include stryker.config.json");
  return violations;
}

function workspaceContainsTests(directory) {
  let found = false;
  visit(directory, (path) => {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) found = true;
  });
  return found;
}

function visit(directory, inspect) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", ".svelte-kit", "coverage"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path, inspect);
    else if (entry.isFile()) inspect(path);
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${path}`, { cause: error });
  }
}

function checkSparkProtocolRootImportCeiling(failures) {
  const allowlistPath = join(root, "test/fixtures/spark-protocol-root-imports.json");
  if (!isFile(allowlistPath)) {
    failures.push("missing test/fixtures/spark-protocol-root-imports.json");
    return;
  }
  const allowlist = readJson(allowlistPath);
  const requiredSubpaths = allowlist.requiredSubpaths ?? [];
  const protocolPackage = readJson(join(root, "packages/spark-protocol/package.json"));
  for (const subpath of requiredSubpaths) {
    const target = protocolPackage.exports?.[`./${subpath}`];
    if (typeof target !== "string") {
      failures.push(`@zendev-lab/spark-protocol is missing required export ./${subpath}`);
      continue;
    }
    if (!isFile(join(root, "packages/spark-protocol", target))) {
      failures.push(`@zendev-lab/spark-protocol export ./${subpath} points to missing ${target}`);
    }
  }
  let productionRootImportCount = 0;
  for (const workspaceDir of ["apps", "packages"]) {
    visit(join(root, workspaceDir), (sourcePath) => {
      if (!isSparkProductionSourcePath(sourcePath)) return;
      const references = findSparkProtocolRootReferences(
        readFileSync(sourcePath, "utf8"),
        sourcePath,
      );
      if (references.length === 0) return;
      productionRootImportCount += references.length;
      failures.push(
        `${relative(root, sourcePath).replaceAll("\\", "/")} references @zendev-lab/spark-protocol root barrel (${references.map((reference) => reference.kind).join(", ")}); use domain/daemon/runtime/interaction/presentation subpaths`,
      );
    });
  }
  const ceiling = allowlist.productionRootImportCeiling;
  const importBaseline = allowlist.migrationBaselineProductionRootImportCount;
  if (typeof ceiling !== "number") {
    failures.push("spark-protocol root import allowlist is missing productionRootImportCeiling");
  } else if (productionRootImportCount > ceiling) {
    failures.push(
      `spark-protocol production root imports ${productionRootImportCount} exceed ceiling ${ceiling}`,
    );
  } else if (productionRootImportCount < ceiling) {
    failures.push(
      `spark-protocol production root import ceiling is stale: lower ${ceiling} to ${productionRootImportCount}`,
    );
  }
  if (!Number.isSafeInteger(importBaseline) || importBaseline <= ceiling) {
    failures.push(
      `spark-protocol root import ceiling ${ceiling} must remain below migration baseline ${importBaseline}`,
    );
  }

  for (const subpath of ["domain", "presentation", "runtime"]) {
    const source = readFileSync(join(root, `packages/spark-protocol/src/${subpath}.ts`), "utf8");
    for (const violation of sparkProtocolSubpathBoundaryViolations(subpath, source)) {
      failures.push(`spark-protocol ${violation}`);
    }
  }

  const rootIndexPath = join(root, "packages/spark-protocol/src/index.ts");
  const rootIndex = readFileSync(rootIndexPath, "utf8");
  const rootExports = [...rootIndex.matchAll(/^export\s+\*\s+from\s+["']([^"']+)["'];?$/gmu)].map(
    (match) => match[1],
  );
  const allowedRootExports = new Set(allowlist.rootBarrelModules ?? []);
  for (const module of rootExports) {
    if (!allowedRootExports.has(module)) {
      failures.push(`spark-protocol root barrel exports unapproved module ${module}`);
    }
  }
  for (const module of allowedRootExports) {
    if (!rootExports.includes(module)) {
      failures.push(`spark-protocol root barrel module ceiling is stale: ${module} can be removed`);
    }
  }

  const rootExportNames = typeScriptModuleExportNames(rootIndexPath);
  const rootExportCount = rootExportNames.length;
  const rootExportDigest = symbolDigest(rootExportNames);
  const rootExportCeiling = allowlist.rootBarrelExportCeiling;
  const migrationBaseline = allowlist.migrationBaselineRootExportCount;
  if (!Number.isSafeInteger(rootExportCeiling) || rootExportCeiling < 0) {
    failures.push("spark-protocol root import allowlist is missing rootBarrelExportCeiling");
  } else if (rootExportCount > rootExportCeiling) {
    failures.push(
      `spark-protocol root public exports ${rootExportCount} exceed ceiling ${rootExportCeiling}`,
    );
  } else if (rootExportCount < rootExportCeiling) {
    failures.push(
      `spark-protocol root public export ceiling is stale: lower ${rootExportCeiling} to ${rootExportCount}`,
    );
  }
  if (!Number.isSafeInteger(migrationBaseline) || migrationBaseline <= rootExportCeiling) {
    failures.push(
      `spark-protocol root public export ceiling ${rootExportCeiling} must remain below migration baseline ${migrationBaseline}`,
    );
  }
  if (allowlist.rootBarrelExportDigest !== rootExportDigest) {
    failures.push(
      `spark-protocol root public export digest changed: expected ${allowlist.rootBarrelExportDigest}, received ${rootExportDigest}`,
    );
  }

  const subpathExportOwners = new Map();
  for (const subpath of requiredSubpaths) {
    const names = typeScriptModuleExportNames(
      join(root, `packages/spark-protocol/src/${subpath}.ts`),
    );
    const digest = symbolDigest(names);
    if (allowlist.subpathExportDigests?.[subpath] !== digest) {
      failures.push(
        `spark-protocol ${subpath} public export digest changed: expected ${allowlist.subpathExportDigests?.[subpath]}, received ${digest}`,
      );
    }
    for (const name of names) {
      const owners = subpathExportOwners.get(name) ?? [];
      owners.push(subpath);
      subpathExportOwners.set(name, owners);
    }
  }
  for (const [name, owners] of subpathExportOwners) {
    if (owners.length > 1) {
      failures.push(
        `spark-protocol public symbol ${name} has multiple domain owners: ${owners.join(", ")}`,
      );
    }
  }
}

function typeScriptModuleExportNames(entryPath) {
  const program = ts.createProgram([entryPath], {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
  const source = program.getSourceFile(entryPath);
  const symbol = source && program.getTypeChecker().getSymbolAtLocation(source);
  if (!symbol) throw new Error(`Failed to resolve TypeScript exports for ${entryPath}`);
  return program
    .getTypeChecker()
    .getExportsOfModule(symbol)
    .map((item) => item.name)
    .sort();
}

function symbolDigest(names) {
  return createHash("sha256").update(names.join("\n")).digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  runArchitectureRatchets();
}
