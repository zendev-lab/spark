import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
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

function isProductionSource(path) {
  if (![".js", ".mjs", ".svelte", ".ts", ".tsx"].includes(extname(path))) return false;
  const normalized = path.replaceAll("\\", "/");
  if (/\.(?:test|spec)\.[^.]+$/u.test(normalized)) return false;
  if (normalized.includes("/src/paraglide/")) return false;
  if (normalized.includes("/__tests__/")) return false;
  return !normalized.includes("/test/");
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
  const rootImportRe = /from\s+["']@zendev-lab\/spark-protocol["']/g;
  let productionRootImportCount = 0;
  for (const workspaceDir of ["apps", "packages"]) {
    visit(join(root, workspaceDir), (sourcePath) => {
      if (!isProductionSource(sourcePath)) return;
      const source = readFileSync(sourcePath, "utf8");
      const matches = source.match(rootImportRe);
      if (matches?.length) {
        productionRootImportCount += matches.length;
        failures.push(
          `${relative(root, sourcePath).replaceAll("\\", "/")} imports @zendev-lab/spark-protocol root barrel; use domain/daemon/runtime/interaction/presentation subpaths`,
        );
      }
    });
  }
  const ceiling = allowlist.productionRootImportCeiling;
  if (typeof ceiling !== "number") {
    failures.push("spark-protocol root import allowlist is missing productionRootImportCeiling");
  } else if (productionRootImportCount > ceiling) {
    failures.push(
      `spark-protocol production root imports ${productionRootImportCount} exceed ceiling ${ceiling}`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  runArchitectureRatchets();
}
