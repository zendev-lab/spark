import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const architecture = readJson(join(root, "architecture/packages.json"));
const maxProductionFileLines = 4_000;
const frozenCompatibilityExtensions = new Set([
  "./packages/spark-ask/src/extension-entry.ts",
  "./packages/spark-artifacts/src/extension-entry.ts",
  "./packages/spark-cue/src/extension/index.ts",
  "./packages/spark-files/src/extension-entry.ts",
  "./packages/spark-ai/src/models-extension.ts",
  "./packages/spark-roles/src/extension-entry.ts",
  "./packages/spark-session/src/extension-entry.ts",
  "./packages/spark-memory/src/extension-entry.ts",
  "./packages/spark-web/src/extension-entry.ts",
  "./packages/spark-workflows/src/extension-entry.ts",
  "./packages/spark-ai/src/baidu-oneapi-compat-extension.ts",
  "./packages/spark-extension/src/extension/index.ts",
]);
const validLayers = new Set([
  "adapter",
  "application",
  "capability",
  "client",
  "compatibility",
  "composition",
  "contract",
  "experiment",
  "foundation",
  "private-adapter",
  "runtime",
]);
const validStabilities = new Set(["experimental", "frozen", "internal", "private", "supported"]);
const validStateWriters = new Set([
  "hub",
  "daemon",
  "external",
  "host",
  "none",
  "user",
  "workspace",
]);
const legacyDaemonClientCompatibilitySources = new Set([
  "packages/spark-daemon-client/src/daemon-client.ts",
  "packages/spark-daemon-client/src/daemon-local-rpc.ts",
]);

function runArchitectureRatchets() {
  const failures = [];
  const sealedPackagePaths = new Set(architecture.sealedPackagePaths ?? []);
  const workspacePackages = ["apps", "packages"].flatMap((workspaceDir) =>
    readdirSync(join(root, workspaceDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => isFile(join(root, workspaceDir, entry.name, "package.json")))
      .map((entry) => {
        const path = `${workspaceDir}/${entry.name}`;
        return { path, manifest: readJson(join(root, path, "package.json")) };
      })
      .filter(({ path }) => !sealedPackagePaths.has(path)),
  );
  const workspaceByName = new Map(
    workspacePackages.map((workspacePackage) => [workspacePackage.manifest.name, workspacePackage]),
  );
  const declaredPackages = architecture.packages ?? {};

  for (const sealedPath of sealedPackagePaths) {
    if (!isFile(join(root, sealedPath, "package.json"))) {
      failures.push(`sealed package ${sealedPath} must retain its source manifest`);
    }
    if (Object.values(declaredPackages).some((declaration) => declaration.path === sealedPath)) {
      failures.push(`sealed package ${sealedPath} must not remain in the package inventory`);
    }
  }

  if (workspacePackages.length > architecture.maxWorkspacePackages) {
    failures.push(
      `workspace package count grew to ${workspacePackages.length}; the package budget is ${architecture.maxWorkspacePackages}. Consolidate an owner boundary before adding another workspace.`,
    );
  }

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
    if (!validLayers.has(declaration.layer)) {
      failures.push(`${manifest.name} has invalid architecture layer ${declaration.layer}.`);
    }
    if (!declaration.owner?.trim()) {
      failures.push(`${manifest.name} must declare a non-empty architecture owner.`);
    }
    if (!validStabilities.has(declaration.stability)) {
      failures.push(`${manifest.name} has invalid stability ${declaration.stability}.`);
    }
    if (!validStateWriters.has(declaration.stateWriter)) {
      failures.push(`${manifest.name} has invalid stateWriter ${declaration.stateWriter}.`);
    }
    if (manifest.private !== true) {
      failures.push(
        `${manifest.name} must remain private; @zendev-lab/spark is the only published product.`,
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

    visit(join(root, path), (sourcePath) => {
      if (!isProductionSource(sourcePath)) return;
      const source = readFileSync(sourcePath, "utf8");
      const repositoryPath = relative(root, sourcePath).replaceAll("\\", "/");
      const lines = source.split(/\r?\n/u).length;
      if (lines > maxProductionFileLines) {
        failures.push(
          `${relative(root, sourcePath)} has ${lines} lines; the production-file ceiling is ${maxProductionFileLines}. Split it at a domain or adapter boundary.`,
        );
      }
      for (const importedPackage of workspaceImports(source)) {
        if (importedPackage === manifest.name || !workspaceByName.has(importedPackage)) continue;
        if (!declaredRuntimeDependencies.has(importedPackage)) {
          failures.push(
            `${relative(root, sourcePath)} imports ${importedPackage}, but ${manifest.name} does not declare it as a runtime dependency.`,
          );
        }
      }
      if (!isLegacyDaemonClientBoundaryExempt(repositoryPath)) {
        const violations = findLegacyDaemonClientViolations(source, repositoryPath);
        if (violations.length > 0) {
          failures.push(
            `${repositoryPath} bypasses the protocol-aware daemon client facade (${violations.join(", ")}). Use requestSparkDaemon/createSparkDaemonClient; keep legacy transport access inside spark-daemon-client compatibility sources.`,
          );
        }
      }
    });
  }

  for (const [name, declaration] of Object.entries(declaredPackages)) {
    const workspacePackage = workspaceByName.get(name);
    if (!workspacePackage) {
      failures.push(
        `architecture/packages.json declares removed or missing package ${name} at ${declaration.path}.`,
      );
    }
  }

  const rootPackage = readJson(join(root, "package.json"));
  const compatibilityExtensions = Array.isArray(rootPackage.pi?.extensions)
    ? rootPackage.pi.extensions
    : [];
  for (const extension of compatibilityExtensions) {
    if (!frozenCompatibilityExtensions.has(extension)) {
      failures.push(
        `Compatibility loader extension surface grew: ${extension}. New capabilities must target Spark-native hosts.`,
      );
    }
    const extensionPath = join(root, extension);
    if (!isFile(extensionPath)) continue;
    const unsafePiImports = findUnsafePiCompatibilityImportsInGraph(extensionPath);
    if (unsafePiImports.length > 0) {
      failures.push(
        `${extension} runtime graph imports Pi subpaths unsupported by the compatibility loader (${unsafePiImports.join(", ")}). Use only loader-virtualized Pi entries from compatibility extensions.`,
      );
    }
  }

  const tsconfig = readJson(join(root, "tsconfig.base.json"));
  for (const [specifier, targets] of Object.entries(tsconfig.compilerOptions?.paths ?? {})) {
    if (
      specifier.includes("pi-extension") ||
      (Array.isArray(targets) &&
        targets.some((target) => target.includes("packages/pi-extension/")))
    ) {
      failures.push(
        `Retired pi-extension facade remains in tsconfig path mapping ${specifier}. Legacy config migration must not recreate a source workspace alias.`,
      );
    }
  }

  for (const { path, manifest } of workspacePackages) {
    if (
      path !== "apps/spark-daemon" &&
      manifest.scripts?.check === "vp check --no-fmt --no-lint ."
    ) {
      failures.push(
        `${path} duplicates the root typecheck with a boilerplate check script. Keep workspace scripts only when they add package-local validation.`,
      );
    }
    if (manifest.scripts?.["test:mutation"] === "stryker run") {
      failures.push(
        `${path} duplicates the root mutation runner. Invoke the package's Stryker config through scripts/run-leaf-mutation.mjs instead.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      ["Architecture ratchet failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"),
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Architecture ratchet passed (${workspacePackages.length}/${architecture.maxWorkspacePackages} workspaces classified; production imports declared; daemon RPC facade enforced; production files <= ${maxProductionFileLines} lines; compatibility surface frozen with safe Pi imports).`,
    );
  }
}

export function findUnsafePiCompatibilityImports(source, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const safeSpecifiers = new Set([
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/compat",
    "@earendil-works/pi-ai/oauth",
    "@earendil-works/pi-ai/providers/all",
  ]);
  const unsafe = new Set();

  function inspect(node) {
    const specifier = moduleSpecifierText(node);
    if (
      specifier === "@mariozechner/pi-ai" ||
      specifier?.startsWith("@mariozechner/pi-ai/") ||
      (specifier?.startsWith("@earendil-works/pi-ai/") && !safeSpecifiers.has(specifier))
    ) {
      unsafe.add(specifier);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(sourceFile);
  return [...unsafe].sort((left, right) => left.localeCompare(right));
}

export function findUnsafePiCompatibilityImportsInGraph(entryPath) {
  const pending = [entryPath];
  const visited = new Set();
  const unsafe = new Set();

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || visited.has(currentPath) || !isFile(currentPath)) continue;
    visited.add(currentPath);
    const source = readFileSync(currentPath, "utf8");
    const displayPath = relative(root, currentPath);
    for (const specifier of findUnsafePiCompatibilityImports(source, displayPath)) {
      unsafe.add(`${displayPath}: ${specifier}`);
    }
    for (const specifier of findRuntimeModuleSpecifiers(source, displayPath)) {
      const resolved = resolveCompatibilitySourceModule(currentPath, specifier);
      if (resolved) pending.push(resolved);
    }
  }

  return [...unsafe].sort((left, right) => left.localeCompare(right));
}

function findRuntimeModuleSpecifiers(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = new Set();
  function inspect(node) {
    const specifier = moduleSpecifierText(node);
    if (specifier) specifiers.add(specifier);
    ts.forEachChild(node, inspect);
  }
  inspect(sourceFile);
  return [...specifiers];
}

function moduleSpecifierText(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier) &&
    !isTypeOnlyModuleEdge(node)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

function isTypeOnlyModuleEdge(node) {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  const importClause = node.importClause;
  if (!importClause) return false;
  if (importClause.isTypeOnly) return true;
  if (importClause.name || !importClause.namedBindings) return false;
  return (
    ts.isNamedImports(importClause.namedBindings) &&
    importClause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function resolveCompatibilitySourceModule(importerPath, specifier) {
  if (specifier.startsWith(".")) return resolveRelativeSourceModule(importerPath, specifier);
  if (!specifier.startsWith("@zendev-lab/")) return undefined;
  try {
    const resolvedPath = fileURLToPath(
      import.meta.resolve(specifier, pathToFileURL(join(root, "package.json"))),
    );
    if (!resolvedPath.startsWith(`${root}${sep}`) || !isFile(resolvedPath)) return undefined;
    return resolvedPath;
  } catch {
    return undefined;
  }
}

function resolveRelativeSourceModule(importerPath, specifier) {
  const base = resolve(dirname(importerPath), specifier);
  const candidates = extname(base)
    ? [base]
    : [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mts`,
        `${base}.js`,
        `${base}.mjs`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
        join(base, "index.mts"),
        join(base, "index.js"),
        join(base, "index.mjs"),
      ];
  return candidates.find((candidate) => isFile(candidate));
}

export function findLegacyDaemonClientViolations(source, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let importsLegacySubpath = false;
  let usesLegacyRequestSymbol = false;

  function inspect(node) {
    const moduleSpecifier = moduleSpecifierText(node);
    if (moduleSpecifier === "@zendev-lab/spark-daemon-client/local-rpc") {
      importsLegacySubpath = true;
    }
    if (
      ts.isIdentifier(node) &&
      (node.text === "requestSparkDaemonLocalRpc" || node.text === "requestSparkDaemonLocalRpcWire")
    ) {
      usesLegacyRequestSymbol = true;
    }
    ts.forEachChild(node, inspect);
  }
  inspect(sourceFile);

  return [
    ...(importsLegacySubpath ? ["legacy local-rpc subpath import"] : []),
    ...(usesLegacyRequestSymbol ? ["legacy request symbol"] : []),
  ];
}

export function isLegacyDaemonClientBoundaryExempt(repositoryPath) {
  const normalized = repositoryPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  return (
    legacyDaemonClientCompatibilitySources.has(normalized) ||
    /(?:^|\/)(?:__fixtures__|__tests__|fixtures|test|tests)(?:\/|$)/u.test(normalized) ||
    /\.(?:fixture|spec|test)\.[^/]+$/u.test(normalized)
  );
}

function workspaceImports(source) {
  const imports = new Set();
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](@zendev-lab\/[^/"']+)(?:\/[^"']*)?["']/gu;
  for (const match of source.matchAll(pattern)) imports.add(match[1]);
  return imports;
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

function isProductionSource(path) {
  if (![".js", ".mjs", ".svelte", ".ts", ".tsx"].includes(extname(path))) return false;
  const normalized = path.replaceAll("\\", "/");
  if (/\.(?:test|spec)\.[^.]+$/u.test(normalized)) return false;
  if (normalized.includes("/src/paraglide/")) return false;
  return !normalized.includes("/test/");
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

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  runArchitectureRatchets();
}
