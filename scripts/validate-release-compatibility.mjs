#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function compareStableVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
    assert.ok(match, `invalid stable version: ${value}`);
    return match.slice(1).map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function validateCompatibilitySemantics(contract) {
  const components = new Set(contract.components);
  assert.equal(components.size, contract.components.length, "component IDs must be unique");

  const edges = new Map();
  for (const edge of contract.edges) {
    assert.ok(!edges.has(edge.id), `duplicate compatibility edge: ${edge.id}`);
    assert.ok(
      components.has(edge.left),
      `${edge.id} references unknown left component ${edge.left}`,
    );
    assert.ok(
      components.has(edge.right),
      `${edge.id} references unknown right component ${edge.right}`,
    );
    assert.notEqual(edge.left, edge.right, `${edge.id} must connect two distinct components`);
    edges.set(edge.id, edge);
  }

  const phaseIds = new Set();
  const edgeDirections = new Map([...edges].map(([id]) => [id, new Set()]));
  for (const phase of contract.releaseGate.requiredPhases) {
    assert.ok(!phaseIds.has(phase.id), `duplicate release phase: ${phase.id}`);
    phaseIds.add(phase.id);
    const edge = edges.get(phase.edge);
    assert.ok(edge, `${phase.id} references unknown edge ${phase.edge}`);
    const [leftVersion, leftComponent] = phase.left.split("-");
    const [rightVersion, rightComponent] = phase.right.split("-");
    assert.notEqual(leftVersion, rightVersion, `${phase.id} must mix candidate and baseline`);
    const phaseComponents = new Set([leftComponent, rightComponent]);
    assert.deepEqual(
      phaseComponents,
      new Set([edge.left, edge.right]),
      `${phase.id} does not cover the ${edge.id} endpoints`,
    );
    assert.equal(
      phase.id,
      `${phase.left}--${phase.right}`,
      `${phase.id} must name its roles exactly`,
    );
    edgeDirections
      .get(edge.id)
      .add(`${leftVersion}:${leftComponent}->${rightVersion}:${rightComponent}`);
  }
  for (const [edgeId, directions] of edgeDirections) {
    assert.equal(directions.size, 2, `${edgeId} must have exactly two adjacent-version directions`);
    const versions = [...directions].join("\n");
    assert.match(versions, /candidate:/u, `${edgeId} is missing a candidate peer`);
    assert.match(versions, /baseline:/u, `${edgeId} is missing a baseline peer`);
  }

  const exception = contract.releaseGate.firstSplitReleaseException;
  assert.equal(
    exception.candidateVersion,
    contract.firstSplitRelease,
    "the split-package exception may apply only to the first split release",
  );
  assert.ok(
    compareStableVersions(exception.baselineVersion, exception.candidateVersion) < 0,
    "the split-package exception baseline must predate the candidate",
  );
  assert.ok(
    compareStableVersions(contract.fullMatrixRequiredFrom, contract.firstSplitRelease) > 0,
    "the full product matrix ratchet must follow the first split release",
  );
  assert.equal(
    contract.database.metadataRequiredFrom,
    contract.fullMatrixRequiredFrom,
    "database metadata and the split-product matrix must ratchet together",
  );

  const ownerIds = contract.database.owners.map(({ id }) => id);
  assert.deepEqual(ownerIds, ["daemon", "hub"], "database owner order is part of report stability");
  assert.deepEqual(
    contract.database.automaticUpdatePhases,
    ["expand"],
    "only expand migrations may run automatically",
  );
  assert.ok(
    contract.database.minimumContractDelayReleases >= 2,
    "contract migrations require at least two release boundaries",
  );
  return contract;
}

export async function loadAndValidateReleaseCompatibility(base = root) {
  const [contract, schema] = await Promise.all([
    readJson(resolve(base, "architecture/release-compatibility.json")),
    readJson(resolve(base, "architecture/release-compatibility.schema.json")),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(contract)) {
    const errors = validate.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("\n");
    throw new Error(`Invalid release compatibility contract:\n${errors ?? "unknown error"}`);
  }
  validateCompatibilitySemantics(contract);
  await Promise.all([
    access(resolve(base, contract.releaseGate.harness)),
    access(resolve(base, contract.releaseGate.productHarness)),
    access(resolve(base, contract.database.harness)),
    ...contract.database.owners.map(({ migrationManifest }) =>
      access(resolve(base, migrationManifest)),
    ),
  ]);
  return contract;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await loadAndValidateReleaseCompatibility();
  console.log("Release compatibility contract is valid.");
}
