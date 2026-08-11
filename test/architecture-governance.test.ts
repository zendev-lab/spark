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
  test("classifies every workspace with one state authority and role", () => {
    expect(governance.validateArchitectureGovernance(inventory, manifests, rootManifest)).toEqual(
      [],
    );
    expect(Object.keys(inventory.packages)).toHaveLength(41);
    for (const packageInfo of Object.values(inventory.packages)) {
      expect(packageInfo).toHaveProperty("stateAuthority");
      expect(packageInfo).toHaveProperty("stateRole");
      expect(packageInfo).not.toHaveProperty("stateWriter");
    }
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
        "@zendev-lab/spark-tui",
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
          stateAuthority: "none",
          stateRole: "stateless",
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

    expect(generatedRules).toHaveLength(41);
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

  test("rejects growing or stale exception metadata", () => {
    const candidate = structuredClone(inventory);
    candidate.governance.temporaryDependencyExceptions[0].nonGrowth = false;
    expect(governance.validateArchitectureGovernance(candidate, manifests, rootManifest)).toContain(
      "Dependency exception must be non-growth: @zendev-lab/spark-artifacts->@zendev-lab/spark-daemon-client",
    );
  });

  test("allows only the approved forty-second package", () => {
    const currentPackages = Object.keys(inventory.packages);
    expect(governance.validatePackageBudgetCandidate(inventory, currentPackages)).toEqual([]);
    expect(
      governance.validatePackageBudgetCandidate(inventory, [
        ...currentPackages,
        "@zendev-lab/pi-spark",
      ]),
    ).toEqual([]);
    expect(
      governance.validatePackageBudgetCandidate(inventory, [
        ...currentPackages,
        "@zendev-lab/spark-unapproved",
      ]),
    ).not.toEqual([]);
    expect(
      governance.validatePackageBudgetCandidate(inventory, [
        ...currentPackages,
        "@zendev-lab/pi-spark",
        "@zendev-lab/spark-unapproved",
      ]),
    ).not.toEqual([]);
  });

  test("rejects Pi product and SDK manifest ownership outside declared owners", () => {
    const actual = governance.validatePiOwnership(inventory, manifests, rootManifest);
    expect(actual.failures).toEqual([]);
    expect(actual.violations).toEqual([]);
    expect(actual.registeredExceptions).toEqual([
      {
        package: "@zendev-lab/spark-text",
        dependency: "@earendil-works/pi-tui",
      },
      {
        package: "root",
        dependency: "package.json#pi",
      },
    ]);

    const candidateManifests = structuredClone(manifests);
    const candidate = candidateManifests["@zendev-lab/spark-core"];
    candidate.pi = { extensions: ["./src/extension.ts"] };
    candidate.dependencies = {
      ...(candidate.dependencies ?? {}),
      "@earendil-works/pi-ai": "0.0.0-test",
      "@earendil-works/pi-coding-agent": "0.0.0-test",
      "@earendil-works/pi-tui": "0.0.0-test",
    };
    const result = governance.validatePiOwnership(inventory, candidateManifests, rootManifest);
    expect(result.violations).toHaveLength(4);
    expect(result.violations.map(({ dependency }: PiViolation) => dependency)).toEqual([
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "package.json#pi",
    ]);

    const noRootException = structuredClone(inventory);
    noRootException.governance.piOwnership.temporaryProductManifestExceptions = [];
    expect(
      governance.validatePiOwnership(noRootException, manifests, rootManifest).violations,
    ).toContainEqual({
      package: "root",
      kind: "product-manifest-owner",
      dependency: "package.json#pi",
      expectedOwner: "@zendev-lab/pi-spark",
    });
  });

  test("emits a schema-valid health report with no unregistered regressions", () => {
    const report = governance.generateArchitectureHealthReport(rootDir, inventory, manifests);
    const healthSchema = JSON.parse(
      readFileSync(path.join(rootDir, "architecture/health.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(healthSchema);

    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.inventory.workspaceCount).toBe(41);
    expect(report.inventory.stateWriterFieldCount).toBe(0);
    expect(report.layerMatrix.missingDecisionCount).toBe(0);
    expect(report.dependencies.edgeCount).toBe(166);
    expect(report.dependencies.registeredExceptions).toHaveLength(6);
    expect(report.dependencies.unregisteredViolations).toEqual([]);
    expect(report.dependencies.stronglyConnectedComponents).toEqual([]);
    expect(report.compositionRoots.unexpected).toEqual([]);
    expect(report.piOwnership.violations).toEqual([]);
    expect(Object.keys(report.workspaces)).toHaveLength(41);
  });

  test("schema rejects the retired stateWriter field and missing state role", () => {
    const schema = JSON.parse(
      readFileSync(path.join(rootDir, "architecture/packages.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const candidate = structuredClone(inventory);
    candidate.packages["@zendev-lab/spark-core"].stateWriter = "none";
    delete candidate.packages["@zendev-lab/spark-core"].stateRole;
    expect(validate(candidate)).toBe(false);
  });
});
