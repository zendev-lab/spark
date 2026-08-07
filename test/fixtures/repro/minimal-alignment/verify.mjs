#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const implementation = process.argv[2];
if (implementation !== "reference" && implementation !== "target") {
  process.stderr.write("Usage: node verify.mjs <reference|target>\n");
  process.exitCode = 2;
} else {
  const vectors = JSON.parse(
    await readFile(new URL("./test-vectors.json", import.meta.url), "utf8"),
  );
  const module = await import(new URL(`./${implementation}/normalize.mjs`, import.meta.url));
  const failures = [];

  for (const testCase of vectors.cases) {
    const actual = module.normalize(testCase.input, vectors.epsilon);
    const failure = compare(testCase.expected, actual, vectors.tolerance);
    if (failure) failures.push(`${testCase.id}: ${failure}`);
  }

  if (failures.length > 0) {
    process.stderr.write(
      [`FAIL ${implementation} ${failures.length}/${vectors.cases.length} vectors`, ...failures]
        .map((line) => `${line}\n`)
        .join(""),
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS ${implementation} ${vectors.cases.length} vectors\n`);
  }
}

function compare(expected, actual, tolerance) {
  if (!Array.isArray(actual)) return `expected an array, received ${typeof actual}`;
  if (actual.length !== expected.length) {
    return `expected ${expected.length} values, received ${actual.length}`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const delta = Math.abs(actual[index] - expected[index]);
    if (!Number.isFinite(actual[index]) || delta > tolerance) {
      return `index ${index} expected ${expected[index]}, received ${actual[index]} (delta ${delta})`;
    }
  }
  return undefined;
}
