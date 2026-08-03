import { CARGO_CHECK_PROVIDER_ID, type ProviderVersion } from "@zendev-lab/spark-lens";
import { describe, expect, test } from "vitest";

import {
  inspectPythonRustProfiles,
  parseBasedPyrightDiagnostics,
  parseCargoDiagnostics,
  parseRuffDiagnostics,
  parseTyConciseDiagnostics,
} from "./language-toolchains.ts";

const version = "1.0.0" as ProviderVersion;

describe("Python and Rust Lens toolchains", () => {
  test("reports missing providers without auto-installing and finds the local Rust toolchain", async () => {
    const health = await inspectPythonRustProfiles(process.cwd());
    expect(health.python.providers.find((provider) => provider.providerId === "ty")).toMatchObject({
      available: false,
    });
    expect(
      health.rust.providers.find((provider) => provider.providerId === "cargo-check"),
    ).toMatchObject({
      available: true,
      source: "system",
      requiresExplicitTrust: true,
    });
  });

  test("normalizes ty, BasedPyright, Ruff, and Cargo diagnostics", () => {
    expect(
      parseTyConciseDiagnostics(
        "src/app.py:3:5: error[invalid-return-type]: Expected str",
        version,
        10,
      )[0],
    ).toMatchObject({ providerId: "ty", line: 2, character: 4 });
    expect(
      parseBasedPyrightDiagnostics(
        JSON.stringify({
          generalDiagnostics: [
            {
              file: "src/app.py",
              severity: "error",
              message: "Type mismatch",
              rule: "reportAssignmentType",
              range: { start: { line: 4, character: 2 } },
            },
          ],
        }),
        version,
        10,
      )[0],
    ).toMatchObject({ providerId: "basedpyright", line: 4, character: 2 });
    expect(
      parseRuffDiagnostics(
        JSON.stringify([
          {
            filename: "src/app.py",
            code: "F401",
            message: "unused import",
            location: { row: 2, column: 1 },
          },
        ]),
        version,
        10,
      )[0],
    ).toMatchObject({ providerId: "ruff", line: 1, character: 0 });
    expect(
      parseCargoDiagnostics(
        JSON.stringify({
          reason: "compiler-message",
          message: {
            level: "error",
            message: "mismatched types",
            code: { code: "E0308" },
            spans: [
              {
                is_primary: true,
                file_name: "src/lib.rs",
                line_start: 7,
                column_start: 3,
              },
            ],
          },
        }),
        CARGO_CHECK_PROVIDER_ID,
        version,
        10,
      )[0],
    ).toMatchObject({ providerId: "cargo-check", line: 6, character: 2, code: "E0308" });
  });
});
