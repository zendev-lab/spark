import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import {
  loadAndValidateReleaseCompatibility,
  validateCompatibilitySemantics,
  type ReleaseCompatibilityContract,
} from "../scripts/validate-release-compatibility.mjs";

const root = process.cwd();

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(root, path), "utf8")) as T;
}

async function contractAndSchema() {
  return await Promise.all([
    readJson<ReleaseCompatibilityContract>("architecture/release-compatibility.json"),
    readJson<Record<string, unknown>>("architecture/release-compatibility.schema.json"),
  ]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("the adjacent-release contract passes its closed runtime schema and semantic graph", async () => {
  const contract = await loadAndValidateReleaseCompatibility(root);
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.components, ["hub", "daemon", "tui"]);
  assert.deepEqual(
    contract.edges.map(({ id, left, right, surfaces }) => ({ id, left, right, surfaces })),
    [
      {
        id: "hub-daemon",
        left: "hub",
        right: "daemon",
        surfaces: ["runtime-websocket", "local-control-rpc"],
      },
      {
        id: "daemon-tui",
        left: "daemon",
        right: "tui",
        surfaces: ["local-control-rpc", "view-event-stream"],
      },
    ],
  );
  assert.deepEqual(
    contract.releaseGate.requiredPhases.map(({ id }) => id),
    [
      "candidate-hub--baseline-daemon",
      "baseline-hub--candidate-daemon",
      "candidate-tui--baseline-daemon",
      "baseline-tui--candidate-daemon",
    ],
  );
  assert.equal(contract.protocol.unknownOptionalFields, "ignore-with-deterministic-defaults");
  assert.equal(contract.protocol.unknownRequiredCapabilities, "reject-with-actionable-diagnostic");
});

test("the contract schema rejects missing, unknown, and malformed policy", async () => {
  const [contract, schema] = await contractAndSchema();
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  for (const mutate of [
    (value: ReleaseCompatibilityContract) => delete value.protocol.unknownRequiredCapabilities,
    (value: ReleaseCompatibilityContract) => (value.releaseGate.placeholder = true),
    (value: ReleaseCompatibilityContract) => (value.fullMatrixRequiredFrom = "next"),
    (value: ReleaseCompatibilityContract) =>
      (value.releaseGate.compatibilityExemptVersions = ["0.4.0", "0.4.0"]),
    (value: ReleaseCompatibilityContract) =>
      (value.database.automaticUpdatePhases = ["expand", "backfill"]),
  ]) {
    const invalid = clone(contract);
    mutate(invalid);
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
  }
});

test("semantic validation rejects broken product graphs and a leaked legacy exception", async () => {
  const [contract] = await contractAndSchema();

  const duplicate = clone(contract);
  duplicate.releaseGate.requiredPhases[1] = clone(duplicate.releaseGate.requiredPhases[0]!);
  assert.throws(() => validateCompatibilitySemantics(duplicate), /duplicate release phase/u);

  const wrongEdge = clone(contract);
  wrongEdge.releaseGate.requiredPhases[0]!.edge = "daemon-tui";
  assert.throws(() => validateCompatibilitySemantics(wrongEdge), /does not cover/u);

  const leakedException = clone(contract);
  leakedException.releaseGate.firstSplitReleaseException.candidateVersion = "0.4.0";
  assert.throws(() => validateCompatibilitySemantics(leakedException), /first split release/u);

  const copiedHardCut = clone(contract);
  copiedHardCut.releaseGate.compatibilityExemptVersions.push("0.5.0");
  assert.throws(() => validateCompatibilitySemantics(copiedHardCut), /only the published 0.4.0/u);
});

test("the legacy all-in-one exception is bounded and reports split phases as not-applicable", async () => {
  const contract = await loadAndValidateReleaseCompatibility(root);
  const exception = contract.releaseGate.firstSplitReleaseException;
  assert.equal(contract.firstSplitRelease, "0.3.0");
  assert.equal(contract.fullMatrixRequiredFrom, "0.5.0");
  assert.equal(contract.database.metadataRequiredFrom, "0.5.0");
  assert.deepEqual(contract.releaseGate.compatibilityExemptVersions, ["0.4.0"]);
  assert.deepEqual(exception, {
    candidateVersion: "0.3.0",
    baselineVersion: "0.2.1",
    phaseStatus: "not-applicable",
    reason: exception.reason,
  });
  assert.match(exception.reason, /no independently published Hub or TUI artifacts/u);
});

test("the canonical release gate and both owner manifests are present now, not at a future placeholder", async () => {
  const contract = await loadAndValidateReleaseCompatibility(root);
  await Promise.all([
    access(join(root, contract.releaseGate.harness)),
    access(join(root, contract.releaseGate.productHarness)),
    access(join(root, contract.database.harness)),
    ...contract.database.owners.map(({ migrationManifest }) =>
      access(join(root, migrationManifest)),
    ),
  ]);
  assert.equal(contract.releaseGate.harness, "scripts/test-release-compatibility.mjs");
  assert.equal(
    contract.releaseGate.productHarness,
    "scripts/test-adjacent-product-compatibility.mjs",
  );
  assert.equal(contract.database.harness, "scripts/test-adjacent-database-compatibility.mjs");
  assert.deepEqual(contract.database.requiredPhases, [
    "baseline-create-write",
    "candidate-migrate-read-write",
    "baseline-reopen-read-write",
    "candidate-idempotent-reopen",
    "candidate-fresh-baseline-read-write",
    "interruption-recovery",
    "reject-unsafe-states",
  ]);
});

test("the tag workflow unconditionally runs the canonical gate before artifact upload", async () => {
  const workflow = await readFile(join(root, ".github/workflows/cd-publish.yml"), "utf8");
  const pack = workflow.indexOf("pnpm run release:pack");
  const gate = workflow.indexOf("node scripts/test-release-compatibility.mjs");
  const upload = workflow.indexOf("name: Upload release artifacts");
  assert.ok(
    pack >= 0 && gate > pack && upload > gate,
    "release gate must run after pack and before upload",
  );
  const gateStep = workflow.slice(
    workflow.lastIndexOf("      - name:", gate),
    workflow.indexOf("\n      - name:", gate),
  );
  assert.match(gateStep, /run: >-\s+node scripts\/test-release-compatibility\.mjs/u);
  assert.doesNotMatch(gateStep, /continue-on-error|if:/u);
  assert.match(workflow, /dist\/release\/adjacent-product-compatibility\.json/u);
  assert.match(workflow, /dist\/release\/adjacent-database-compatibility\.json/u);
});
