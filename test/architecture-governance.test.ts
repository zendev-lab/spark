import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const governance = require("../architecture/dependency-governance.cjs");
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventory = governance.loadArchitectureInventory(rootDir);
const exceptionCount = inventory.governance.temporaryDependencyExceptions.length;
const rootManifest = governance.readRootManifest(rootDir);
const manifests = governance.readWorkspaceManifests(rootDir, inventory);

interface LayerDecision {
  fromLayer: string;
  toLayer: string;
  allowed: boolean;
}

interface NamedRule {
  name: string;
}

interface PiViolation {
  dependency: string;
}

describe("architecture inventory governance", () => {
  test("classifies every workspace with the existing state-writer field", () => {
    expect(governance.validateArchitectureGovernance(inventory, manifests, rootManifest)).toEqual(
      [],
    );
    expect(Object.keys(inventory.packages)).toHaveLength(42);
    for (const packageInfo of Object.values(inventory.packages)) {
      expect(packageInfo).toHaveProperty("stateWriter");
      expect(packageInfo).not.toHaveProperty("stateAuthority");
      expect(packageInfo).not.toHaveProperty("stateRole");
    }
  });

  test("keeps the Node engine in the root manifest only", () => {
    const candidateManifests = structuredClone(manifests);
    candidateManifests["@zendev-lab/spark-text"].engines = { node: ">=26.0.0 <27" };

    expect(
      governance.validateArchitectureGovernance(inventory, candidateManifests, rootManifest),
    ).toContain(
      "@zendev-lab/spark-text duplicates the root Node engine; private workspaces must inherit it",
    );
  });

  test("decides every ordered layer pair and enforces strict inward direction", () => {
    const layerCount = Object.keys(inventory.governance.layerPolicy.tiers).length;
    const matrix = governance.buildLayerPairMatrix(inventory);
    expect(matrix).toHaveLength(layerCount ** 2);
    expect(
      new Set(matrix.map(({ fromLayer, toLayer }: LayerDecision) => `${fromLayer}->${toLayer}`))
        .size,
    ).toBe(layerCount ** 2);
    expect(matrix.every(({ allowed }: LayerDecision) => typeof allowed === "boolean")).toBe(true);

    expect(governance.decideLayerDependency(inventory, "application", "composition").allowed).toBe(
      true,
    );
    expect(governance.decideLayerDependency(inventory, "composition", "application").allowed).toBe(
      false,
    );
    expect(governance.decideLayerDependency(inventory, "capability", "client").allowed).toBe(false);
    expect(governance.decideLayerDependency(inventory, "client", "capability").allowed).toBe(true);
    expect(governance.decideLayerDependency(inventory, "adapter", "runtime").allowed).toBe(true);
    expect(governance.decideLayerDependency(inventory, "foundation", "contract").allowed).toBe(
      true,
    );
    expect(
      governance.decideLayerDependency(
        inventory,
        "application",
        "private-adapter",
        "@zendev-lab/spark-hub",
      ).allowed,
    ).toBe(true);
    expect(
      governance.decideLayerDependency(
        inventory,
        "application",
        "private-adapter",
        "@zendev-lab/spark-web",
      ).allowed,
    ).toBe(true);
    expect(
      governance.decideLayerDependency(
        inventory,
        "application",
        "private-adapter",
        "@zendev-lab/spark-cli",
      ).allowed,
    ).toBe(false);
  });

  test("covers positive and negative generated fixtures for every layer pair", () => {
    const fixtureInventory = structuredClone(inventory);
    const layerNames = Object.keys(fixtureInventory.governance.layerPolicy.tiers);
    fixtureInventory.governance.temporaryDependencyExceptions = [];
    fixtureInventory.packages = {};
    for (const layer of layerNames) {
      for (const suffix of ["a", "b"]) {
        fixtureInventory.packages[`@zendev-lab/spark-fixture-${layer}-${suffix}`] = {
          path: `packages/fixture-${layer}-${suffix}`,
          layer,
          owner: "fixture",
          stability: "internal",
          stateWriter: "none",
        };
      }
    }

    const rules = governance.generateLayerRules(fixtureInventory);
    let allowedFixtureCount = 0;
    let forbiddenFixtureCount = 0;
    for (const fromLayer of layerNames) {
      const fromPackage = `@zendev-lab/spark-fixture-${fromLayer}-a`;
      const rule = rules.find(
        ({ name }: NamedRule) => name === `inventory-layer-spark-fixture-${fromLayer}-a`,
      );
      expect(rule).toBeDefined();
      for (const toLayer of layerNames) {
        const toPackage = `@zendev-lab/spark-fixture-${toLayer}-b`;
        const decision = governance.decideLayerDependency(
          fixtureInventory,
          fromLayer,
          toLayer,
          fromPackage,
        );
        const classification = governance.classifyWorkspaceDependency(
          fixtureInventory,
          fromPackage,
          toPackage,
        );
        const generatedRuleMatches = new RegExp(rule.to.path).test(
          fixtureInventory.packages[toPackage].path,
        );
        expect(classification.allowed).toBe(decision.allowed);
        expect(generatedRuleMatches).toBe(!decision.allowed);
        if (decision.allowed) allowedFixtureCount += 1;
        else forbiddenFixtureCount += 1;
      }
    }
    expect(allowedFixtureCount).toBeGreaterThan(0);
    expect(forbiddenFixtureCount).toBeGreaterThan(0);
    expect(allowedFixtureCount + forbiddenFixtureCount).toBe(layerNames.length ** 2);
  });

  test("generates Dependency Cruiser layer rules from the inventory", () => {
    const generatedRules = governance.generateLayerRules(inventory);
    const dependencyCruiserConfig = require("../.dependency-cruiser.cjs");
    const configuredRuleNames = new Set(
      dependencyCruiserConfig.forbidden.map(({ name }: NamedRule) => name),
    );

    expect(generatedRules).toHaveLength(42);
    for (const rule of generatedRules) expect(configuredRuleNames.has(rule.name)).toBe(true);
    expect(
      governance.classifyWorkspaceDependency(
        inventory,
        "@zendev-lab/spark-artifacts",
        "@zendev-lab/spark-daemon-client",
      ).status,
    ).toBe("registered-exception");
    expect(
      governance.classifyWorkspaceDependency(
        inventory,
        "@zendev-lab/spark-memory",
        "@zendev-lab/spark-daemon-client",
      ).status,
    ).toBe("unregistered-violation");
  });

  test("allows the daemon to import cordis as the store composition root", () => {
    const dependencyCruiserConfig = require("../.dependency-cruiser.cjs");
    const rule = dependencyCruiserConfig.forbidden.find(
      ({ name }: NamedRule) => name === "no-direct-cordis",
    );
    expect(rule).toBeDefined();
    expect(rule.from.pathNot).toContain("apps/spark-daemon/");
    expect(rule.from.pathNot).toContain("packages/spark-turn/");
    expect(rule.from.pathNot).toContain("packages/spark-extension/");
    expect(rule.from.pathNot).toContain("packages/spark-llm/");
  });

  test("allows spark-turn to import dsh-llm as the agent-loop driver", () => {
    const dependencyCruiserConfig = require("../.dependency-cruiser.cjs");
    const rule = dependencyCruiserConfig.forbidden.find(
      ({ name }: NamedRule) => name === "no-direct-dsh-llm",
    );
    expect(rule).toBeDefined();
    expect(rule.from.pathNot).toContain("packages/spark-turn/");
    expect(rule.from.pathNot).toContain("packages/spark-extension/");
    expect(rule.from.pathNot).toContain("packages/spark-llm/");
  });

  test("allows the daemon to import dsh-session persistence on the Cordis root", () => {
    const dependencyCruiserConfig = require("../.dependency-cruiser.cjs");
    const rule = dependencyCruiserConfig.forbidden.find(
      ({ name }: NamedRule) => name === "no-direct-dsh-session",
    );
    expect(rule).toBeDefined();
    expect(rule.from.pathNot).toContain("apps/spark-daemon/");
    expect(rule.from.pathNot).toContain("packages/spark-turn/");
  });

  test("rejects growing or stale exception metadata", () => {
    const candidate = structuredClone(inventory);
    candidate.governance.temporaryDependencyExceptions[0].nonGrowth = false;
    expect(governance.validateArchitectureGovernance(candidate, manifests, rootManifest)).toContain(
      "Dependency exception must be non-growth: @zendev-lab/spark-artifacts->@zendev-lab/spark-daemon-client",
    );
  });

  test("rejects an extra real reverse edge plus exact exception and budget tampering", () => {
    const candidateInventory = structuredClone(inventory);
    const candidateManifests = structuredClone(manifests);
    candidateInventory.governance.temporaryDependencyExceptions.push({
      from: "@zendev-lab/spark-memory",
      to: "@zendev-lab/spark-daemon-client",
      toLayer: "client",
      reason:
        "Synthetic seventh reverse edge used only to prove fail-closed non-growth budget enforcement.",
      owner: "memory",
      exitTask: "task:6a9bde44-5cfe-4e78-9a0e-ead159701b55",
      nonGrowth: true,
    });
    candidateInventory.governance.temporaryDependencyExceptionBudget.current = 7;
    candidateInventory.governance.temporaryDependencyExceptionBudget.ceiling = 7;
    candidateManifests["@zendev-lab/spark-memory"].dependencies = {
      ...(candidateManifests["@zendev-lab/spark-memory"].dependencies ?? {}),
      "@zendev-lab/spark-daemon-client": "workspace:^",
    };

    const failures = governance.validateArchitectureGovernance(
      candidateInventory,
      candidateManifests,
      rootManifest,
    );
    expect(failures.some((failure: string) => failure.includes("ceiling=7"))).toBe(true);

    const packageSchema = JSON.parse(
      readFileSync(path.join(rootDir, "architecture/packages.schema.json"), "utf8"),
    );
    const validatePackageInventory = new Ajv2020({ allErrors: true, strict: true }).compile(
      packageSchema,
    );

    const reducedCount = exceptionCount - 1;
    const budgetTamper = structuredClone(inventory);
    budgetTamper.governance.temporaryDependencyExceptionBudget.current = reducedCount;
    expect(
      governance.validateArchitectureGovernance(budgetTamper, manifests, rootManifest),
    ).toContain(
      `temporaryDependencyExceptionBudget must keep current=${reducedCount}, ceiling=${exceptionCount}, and exception ledger length=${exceptionCount} equal`,
    );
    expect(validatePackageInventory(budgetTamper)).toBe(false);

    const ceilingTamper = structuredClone(inventory);
    ceilingTamper.governance.temporaryDependencyExceptionBudget.ceiling = 7;
    expect(
      governance.validateArchitectureGovernance(ceilingTamper, manifests, rootManifest),
    ).toContain(
      `temporaryDependencyExceptionBudget current=${exceptionCount} ceiling=7 exceeds non-growth maximum 6`,
    );
    expect(validatePackageInventory(ceilingTamper)).toBe(false);

    const currentOnlyReduction = structuredClone(inventory);
    currentOnlyReduction.governance.temporaryDependencyExceptions.pop();
    currentOnlyReduction.governance.temporaryDependencyExceptionBudget.current = reducedCount;
    expect(
      governance.validateArchitectureGovernance(currentOnlyReduction, manifests, rootManifest),
    ).toContain(
      `temporaryDependencyExceptionBudget must keep current=${reducedCount}, ceiling=${exceptionCount}, and exception ledger length=${reducedCount} equal`,
    );
    expect(validatePackageInventory(currentOnlyReduction)).toBe(false);

    const ceilingOnlyReduction = structuredClone(inventory);
    ceilingOnlyReduction.governance.temporaryDependencyExceptions.pop();
    ceilingOnlyReduction.governance.temporaryDependencyExceptionBudget.ceiling = reducedCount;
    expect(
      governance.validateArchitectureGovernance(ceilingOnlyReduction, manifests, rootManifest),
    ).toContain(
      `temporaryDependencyExceptionBudget must keep current=${exceptionCount}, ceiling=${reducedCount}, and exception ledger length=${reducedCount} equal`,
    );
    expect(validatePackageInventory(ceilingOnlyReduction)).toBe(false);

    const reduced = structuredClone(inventory);
    const removed = reduced.governance.temporaryDependencyExceptions.pop();
    reduced.governance.temporaryDependencyExceptionBudget.current = reducedCount;
    reduced.governance.temporaryDependencyExceptionBudget.ceiling = reducedCount;
    const reducedManifests = structuredClone(manifests);
    if (removed) {
      const deps = reducedManifests[removed.from].dependencies ?? {};
      delete deps[removed.to];
      reducedManifests[removed.from].dependencies = deps;
    }
    expect(
      governance.validateArchitectureGovernance(reduced, reducedManifests, rootManifest),
    ).toEqual([]);
    expect(validatePackageInventory(reduced)).toBe(true);

    const regrowth = structuredClone(reduced);
    const regrowthManifests = structuredClone(reducedManifests);
    if (removed) {
      regrowth.governance.temporaryDependencyExceptions.push(removed);
      regrowthManifests[removed.from].dependencies = {
        ...(regrowthManifests[removed.from].dependencies ?? {}),
        [removed.to]: "workspace:^",
      };
    }
    expect(
      governance.validateArchitectureGovernance(regrowth, regrowthManifests, rootManifest),
    ).toContain(
      `temporaryDependencyExceptionBudget must keep current=${reducedCount}, ceiling=${reducedCount}, and exception ledger length=${exceptionCount} equal`,
    );
  });

  test("rejects any package beyond the closed budget", () => {
    const currentPackages = Object.keys(inventory.packages);
    expect(governance.validatePackageBudgetCandidate(inventory, currentPackages)).toEqual([]);
    expect(
      governance.validatePackageBudgetCandidate(inventory, [
        ...currentPackages,
        "@zendev-lab/spark-unapproved",
      ]),
    ).not.toEqual([]);
    expect(governance.isClosedPackageBudget(inventory.governance.packageBudget)).toBe(true);
  });

  test("rejects Pi product and SDK manifest ownership outside declared owners", () => {
    const actual = governance.validatePiOwnership(inventory, manifests, rootManifest);
    expect(actual.failures).toEqual([]);
    expect(actual.violations).toEqual([]);
    expect(actual.registeredExceptions).toEqual([]);

    const candidateManifests = structuredClone(manifests);
    const candidate = candidateManifests["@zendev-lab/spark-core"];
    candidate.pi = { extensions: ["./src/extension.ts"] };
    candidate.dependencies = {
      ...(candidate.dependencies ?? {}),
      "@earendil-works/pi-ai": "0.0.0-test",
    };
    const result = governance.validatePiOwnership(inventory, candidateManifests, rootManifest);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map(({ dependency }: PiViolation) => dependency)).toEqual([
      "@earendil-works/pi-ai",
      "package.json#pi",
    ]);

    const rootWithPi = { ...rootManifest, pi: { extensions: ["./src/extension.ts"] } };
    expect(
      governance.validatePiOwnership(inventory, manifests, rootWithPi).violations,
    ).toContainEqual({
      package: "root",
      kind: "product-manifest-owner",
      dependency: "package.json#pi",
      expectedOwner: null,
    });

    const splitManifests = structuredClone(manifests);
    splitManifests["@zendev-lab/spark-extension"].pi = {
      extensions: ["./src/extension.ts"],
    };
    expect(
      governance.validatePiOwnership(inventory, splitManifests, rootManifest).violations,
    ).toContainEqual({
      package: "@zendev-lab/spark-extension",
      kind: "product-manifest-owner",
      dependency: "package.json#pi",
      expectedOwner: null,
    });
  });

  test("emits a schema-valid health report with no unregistered regressions", () => {
    const report = governance.generateArchitectureHealthReport(rootDir, inventory, manifests);
    const healthSchema = JSON.parse(
      readFileSync(path.join(rootDir, "architecture/health.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(healthSchema);
    const digest = createHash("sha256")
      .update(`${JSON.stringify(report, null, 2)}\n`)
      .digest("hex");
    const compactMarkdown = governance.formatArchitectureHealthMarkdown(report);

    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.inventory.workspaceCount).toBe(42);
    expect(report.layerMatrix.missingDecisionCount).toBe(0);
    expect(report.dependencies.edgeCount).toBe(156);
    expect(report.dependencies.registeredExceptions).toHaveLength(exceptionCount);
    expect(report.temporaryDependencyExceptionBudget).toEqual({
      current: exceptionCount,
      ceiling: exceptionCount,
      nonGrowth: true,
    });
    expect(report.dependencies.unregisteredViolations).toEqual([]);
    expect(report.dependencies.stronglyConnectedComponents).toEqual([]);
    expect(report.compositionRoots.unexpected).toEqual([]);
    expect(report.piOwnership.violations).toEqual([]);
    expect(Object.keys(report.workspaces)).toHaveLength(42);
    expect(report.workspaces["@zendev-lab/spark-daemon"].stateWriter).toBe("daemon");
    expect(report.workspaces["@zendev-lab/spark-web"].layer).toBe("application");
    expect(report.workspaces["@zendev-lab/spark-web-dsh"].layer).toBe("application");
    expect(report.workspaces["@zendev-lab/spark-tool-web"].layer).toBe("capability");
    expect(compactMarkdown).toContain(`exceptionBudget: ${exceptionCount}/${exceptionCount}`);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Stable digest for the projected health report body.
    expect(digest).toBe(
      createHash("sha256")
        .update(`${JSON.stringify(report, null, 2)}\n`)
        .digest("hex"),
    );
  });

  test("schema rejects competing state authority and role fields", () => {
    const schema = JSON.parse(
      readFileSync(path.join(rootDir, "architecture/packages.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const candidate = structuredClone(inventory);
    candidate.packages["@zendev-lab/spark-core"].stateAuthority = "none";
    candidate.packages["@zendev-lab/spark-core"].stateRole = "stateless";
    expect(validate(candidate)).toBe(false);
  });
});
