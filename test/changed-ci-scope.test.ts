import { describe, expect, it } from "vitest";

import { classifyCiScope } from "../scripts/changed-ci-scope.mjs";

const workspaces = [
  { name: "tasks", path: "packages/tasks", dependencies: [] },
  { name: "extension", path: "packages/extension", dependencies: ["tasks"] },
  { name: "@zendev-lab/spark-tui", path: "apps/tui", dependencies: ["extension"] },
  { name: "@zendev-lab/spark-daemon", path: "apps/daemon", dependencies: [] },
  { name: "@zendev-lab/spark-protocol", path: "packages/protocol", dependencies: [] },
  {
    name: "@zendev-lab/spark-hub",
    path: "apps/hub",
    dependencies: ["@zendev-lab/spark-protocol"],
  },
];

describe("affected CI scope", () => {
  it("skips runtime lanes for documentation-only changes", () => {
    expect(classifyCiScope(["README.md", "docs/operations/testing.md"], workspaces)).toMatchObject({
      docsOnly: true,
      runSource: false,
      runProcess: false,
      runBrowser: false,
    });
  });

  it("reports changed workspaces and their dependents", () => {
    expect(classifyCiScope(["packages/tasks/src/graph.ts"], workspaces)).toMatchObject({
      full: false,
      changedWorkspaces: ["tasks"],
      affectedWorkspaces: ["@zendev-lab/spark-tui", "extension", "tasks"],
    });
  });

  it("routes daemon changes through source, process, and macOS", () => {
    expect(classifyCiScope(["apps/daemon/src/store.ts"], workspaces)).toMatchObject({
      runSource: true,
      runProcess: true,
      runMacos: true,
    });
  });

  it("routes Hub and shared browser-contract changes through browser tests", () => {
    expect(classifyCiScope(["packages/protocol/src/model.ts"], workspaces)).toMatchObject({
      runBrowser: true,
      runProcess: false,
    });
  });

  it("fails safe to the full matrix for workflows and root configuration", () => {
    for (const path of [".github/workflows/ci-tests.yml", "package.json", "test/root.test.ts"]) {
      expect(classifyCiScope([path], workspaces)).toMatchObject({
        full: true,
        runSource: true,
        runProcess: true,
        runBrowser: true,
      });
    }
  });
});
