import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const {
  loadArchitectureInventory,
  validateArchitectureGovernanceTransition,
} = require("../architecture/dependency-governance.cjs");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventory = loadArchitectureInventory(rootDir);

function reducedInventory() {
  const reduced = structuredClone(inventory);
  reduced.governance.temporaryDependencyExceptions.pop();
  reduced.governance.temporaryDependencyExceptionBudget.current = 5;
  reduced.governance.temporaryDependencyExceptionBudget.ceiling = 5;
  return reduced;
}

describe("architecture governance transitions", () => {
  test("allows a 6-to-5 exception reduction", () => {
    expect(validateArchitectureGovernanceTransition(inventory, reducedInventory())).toEqual([]);
  });

  test("rejects 5-to-6 budget and exception regrowth", () => {
    expect(validateArchitectureGovernanceTransition(reducedInventory(), inventory)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("adds or revives temporary dependency exception"),
        expect.stringContaining("grows temporaryDependencyExceptionBudget.current from 5 to 6"),
        expect.stringContaining("grows temporaryDependencyExceptionBudget.ceiling from 5 to 6"),
      ]),
    );
  });

  test("rejects same-count replacement and retired-edge revival", () => {
    const previous = reducedInventory();
    const replacement = structuredClone(previous);
    replacement.governance.temporaryDependencyExceptions.shift();
    const retired = inventory.governance.temporaryDependencyExceptions.at(-1);
    if (!retired) throw new Error("expected a retired exception fixture");
    replacement.governance.temporaryDependencyExceptions.push(retired);

    expect(validateArchitectureGovernanceTransition(previous, replacement)).toContain(
      `Architecture transition adds or revives temporary dependency exception ${retired.from}->${retired.to}`,
    );
  });

  test("CLI fails closed when the base ref cannot be read", () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(rootDir, "scripts/check-architecture-transition.mjs"),
        "--base-ref",
        "refs/heads/definitely-missing-architecture-base",
      ],
      { cwd: rootDir, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot read architecture transition base");
  });
});
