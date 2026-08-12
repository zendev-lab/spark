const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_DEPENDENCY_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"];
const ALL_DEPENDENCY_SECTIONS = [...RUNTIME_DEPENDENCY_SECTIONS, "devDependencies"];
const TEST_SOURCE_PATTERN =
  "(?:^|/)(?:__fixtures__|__tests__|fixtures|test|tests)(?:/|$)|\\.(?:fixture|spec|test)\\.[^/]+$";

function loadArchitectureInventory(rootDir = path.resolve(__dirname, "..")) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "architecture/packages.json"), "utf8"));
}

function readRootManifest(rootDir) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
}

function readWorkspaceManifests(rootDir, inventory) {
  const manifests = {};
  for (const [packageName, packageInfo] of Object.entries(inventory.packages)) {
    const manifestPath = path.join(rootDir, packageInfo.path, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.name !== packageName) {
      throw new Error(
        `Architecture inventory key ${packageName} does not match ${manifestPath} name ${String(manifest.name)}`,
      );
    }
    manifests[packageName] = manifest;
  }
  return manifests;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvedPackagePattern(inventory, packageNames) {
  const patterns = [];
  for (const packageName of [...new Set(packageNames)].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const packageInfo = inventory.packages[packageName];
    if (!packageInfo) {
      throw new Error(`Cannot build a path pattern for unregistered package ${packageName}`);
    }
    patterns.push(`^${escapeRegExp(packageInfo.path)}(?:/|$)`);
    patterns.push(`(?:^|/)node_modules/${escapeRegExp(packageName)}(?:/|$)`);
  }
  return patterns.length === 0 ? "(?!)" : `(?:${patterns.join("|")})`;
}

function peerLayersAreAllowed(layerPolicy, fromLayer, toLayer) {
  return layerPolicy.peerLayerGroups.some(
    (group) => group.includes(fromLayer) && group.includes(toLayer),
  );
}

function decideLayerDependency(inventory, fromLayer, toLayer, fromPackage) {
  const layerPolicy = inventory.governance.layerPolicy;
  const fromTier = layerPolicy.tiers[fromLayer];
  const toTier = layerPolicy.tiers[toLayer];
  if (fromTier === undefined || toTier === undefined) {
    return { allowed: false, reason: "unregistered-layer" };
  }

  const targetRestriction = layerPolicy.targetRestrictions.find(
    (restriction) => restriction.targetLayer === toLayer,
  );
  if (
    targetRestriction &&
    !targetRestriction.allowedFromLayers.includes(fromLayer) &&
    !targetRestriction.allowedFromPackages.includes(fromPackage)
  ) {
    return { allowed: false, reason: "restricted-target-layer" };
  }

  if (fromLayer === toLayer) {
    if (layerPolicy.denySameLayerDependencies.includes(fromLayer)) {
      return { allowed: false, reason: "same-layer-dependency-denied" };
    }
    return { allowed: true, reason: "same-layer-dependency" };
  }

  if (fromTier === toTier) {
    return peerLayersAreAllowed(layerPolicy, fromLayer, toLayer)
      ? { allowed: true, reason: "declared-peer-layers" }
      : { allowed: false, reason: "undeclared-peer-layers" };
  }

  return fromTier > toTier
    ? { allowed: true, reason: "inward-layer-dependency" }
    : { allowed: false, reason: "outward-layer-dependency" };
}

function dependencyExceptionFor(inventory, fromPackage, toPackage) {
  return inventory.governance.temporaryDependencyExceptions.find(
    (exception) => exception.from === fromPackage && exception.to === toPackage,
  );
}

function temporaryDependencyExceptionKey(exception) {
  return `${exception.from}->${exception.to}`;
}

function temporaryDependencyExceptionFingerprint(exception) {
  return JSON.stringify({
    from: exception.from,
    to: exception.to,
    toLayer: exception.toLayer,
    reason: exception.reason,
    owner: exception.owner,
    exitTask: exception.exitTask,
    nonGrowth: exception.nonGrowth,
  });
}

function validateTemporaryDependencyExceptionSnapshot(inventory, label) {
  const failures = [];
  const exceptions = inventory?.governance?.temporaryDependencyExceptions;
  const budget = inventory?.governance?.temporaryDependencyExceptionBudget;
  if (!Array.isArray(exceptions) || !budget) {
    failures.push(`${label} inventory is missing temporary dependency exception governance`);
    return failures;
  }
  if (budget.nonGrowth !== true) {
    failures.push(`${label} temporaryDependencyExceptionBudget.nonGrowth must be true`);
  }
  if (!Number.isInteger(budget.current) || !Number.isInteger(budget.ceiling)) {
    failures.push(`${label} temporaryDependencyExceptionBudget counts must be integers`);
  } else {
    if (budget.current < 0 || budget.ceiling < 0 || budget.current > 6 || budget.ceiling > 6) {
      failures.push(
        `${label} temporaryDependencyExceptionBudget current=${budget.current} ceiling=${budget.ceiling} must remain within 0..6`,
      );
    }
    if (budget.current !== budget.ceiling || budget.current !== exceptions.length) {
      failures.push(
        `${label} temporaryDependencyExceptionBudget must keep current=${budget.current}, ceiling=${budget.ceiling}, and exception ledger length=${exceptions.length} equal`,
      );
    }
  }
  const keys = exceptions.map(temporaryDependencyExceptionKey);
  if (new Set(keys).size !== keys.length) {
    failures.push(`${label} temporary dependency exception ledger contains duplicate keys`);
  }
  return failures;
}

function validateArchitectureGovernanceTransition(previousInventory, currentInventory) {
  const failures = [];
  const previousExceptions = previousInventory?.governance?.temporaryDependencyExceptions;
  const previousBudget = previousInventory?.governance?.temporaryDependencyExceptionBudget;

  // The inventory-v2 rollout is the only bootstrap transition. Once v2 exists,
  // every later revision must compare against its exact accepted ledger.
  if (
    previousInventory?.schemaVersion === 1 &&
    previousExceptions === undefined &&
    previousBudget === undefined &&
    currentInventory?.schemaVersion === 2
  ) {
    failures.push(...validateTemporaryDependencyExceptionSnapshot(currentInventory, "current"));
    return failures;
  }

  failures.push(...validateTemporaryDependencyExceptionSnapshot(previousInventory, "previous"));
  failures.push(...validateTemporaryDependencyExceptionSnapshot(currentInventory, "current"));
  if (failures.length > 0) return failures;

  const currentExceptions = currentInventory.governance.temporaryDependencyExceptions;
  const currentBudget = currentInventory.governance.temporaryDependencyExceptionBudget;
  const previousByKey = new Map(
    previousExceptions.map((exception) => [temporaryDependencyExceptionKey(exception), exception]),
  );
  for (const exception of currentExceptions) {
    const key = temporaryDependencyExceptionKey(exception);
    const previousException = previousByKey.get(key);
    if (!previousException) {
      failures.push(
        `Architecture transition adds or revives temporary dependency exception ${key}`,
      );
      continue;
    }
    if (
      temporaryDependencyExceptionFingerprint(exception) !==
      temporaryDependencyExceptionFingerprint(previousException)
    ) {
      failures.push(
        `Architecture transition changes immutable temporary dependency exception metadata for ${key}`,
      );
    }
  }
  if (currentBudget.current > previousBudget.current) {
    failures.push(
      `Architecture transition grows temporaryDependencyExceptionBudget.current from ${previousBudget.current} to ${currentBudget.current}`,
    );
  }
  if (currentBudget.ceiling > previousBudget.ceiling) {
    failures.push(
      `Architecture transition grows temporaryDependencyExceptionBudget.ceiling from ${previousBudget.ceiling} to ${currentBudget.ceiling}`,
    );
  }
  return failures;
}

function classifyWorkspaceDependency(inventory, fromPackage, toPackage) {
  const fromInfo = inventory.packages[fromPackage];
  const toInfo = inventory.packages[toPackage];
  if (!fromInfo || !toInfo) {
    return { status: "unregistered-package", allowed: false };
  }

  const exception = dependencyExceptionFor(inventory, fromPackage, toPackage);
  if (exception) {
    return {
      status: "registered-exception",
      allowed: true,
      reason: exception.reason,
      exitTask: exception.exitTask,
    };
  }

  const decision = decideLayerDependency(inventory, fromInfo.layer, toInfo.layer, fromPackage);
  return {
    status: decision.allowed ? "allowed" : "unregistered-violation",
    ...decision,
  };
}

function workspaceDependencies(manifest, workspaceNames, sections) {
  const dependencies = new Set();
  for (const section of sections) {
    for (const dependencyName of Object.keys(manifest[section] ?? {})) {
      if (workspaceNames.has(dependencyName)) dependencies.add(dependencyName);
    }
  }
  return [...dependencies].sort((left, right) => left.localeCompare(right));
}

function runtimeWorkspaceDependencies(manifest, workspaceNames) {
  return workspaceDependencies(manifest, workspaceNames, RUNTIME_DEPENDENCY_SECTIONS);
}

function allManifestDependencies(manifest) {
  const dependencies = new Set();
  for (const section of ALL_DEPENDENCY_SECTIONS) {
    for (const dependencyName of Object.keys(manifest[section] ?? {})) {
      dependencies.add(dependencyName);
    }
  }
  return dependencies;
}

function buildWorkspaceGraph(inventory, manifests) {
  const workspaceNames = new Set(Object.keys(inventory.packages));
  return Object.fromEntries(
    Object.keys(inventory.packages)
      .sort()
      .map((packageName) => [
        packageName,
        runtimeWorkspaceDependencies(manifests[packageName], workspaceNames),
      ]),
  );
}

function buildLayerPairMatrix(inventory) {
  const layers = Object.keys(inventory.governance.layerPolicy.tiers).sort();
  return layers.flatMap((fromLayer) =>
    layers.map((toLayer) => ({
      fromLayer,
      toLayer,
      ...decideLayerDependency(inventory, fromLayer, toLayer),
    })),
  );
}

function generateLayerRules(inventory) {
  const packageEntries = Object.entries(inventory.packages);
  const rules = [];
  for (const [fromPackage, fromInfo] of packageEntries) {
    const forbiddenTargets = packageEntries
      .filter(([toPackage]) => toPackage !== fromPackage)
      .filter(
        ([toPackage]) =>
          classifyWorkspaceDependency(inventory, fromPackage, toPackage).status ===
          "unregistered-violation",
      )
      .map(([toPackage]) => toPackage);
    if (forbiddenTargets.length === 0) continue;
    rules.push({
      name: `inventory-layer-${fromPackage.replace(/^@zendev-lab\//, "")}`,
      severity: "error",
      comment: `Generated from architecture/packages.json: ${fromInfo.layer} may only depend inward or on declared peers.`,
      from: {
        path: `^${escapeRegExp(fromInfo.path)}(?:/|$)`,
        pathNot: TEST_SOURCE_PATTERN,
      },
      to: {
        path: resolvedPackagePattern(inventory, forbiddenTargets),
      },
    });
  }
  return rules;
}

function validatePackageBudgetCandidate(inventory, candidatePackageNames) {
  const budget = inventory.governance.packageBudget;
  const currentNames = new Set(Object.keys(inventory.packages));
  const candidateNames = new Set(candidatePackageNames);
  const failures = [];

  for (const currentName of currentNames) {
    if (!candidateNames.has(currentName)) {
      failures.push(`Package budget candidate removes registered package ${currentName}`);
    }
  }
  const additions = [...candidateNames]
    .filter((name) => !currentNames.has(name))
    .sort((left, right) => left.localeCompare(right));
  if (candidateNames.size === budget.current && additions.length === 0) return failures;
  if (
    candidateNames.size === budget.approvedNext &&
    additions.length === 1 &&
    additions[0] === budget.approvedPackage
  ) {
    return failures;
  }
  failures.push(
    `Package budget allows ${budget.current} current packages or only ${budget.approvedPackage} as package ${budget.approvedNext}; received ${candidateNames.size} packages with additions ${additions.join(", ") || "none"}`,
  );
  return failures;
}

function validatePiOwnership(inventory, manifests, rootManifest) {
  const policy = inventory.governance.piOwnership;
  const approvedPackage = inventory.governance.packageBudget.approvedPackage;
  const sdkOwners = new Map();
  const exceptionKeys = new Set();
  const actualExceptionKeys = new Set();
  const productExceptionKeys = new Set();
  const actualProductExceptionKeys = new Set();
  const failures = [];
  const violations = [];
  const registeredExceptions = [];

  if (!manifests[policy.productManifestOwner] && policy.productManifestOwner !== approvedPackage) {
    failures.push(
      `Pi product manifest owner ${policy.productManifestOwner} is neither registered nor approved`,
    );
  }
  for (const { dependency, owner } of policy.sdkDependencies) {
    if (sdkOwners.has(dependency)) failures.push(`Duplicate Pi SDK ownership for ${dependency}`);
    sdkOwners.set(dependency, owner);
  }
  for (const exception of policy.temporaryProductManifestExceptions) {
    if (productExceptionKeys.has(exception.manifest)) {
      failures.push(`Duplicate Pi product manifest exception ${exception.manifest}`);
    }
    if (exception.nonGrowth !== true) {
      failures.push(`Pi product manifest exception must be non-growth: ${exception.manifest}`);
    }
    productExceptionKeys.add(exception.manifest);
  }
  if (rootManifest && Object.hasOwn(rootManifest, "pi")) {
    if (productExceptionKeys.has("package.json")) {
      actualProductExceptionKeys.add("package.json");
      registeredExceptions.push({ package: "root", dependency: "package.json#pi" });
    } else {
      violations.push({
        package: "root",
        kind: "product-manifest-owner",
        dependency: "package.json#pi",
        expectedOwner: policy.productManifestOwner,
      });
    }
  }

  for (const exception of policy.temporaryDependencyExceptions) {
    const key = `${exception.package}->${exception.dependency}`;
    if (exceptionKeys.has(key)) failures.push(`Duplicate Pi dependency exception ${key}`);
    if (exception.nonGrowth !== true)
      failures.push(`Pi dependency exception must be non-growth: ${key}`);
    exceptionKeys.add(key);
    if (!manifests[exception.package]) {
      failures.push(`Pi dependency exception source is not registered: ${exception.package}`);
    }
    if (!sdkOwners.has(exception.dependency)) {
      failures.push(`Pi dependency exception target is not governed: ${exception.dependency}`);
    }
  }

  for (const [dependency, owner] of sdkOwners) {
    if (!manifests[owner] && owner !== approvedPackage) {
      failures.push(`Pi SDK owner ${owner} for ${dependency} is neither registered nor approved`);
    }
  }

  for (const [packageName, manifest] of Object.entries(manifests)) {
    if (Object.hasOwn(manifest, "pi") && packageName !== policy.productManifestOwner) {
      violations.push({
        package: packageName,
        kind: "product-manifest-owner",
        dependency: "package.json#pi",
        expectedOwner: policy.productManifestOwner,
      });
    }
    const dependencies = allManifestDependencies(manifest);
    for (const [dependency, owner] of sdkOwners) {
      if (!dependencies.has(dependency) || packageName === owner) continue;
      const key = `${packageName}->${dependency}`;
      if (exceptionKeys.has(key)) {
        actualExceptionKeys.add(key);
        registeredExceptions.push({ package: packageName, dependency });
      } else {
        violations.push({
          package: packageName,
          kind: "sdk-manifest-owner",
          dependency,
          expectedOwner: owner,
        });
      }
    }
  }

  if (rootManifest) {
    for (const key of productExceptionKeys) {
      if (!actualProductExceptionKeys.has(key)) {
        failures.push(`Stale Pi product manifest exception ${key}`);
      }
    }
  }
  for (const key of exceptionKeys) {
    if (!actualExceptionKeys.has(key)) failures.push(`Stale Pi dependency exception ${key}`);
  }

  return {
    failures,
    violations: violations.sort((left, right) =>
      `${left.package}:${left.dependency}`.localeCompare(`${right.package}:${right.dependency}`),
    ),
    registeredExceptions: registeredExceptions.sort((left, right) =>
      `${left.package}:${left.dependency}`.localeCompare(`${right.package}:${right.dependency}`),
    ),
  };
}

function validateArchitectureGovernance(inventory, manifests, rootManifest) {
  const failures = [];
  const packageNames = Object.keys(inventory.packages);
  const packageNameSet = new Set(packageNames);
  const layerPolicy = inventory.governance.layerPolicy;
  const layerNames = Object.keys(layerPolicy.tiers);

  if (new Set(layerNames).size !== layerNames.length) {
    failures.push("Layer policy contains duplicate layer names");
  }
  if (buildLayerPairMatrix(inventory).length !== layerNames.length ** 2) {
    failures.push("Layer policy does not decide every ordered layer pair");
  }

  for (const [packageName, packageInfo] of Object.entries(inventory.packages)) {
    if (!Object.hasOwn(layerPolicy.tiers, packageInfo.layer)) {
      failures.push(`${packageName} uses unregistered layer ${packageInfo.layer}`);
    }
  }

  const exceptionKeys = new Set();
  const graph = manifests ? buildWorkspaceGraph(inventory, manifests) : undefined;
  for (const exception of inventory.governance.temporaryDependencyExceptions) {
    const key = `${exception.from}->${exception.to}`;
    if (exceptionKeys.has(key)) failures.push(`Duplicate dependency exception ${key}`);
    if (exception.nonGrowth !== true)
      failures.push(`Dependency exception must be non-growth: ${key}`);
    exceptionKeys.add(key);
    if (!packageNameSet.has(exception.from) || !packageNameSet.has(exception.to)) {
      failures.push(`Dependency exception references an unregistered package: ${key}`);
      continue;
    }
    const toInfo = inventory.packages[exception.to];
    if (exception.toLayer !== toInfo.layer) {
      failures.push(
        `Dependency exception ${key} records ${exception.toLayer} but target is ${toInfo.layer}`,
      );
    }
    const baseDecision = decideLayerDependency(
      inventory,
      inventory.packages[exception.from].layer,
      toInfo.layer,
      exception.from,
    );
    if (baseDecision.allowed) {
      failures.push(`Dependency exception ${key} is unnecessary under the declared layer policy`);
    }
    if (graph && !graph[exception.from].includes(exception.to)) {
      failures.push(`Stale dependency exception ${key}`);
    }
  }

  const exceptionBudget = inventory.governance.temporaryDependencyExceptionBudget;
  if (!exceptionBudget) {
    failures.push("Missing temporaryDependencyExceptionBudget governance contract");
  } else {
    if (exceptionBudget.nonGrowth !== true) {
      failures.push("temporaryDependencyExceptionBudget.nonGrowth must be true");
    }
    if (exceptionBudget.current > 6 || exceptionBudget.ceiling > 6) {
      failures.push(
        `temporaryDependencyExceptionBudget current=${exceptionBudget.current} ceiling=${exceptionBudget.ceiling} exceeds non-growth maximum 6`,
      );
    }
    const exceptionCount = inventory.governance.temporaryDependencyExceptions.length;
    if (
      exceptionBudget.current !== exceptionBudget.ceiling ||
      exceptionBudget.current !== exceptionCount
    ) {
      failures.push(
        `temporaryDependencyExceptionBudget must keep current=${exceptionBudget.current}, ceiling=${exceptionBudget.ceiling}, and exception ledger length=${exceptionCount} equal`,
      );
    }
  }

  const budget = inventory.governance.packageBudget;
  if (packageNames.length !== budget.current) {
    failures.push(
      `Package budget current=${budget.current} does not match inventory count ${packageNames.length}`,
    );
  }
  if (budget.approvedNext !== budget.current + 1) {
    failures.push("Package budget approvedNext must be exactly current + 1");
  }
  if (packageNameSet.has(budget.approvedPackage)) {
    failures.push(`Approved next package ${budget.approvedPackage} already exists`);
  }
  if (Object.values(inventory.packages).some((entry) => entry.path === budget.approvedPath)) {
    failures.push(`Approved next path ${budget.approvedPath} already exists`);
  }

  for (const compositionRoot of inventory.governance.compositionRoots) {
    const rootInfo = inventory.packages[compositionRoot];
    if (!rootInfo) failures.push(`Composition root is not registered: ${compositionRoot}`);
    else if (rootInfo.layer !== "composition") {
      failures.push(`Composition root ${compositionRoot} is classified as ${rootInfo.layer}`);
    }
  }

  if (manifests) {
    failures.push(...validatePiOwnership(inventory, manifests, rootManifest).failures);
  }
  return failures;
}

function stronglyConnectedComponents(graph) {
  let index = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph[node]) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    if (component.length > 1) {
      components.push(component.sort((left, right) => left.localeCompare(right)));
    }
  }

  for (const node of Object.keys(graph).sort()) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

function publicExportCount(manifest) {
  if (typeof manifest.exports === "string") return 1;
  if (!manifest.exports || typeof manifest.exports !== "object") return 0;
  return Object.keys(manifest.exports).length;
}

function generateArchitectureHealthReport(rootDir, inventory, manifests) {
  const rootManifest = readRootManifest(rootDir);
  const graph = buildWorkspaceGraph(inventory, manifests);
  const fanIn = Object.fromEntries(Object.keys(graph).map((name) => [name, 0]));
  const registeredExceptions = [];
  const unregisteredViolations = [];
  const crossOwnerEdges = [];
  const edgeClassifications = {};

  for (const [fromPackage, dependencies] of Object.entries(graph)) {
    edgeClassifications[fromPackage] = [];
    for (const toPackage of dependencies) {
      fanIn[toPackage] += 1;
      const classification = classifyWorkspaceDependency(inventory, fromPackage, toPackage);
      const fromInfo = inventory.packages[fromPackage];
      const toInfo = inventory.packages[toPackage];
      const edge = { from: fromPackage, to: toPackage };
      edgeClassifications[fromPackage].push({ ...edge, status: classification.status });
      if (classification.status === "registered-exception") registeredExceptions.push(edge);
      if (classification.status === "unregistered-violation") {
        unregisteredViolations.push({ ...edge, reason: classification.reason });
      }
      if (fromInfo.owner !== toInfo.owner) {
        crossOwnerEdges.push(edge);
      }
    }
  }

  const workspaces = {};
  for (const packageName of Object.keys(inventory.packages).sort()) {
    const packageInfo = inventory.packages[packageName];
    const directDependencies = graph[packageName];
    workspaces[packageName] = {
      path: packageInfo.path,
      layer: packageInfo.layer,
      owner: packageInfo.owner,
      stateWriter: packageInfo.stateWriter,
      directDependencies,
      directDependencyCount: directDependencies.length,
      fanIn: fanIn[packageName],
      fanOut: directDependencies.length,
      crossOwnerEdgeCount: directDependencies.filter(
        (target) => packageInfo.owner !== inventory.packages[target].owner,
      ).length,
      layerViolations: edgeClassifications[packageName].filter((edge) => edge.status !== "allowed"),
      publicExportCount: publicExportCount(manifests[packageName]),
    };
  }

  const expectedCompositionRoots = [...inventory.governance.compositionRoots].sort((left, right) =>
    left.localeCompare(right),
  );
  const actualCompositionRoots = Object.entries(inventory.packages)
    .filter(([, packageInfo]) => packageInfo.layer === "composition")
    .map(([packageName]) => packageName)
    .sort();
  const piOwnership = validatePiOwnership(inventory, manifests, rootManifest);
  const byLayer = {};
  for (const packageInfo of Object.values(inventory.packages)) {
    byLayer[packageInfo.layer] = (byLayer[packageInfo.layer] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    inventorySchemaVersion: inventory.schemaVersion,
    inventory: {
      workspaceCount: Object.keys(inventory.packages).length,
      byLayer: Object.fromEntries(
        Object.entries(byLayer).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    layerMatrix: {
      layerCount: Object.keys(inventory.governance.layerPolicy.tiers).length,
      decisionCount: buildLayerPairMatrix(inventory).length,
      missingDecisionCount: 0,
    },
    dependencies: {
      edgeCount: Object.values(graph).reduce(
        (total, dependencies) => total + dependencies.length,
        0,
      ),
      crossOwnerEdges: crossOwnerEdges.sort((left, right) =>
        `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
      ),
      registeredExceptions: registeredExceptions.sort((left, right) =>
        `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
      ),
      unregisteredViolations: unregisteredViolations.sort((left, right) =>
        `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
      ),
      stronglyConnectedComponents: stronglyConnectedComponents(graph),
    },
    temporaryDependencyExceptionBudget: {
      ...inventory.governance.temporaryDependencyExceptionBudget,
    },
    compositionRoots: {
      expected: expectedCompositionRoots,
      actual: actualCompositionRoots,
      unexpected: actualCompositionRoots.filter(
        (packageName) => !expectedCompositionRoots.includes(packageName),
      ),
      missing: expectedCompositionRoots.filter(
        (packageName) => !actualCompositionRoots.includes(packageName),
      ),
    },
    piOwnership: {
      productManifestOwner: inventory.governance.piOwnership.productManifestOwner,
      registeredExceptions: piOwnership.registeredExceptions,
      violations: piOwnership.violations,
    },
    packageBudget: { ...inventory.governance.packageBudget },
    workspaces,
  };
}

function formatArchitectureHealthMarkdown(report) {
  const lines = [
    "# Architecture health",
    "",
    `- workspaces: ${report.inventory.workspaceCount}`,
    `- edges: ${report.dependencies.edgeCount}`,
    `- registeredExceptions: ${report.dependencies.registeredExceptions.length}`,
    `- exceptionBudget: ${report.temporaryDependencyExceptionBudget.current}/${report.temporaryDependencyExceptionBudget.ceiling} (nonGrowth=${report.temporaryDependencyExceptionBudget.nonGrowth})`,
    `- crossOwnerEdges: ${report.dependencies.crossOwnerEdges.length}`,
    `- unregisteredViolations: ${report.dependencies.unregisteredViolations.length}`,
    `- stronglyConnectedComponents: ${report.dependencies.stronglyConnectedComponents.length}`,
    `- piViolations: ${report.piOwnership.violations.length}`,
    `- unexpectedCompositionRoots: ${report.compositionRoots.unexpected.length}`,
  ];
  return `${lines.join("\n")}\n`;
}

module.exports = {
  ALL_DEPENDENCY_SECTIONS,
  RUNTIME_DEPENDENCY_SECTIONS,
  TEST_SOURCE_PATTERN,
  buildLayerPairMatrix,
  buildWorkspaceGraph,
  classifyWorkspaceDependency,
  decideLayerDependency,
  formatArchitectureHealthMarkdown,
  generateArchitectureHealthReport,
  generateLayerRules,
  loadArchitectureInventory,
  readRootManifest,
  readWorkspaceManifests,
  resolvedPackagePattern,
  validateArchitectureGovernance,
  validateArchitectureGovernanceTransition,
  validatePackageBudgetCandidate,
  validatePiOwnership,
};
