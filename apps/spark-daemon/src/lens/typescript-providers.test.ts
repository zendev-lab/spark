import { describe, expect, test } from "vitest";

import type { ProviderId, ProviderVersion } from "@zendev-lab/spark-lens";

import { parseTscDiagnostics, parseVitePlusDiagnostics } from "./typescript-providers.ts";

const id = "fixture" as ProviderId;
const version = "1.0.0" as ProviderVersion;

describe("TypeScript diagnostic parsers", () => {
  test("normalizes tsc diagnostics", () => {
    expect(
      parseTscDiagnostics(
        "src/index.ts(4,3): error TS2322: Type 'string' is not assignable to type 'number'.",
        id,
        version,
        12,
      ),
    ).toEqual([
      expect.objectContaining({
        path: "src/index.ts",
        line: 3,
        character: 2,
        code: "TS2322",
        severity: "error",
      }),
    ]);
  });

  test("normalizes Vite+ native type diagnostics", () => {
    expect(
      parseVitePlusDiagnostics(
        [
          "x typescript(TS2322): Type 'string' is not assignable to type 'number'.",
          "   ,-[src/index.ts:4:3]",
        ].join("\n"),
        id,
        version,
        20,
      ),
    ).toEqual([
      expect.objectContaining({
        path: "src/index.ts",
        line: 3,
        character: 2,
        code: "TS2322",
        severity: "error",
      }),
    ]);
  });
});
