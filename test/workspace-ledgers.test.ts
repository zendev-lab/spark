import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

import { validateMutationOwnership } from "../scripts/check-mutation-ce-ownership.mjs";
import { readBaselinePaths, validateTestOwnership } from "../scripts/check-test-ownership.mjs";
import { validateWorkspaceTestStrategy } from "../scripts/check-workspace-test-strategy.mjs";

const root = resolve(".");
const architecture = readJson("architecture/packages.json");
const strategy = readJson("test/workspace-test-strategy.json");
const mutation = readJson("test/mutation-ce-ownership.json");
const testOwnership = readJson("test/test-ownership.json");
const ownershipBaselinePaths = (testOwnership.entries as Array<{ baselinePath: string }>).map(
  (entry) => entry.baselinePath,
);
const runnerSource = readFileSync(resolve("scripts/run-leaf-mutation.mjs"), "utf8");

function readJson(path: string) {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}

test("workspace strategy ledger covers architecture with exact classifications", () => {
  const result = validateWorkspaceTestStrategy({ ledger: strategy, architecture, root });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.counts, {
    "local-test": 30,
    "browser-test": 1,
    "process-test": 1,
    "boundary-contract": 7,
    "generated-only": 1,
  });
  assert.equal(result.total, 40);
  assert.equal(result.unclassified, 0);
  assert.deepEqual((strategy as any).workspaces["@zendev-lab/spark-cli"], {
    path: "apps/spark-cli",
    strategy: "process-test",
    primaryGate: {
      command: "pnpm run test:process:source",
      paths: ["test/process/spark-source-cli.test.ts"],
      rules: [],
    },
    supplementalGates: [
      {
        command: "pnpm --filter @zendev-lab/spark-cli run check",
        paths: ["apps/spark-cli/src/**/*.test.ts"],
        rules: ["dispatcher and command-plane owner-local contracts"],
      },
    ],
  });
  assert.deepEqual((strategy as any).workspaces["@zendev-lab/spark-runtime"], {
    path: "packages/spark-runtime",
    strategy: "local-test",
    primaryGate: {
      command: "pnpm --filter @zendev-lab/spark-runtime run check",
      paths: ["packages/spark-runtime/src/**/*.test.ts"],
      rules: ["runtime owner-local role-run adapter contracts"],
    },
    supplementalGates: [
      {
        command:
          "pnpm test test/spark-runtime-native-executor.test.ts test/runtime-role-run-retention.test.ts",
        paths: [
          "test/spark-runtime-native-executor.test.ts",
          "test/runtime-role-run-retention.test.ts",
        ],
        rules: ["runtime execution ownership"],
      },
    ],
  });
  assert.deepEqual((strategy as any).workspaces["@zendev-lab/spark-tui-app"], {
    path: "apps/spark-tui",
    strategy: "local-test",
    primaryGate: {
      command: "pnpm --filter @zendev-lab/spark-tui-app run test",
      paths: ["apps/spark-tui/src/**/*.test.ts"],
      rules: [],
    },
    supplementalGates: [],
  });
  for (const packageId of [
    "spark-memory",
    "spark-modes",
    "spark-graft",
    "spark-files",
    "spark-workflows",
  ]) {
    const name = "@zendev-lab/" + packageId;
    assert.deepEqual((strategy as any).workspaces[name], {
      path: "packages/" + packageId,
      strategy: "local-test",
      primaryGate: {
        command: "pnpm --filter " + name + " run check",
        paths: ["packages/" + packageId + "/src/**/*.test.ts"],
        rules: (strategy as any).workspaces[name].primaryGate.rules,
      },
      supplementalGates:
        packageId === "spark-memory"
          ? [
              {
                command:
                  "pnpm test test/spark-memory.test.ts test/spark-memory-compaction-candidates.test.ts",
                paths: [
                  "test/spark-memory.test.ts",
                  "test/spark-memory-compaction-candidates.test.ts",
                ],
                rules: ["cross-owner memory integration contracts"],
              },
            ]
          : packageId === "spark-workflows"
            ? [
                {
                  command: "pnpm test test/spark-workflows.test.ts",
                  paths: ["test/spark-workflows.test.ts"],
                  rules: ["cross-owner workflow integration contract"],
                },
              ]
            : [],
    });
  }
  assert.deepEqual((strategy as any).workspaces["@zendev-lab/spark-roles"], {
    path: "packages/spark-roles",
    strategy: "local-test",
    primaryGate: {
      command: "pnpm --filter @zendev-lab/spark-roles run check",
      paths: ["packages/spark-roles/src/**/*.test.ts"],
      rules: [],
    },
    supplementalGates: [],
  });
});

test("workspace strategy checker fails closed for missing, extra, enum, count, and path drift", () => {
  const cases = [
    (ledger: any) => delete ledger.workspaces["@zendev-lab/spark-core"],
    (ledger: any) => {
      ledger.workspaces["@zendev-lab/extra"] = clone(ledger.workspaces["@zendev-lab/spark-core"]);
    },
    (ledger: any) => {
      ledger.workspaces["@zendev-lab/spark-core"].strategy = "unknown";
    },
    (ledger: any) => {
      ledger.counts["local-test"] = 21;
    },
    (ledger: any) => {
      ledger.workspaces["@zendev-lab/spark-core"].primaryGate.paths = ["missing/path.test.ts"];
    },
  ];
  for (const mutate of cases) {
    const ledger = clone(strategy) as any;
    mutate(ledger);
    assert.equal(validateWorkspaceTestStrategy({ ledger, architecture, root }).ok, false);
  }
});

test("mutation ledger covers 10 included and 30 deferred workspaces without reports", () => {
  const result = validateMutationOwnership({ ledger: mutation, architecture, root, runnerSource });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.counts, { included: 10, deferred: 30 });
  assert.equal(result.total, 40);
  assert.equal(result.unclassified, 0);
});

test("mutation checker fails closed for coverage, enum, count, path, and runner drift", () => {
  const cases: Array<(ledger: any) => void> = [
    (ledger) => {
      delete ledger.workspaces["@zendev-lab/spark-core"];
    },
    (ledger) => {
      ledger.workspaces["@zendev-lab/extra"] = clone(ledger.workspaces["@zendev-lab/spark-core"]);
    },
    (ledger) => {
      ledger.workspaces["@zendev-lab/spark-core"].status = "unknown";
    },
    (ledger) => {
      ledger.includedCount = 9;
    },
    (ledger) => {
      ledger.workspaces["@zendev-lab/spark-retry"].config = "missing/stryker.config.json";
    },
  ];
  for (const mutate of cases) {
    const ledger = clone(mutation) as any;
    mutate(ledger);
    assert.equal(validateMutationOwnership({ ledger, architecture, root, runnerSource }).ok, false);
  }
  const drift = validateMutationOwnership({
    ledger: mutation,
    architecture,
    root,
    runnerSource: 'const packages = ["@zendev-lab/spark-retry"];',
  });
  assert.equal(drift.ok, false);
  assert.match(drift.errors.join("\n"), /derive packages/u);
});

test("test ownership ledger exactly covers the immutable 130-test baseline without debt", () => {
  const report = validateTestOwnership({
    ledger: testOwnership,
    architecture,
    root,
    baselinePaths: ownershipBaselinePaths,
  });
  assert.equal(report.ok, true);
  assert.equal(report.strictOk, true);
  assert.deepEqual(report.structuralErrors, []);
  assert.equal(report.total, 130);
  assert.equal(report.baselineTotal, 130);
  assert.deepEqual(report.counts, { "owner-local": 103, "root-integration": 27 });
  assert.deepEqual(report.pending, { migrations: [], integrationDeepImports: [] });
  assert.equal(report.pendingCount, 0);
  assert.equal(
    (testOwnership.entries as Array<{ disposition: string }>).filter(
      (entry) => entry.disposition === "owner-local",
    ).length,
    103,
  );
  for (const [baselinePath, currentPath] of [
    [
      "test/artifact-persistence.test.ts",
      "apps/spark-daemon/src/artifact-persistence.integration.test.ts",
    ],
    [
      "test/spark-cli-bootstrap.test.ts",
      "apps/spark-tui/src/__tests__/spark-cli-bootstrap.test.ts",
    ],
    [
      "test/spark-goal-completion-loop.test.ts",
      "packages/spark-extension/src/extension/spark-command-tool-events.test.ts",
    ],
    ["test/spark-tools.test.ts", "packages/spark-extension/src/__tests__/spark-tools.test.ts"],
    ["test/spark-workflows.test.ts", "packages/spark-workflows/src/spark-workflows.test.ts"],
  ]) {
    assert.equal(
      (testOwnership.entries as Array<{ baselinePath: string; currentPath: string }>).find(
        (entry) => entry.baselinePath === baselinePath,
      )?.currentPath,
      currentPath,
    );
  }
});

test("test ownership baseline stays pinned when origin/main moves and fails closed for bad OIDs", () => {
  const frozen = readBaselinePaths(root, (testOwnership as any).baselineCommit);
  assert.equal(frozen.length, 130);
  assert.deepEqual(frozen, [...ownershipBaselinePaths].sort());
  assert.throws(
    () => readBaselinePaths(root, "not-a-complete-commit"),
    /complete 40-hex commit OID/u,
  );
  assert.throws(
    () => readBaselinePaths(root, "0000000000000000000000000000000000000000"),
    /does not resolve to a commit/u,
  );
});

test("test ownership checker fails closed for missing, extra, duplicate, path, and owner drift", () => {
  const cases: Array<{ mutate: (ledger: any) => void; expected: RegExp }> = [
    { mutate: (ledger) => ledger.entries.shift(), expected: /missing baseline test/u },
    {
      mutate: (ledger) =>
        ledger.entries.push({
          ...clone(ledger.entries[0]),
          baselinePath: "test/extra-ownership.test.ts",
          currentPath: "test/core.test.ts",
        }),
      expected: /extra baseline test/u,
    },
    {
      mutate: (ledger) => ledger.entries.push(clone(ledger.entries[0])),
      expected: /duplicate baseline test/u,
    },
    {
      mutate: (ledger) => {
        ledger.entries[0].currentPath = "test/missing-ownership.test.ts";
      },
      expected: /currentPath does not exist/u,
    },
    {
      mutate: (ledger) => {
        ledger.entries[0].owners = ["@zendev-lab/not-a-workspace"];
      },
      expected: /unknown owner/u,
    },
  ];
  for (const { mutate, expected } of cases) {
    const ledger = clone(testOwnership) as any;
    mutate(ledger);
    const result = validateTestOwnership({
      ledger,
      architecture,
      root,
      baselinePaths: ownershipBaselinePaths,
      strict: false,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), expected);
  }
});
