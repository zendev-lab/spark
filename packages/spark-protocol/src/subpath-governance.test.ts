import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  findSparkProtocolRootReferences,
  isSparkProductionSourcePath,
  sparkProtocolSubpathBoundaryViolations,
} from "../../../scripts/spark-protocol-governance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(here, "..", "package.json");
const presentationPath = join(here, "presentation.ts");
const domainPath = join(here, "domain.ts");
const runtimePath = join(here, "runtime.ts");
const allowlistPath = join(
  here,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "spark-protocol-root-imports.json",
);

const protocolPackage = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  exports?: Record<string, string>;
};
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as {
  productionRootImportCeiling: number;
  requiredSubpaths: string[];
};

const REQUIRED = ["domain", "daemon", "runtime", "interaction", "presentation"] as const;

describe("spark-protocol subpath governance", () => {
  test("declares the five required contract-domain subpaths", () => {
    const exportsMap = protocolPackage.exports ?? {};
    for (const subpath of REQUIRED) {
      expect(exportsMap[`./${subpath}`]).toEqual(`./src/${subpath}.ts`);
    }
    expect(allowlist.requiredSubpaths).toEqual([...REQUIRED]);
    expect(allowlist.productionRootImportCeiling).toBe(0);
  });

  test("presentation barrel does not import daemon-only control-plane modules", () => {
    const presentation = readFileSync(presentationPath, "utf8");
    expect(presentation.includes('from "./daemon.ts"')).toBe(false);
    expect(presentation.includes('from "./task-claim.ts"')).toBe(false);
    expect(presentation.includes('from "./local-rpc-orpc-contract.ts"')).toBe(false);
    expect(presentation.includes('from "./_local-rpc-catalog.ts"')).toBe(false);
  });

  test("domain barrel does not import presentation modules", () => {
    const domain = readFileSync(domainPath, "utf8");
    expect(domain.includes('from "./presentation.ts"')).toBe(false);
    expect(domain.includes('from "./a2ui.ts"')).toBe(false);
    expect(domain.includes('from "./conversation.ts"')).toBe(false);
  });

  test("runtime barrel stays inside runtime-v1 modules", () => {
    const runtime = readFileSync(runtimePath, "utf8");
    expect(sparkProtocolSubpathBoundaryViolations("runtime", runtime)).toEqual([]);
  });

  test("rejects every supported root-barrel reference form", () => {
    const forbidden = [
      'import { createId } from "@zendev-lab/spark-protocol";',
      'export { createId } from "@zendev-lab/spark-protocol";',
      'import "@zendev-lab/spark-protocol";',
      'const protocol = import("@zendev-lab/spark-protocol");',
      'type Protocol = import("@zendev-lab/spark-protocol").SparkJsonValue;',
      'const protocol = require("@zendev-lab/spark-protocol");',
    ];
    for (const source of forbidden) {
      expect(findSparkProtocolRootReferences(source), source).toHaveLength(1);
    }
    expect(
      findSparkProtocolRootReferences(
        'import { createId } from "@zendev-lab/spark-protocol/domain";',
      ),
    ).toEqual([]);
  });

  test.each([
    ["presentation", "presentation-imports-daemon.ts"],
    ["domain", "domain-imports-presentation.ts"],
    ["runtime", "runtime-imports-application.ts"],
  ])("rejects forbidden %s boundary fixture with a non-zero exit", (subpath, fixture) => {
    const checker = join(
      here,
      "..",
      "..",
      "..",
      "scripts",
      "check-spark-protocol-boundary-fixture.mjs",
    );
    const fixturePath = join(
      here,
      "..",
      "..",
      "..",
      "test",
      "fixtures",
      "spark-protocol-boundaries",
      fixture,
    );
    expect(() => execFileSync(process.execPath, [checker, subpath, fixturePath])).toThrow();
    expect(
      sparkProtocolSubpathBoundaryViolations(subpath, readFileSync(fixturePath, "utf8")),
    ).not.toEqual([]);
  });

  test("production filtering cannot hide non-test source variants", () => {
    expect(isSparkProductionSourcePath("apps/demo/src/main.mts")).toBe(true);
    expect(isSparkProductionSourcePath("packages/demo/src/main.cts")).toBe(true);
    expect(isSparkProductionSourcePath("packages/demo/src/main.jsx")).toBe(true);
    expect(isSparkProductionSourcePath("packages/demo/src/main.test.ts")).toBe(false);
    expect(isSparkProductionSourcePath("packages/demo/src/__tests__/main.ts")).toBe(false);
  });
});
