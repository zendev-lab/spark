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
const EXCEPTION_COUNT = inventory.governance.temporaryDependencyExceptions.length;

function reducedInventory() {
  const reduced = structuredClone(inventory);
  reduced.governance.temporaryDependencyExceptions.pop();
  reduced.governance.temporaryDependencyExceptionBudget.current = EXCEPTION_COUNT - 1;
  reduced.governance.temporaryDependencyExceptionBudget.ceiling = EXCEPTION_COUNT - 1;
  return reduced;
}

describe("architecture governance transitions", () => {
  test(`allows a ${EXCEPTION_COUNT}-to-${EXCEPTION_COUNT - 1} exception reduction`, () => {
    expect(validateArchitectureGovernanceTransition(inventory, reducedInventory())).toEqual([]);
  });

  test(`rejects ${EXCEPTION_COUNT - 1}-to-${EXCEPTION_COUNT} budget and exception regrowth`, () => {
    expect(validateArchitectureGovernanceTransition(reducedInventory(), inventory)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("adds or revives temporary dependency exception"),
        expect.stringContaining(
          `grows temporaryDependencyExceptionBudget.current from ${EXCEPTION_COUNT - 1} to ${EXCEPTION_COUNT}`,
        ),
        expect.stringContaining(
          `grows temporaryDependencyExceptionBudget.ceiling from ${EXCEPTION_COUNT - 1} to ${EXCEPTION_COUNT}`,
        ),
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

  test("rejects adding or reviving a DSH dependency exception after bootstrap", () => {
    const previous = structuredClone(inventory);
    delete previous.packages["@zendev-lab/dsh-tool-cue"].dshIndependenceException;

    expect(validateArchitectureGovernanceTransition(previous, inventory)).toContain(
      "Architecture transition adds or revives DSH dependency exception @zendev-lab/dsh-tool-cue->@zendev-lab/spark-cue",
    );
  });

  test.each(["reason", "exitCondition"] as const)(
    "rejects immutable DSH dependency exception %s changes",
    (field) => {
      const changed = structuredClone(inventory);
      const exception = changed.packages["@zendev-lab/dsh-tool-cue"].dshIndependenceException;
      if (!exception) throw new Error("expected a DSH dependency exception fixture");
      exception[field] = `${exception[field]} changed`;

      expect(validateArchitectureGovernanceTransition(inventory, changed)).toContain(
        "Architecture transition changes immutable DSH dependency exception metadata for @zendev-lab/dsh-tool-cue->@zendev-lab/spark-cue",
      );
    },
  );

  test.each(["toLayer", "reason", "owner", "exitTask", "nonGrowth"] as const)(
    "rejects immutable exception metadata changes to %s",
    (field) => {
      const changed = structuredClone(inventory);
      const exception = changed.governance.temporaryDependencyExceptions[0];
      if (!exception) throw new Error("expected an exception fixture");
      const replacements = {
        toLayer: "application",
        reason: `${exception.reason} altered`,
        owner: `${exception.owner}-altered`,
        exitTask: "task:00000000-0000-4000-8000-000000000000",
        nonGrowth: false,
      };
      exception[field] = replacements[field as keyof typeof replacements];

      expect(validateArchitectureGovernanceTransition(inventory, changed)).toContain(
        `Architecture transition changes immutable temporary dependency exception metadata for ${exception.from}->${exception.to}`,
      );
    },
  );

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
