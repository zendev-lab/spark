import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { test } from "vitest";

import {
  assertReproGoldenJourneyRecoverySemantics,
  goldenJourneyOwnerOutcomeProjection,
  recoveryOutcomeProjection,
} from "./support/repro-golden-journey-recovery-contract.ts";

const schemaPath = resolve(
  import.meta.dirname,
  "process/repro-golden-journey-recovery.schema.json",
);
const fixtureRoot = resolve(import.meta.dirname, "fixtures/repro/recovery-ledger");

interface NegativeCase {
  id: string;
  path: Array<string | number>;
  value?: unknown;
  copyFrom?: Array<string | number>;
  expected: string;
}

test("versioned recovery ledger matches the immutable happy outcome", async () => {
  const [schema, happy, expected, expectedOwner] = await Promise.all([
    readJson(schemaPath),
    readJson(resolve(fixtureRoot, "happy.json")),
    readJson(resolve(fixtureRoot, "expected-outcome.json")),
    readJson(resolve(fixtureRoot, "expected-owner-outcome.json")),
  ]);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema as object);
  assert.equal(validate(happy), true, JSON.stringify(validate.errors ?? [], null, 2));
  assertReproGoldenJourneyRecoverySemantics(happy);
  assert.deepEqual(recoveryOutcomeProjection(happy), expected);
  assert.deepEqual(goldenJourneyOwnerOutcomeProjection(happy), expectedOwner);
});

test("recovery ledger rejects duplicate, stale, conflicting, and unproven outcomes", async () => {
  const [schema, happy, casesValue] = await Promise.all([
    readJson(schemaPath),
    readJson(resolve(fixtureRoot, "happy.json")),
    readJson(resolve(fixtureRoot, "negative-cases.json")),
  ]);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema as object);
  const cases = casesValue as NegativeCase[];
  for (const negative of cases) {
    const candidate = structuredClone(happy);
    const replacement = negative.copyFrom
      ? structuredClone(valueAtPath(candidate, negative.copyFrom))
      : structuredClone(negative.value);
    setAtPath(candidate, negative.path, replacement);
    assert.equal(
      validate(candidate),
      true,
      `${negative.id}: mutation must reach semantic verifier`,
    );
    assert.throws(
      () => assertReproGoldenJourneyRecoverySemantics(candidate),
      new RegExp(negative.expected, "u"),
      negative.id,
    );
  }
});

test("recovery ledger schema rejects unknown fields and invalid answer outcomes", async () => {
  const [schema, happy] = await Promise.all([
    readJson(schemaPath),
    readJson(resolve(fixtureRoot, "happy.json")),
  ]);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema as object);
  assert.equal(validate({ ...(happy as object), unexpected: true }), false);
  const invalidOutcome = structuredClone(happy) as {
    interaction: { answerOutcome: string };
  };
  invalidOutcome.interaction.answerOutcome = "synthetic";
  assert.equal(validate(invalidOutcome), false);
  const leakedCueDaemon = structuredClone(happy) as {
    teardown: { cueDaemonAlive: boolean };
  };
  leakedCueDaemon.teardown.cueDaemonAlive = true;
  assert.equal(validate(leakedCueDaemon), false);
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function valueAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      throw new Error(`invalid fixture path ${path.join(".")}`);
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function setAtPath(value: unknown, path: Array<string | number>, replacement: unknown): void {
  const parent = valueAtPath(value, path.slice(0, -1));
  const key = path.at(-1);
  if (!parent || typeof parent !== "object" || key === undefined) {
    throw new Error(`invalid fixture path ${path.join(".")}`);
  }
  (parent as Record<string | number, unknown>)[key] = replacement;
}
