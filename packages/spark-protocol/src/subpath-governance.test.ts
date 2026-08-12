import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

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
    for (const line of runtime.split("\n")) {
      if (!line.includes("from ")) continue;
      if (!line.includes("./")) continue;
      expect(line.includes("./runtime-v1/")).toBe(true);
    }
  });
});
