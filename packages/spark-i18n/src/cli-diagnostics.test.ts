import { describe, expect, it } from "vitest";

import { sparkCliDiagnostic, sparkCliDiagnosticCatalog } from "./cli-presentation.ts";

describe("Spark CLI diagnostic catalog", () => {
  it("keeps stable machine-readable descriptors complete", () => {
    expect(sparkCliDiagnosticCatalog.schemaVersion).toBe(1);
    for (const [code, descriptor] of Object.entries(sparkCliDiagnosticCatalog.diagnostics)) {
      expect(descriptor.code).toBe(code);
      expect(descriptor.title.trim()).not.toBe("");
      expect(descriptor.exitCode).toBeGreaterThan(0);
    }
  });

  it("allows runtime detail without changing stable catalog fields", () => {
    expect(sparkCliDiagnostic("DISPATCH_FAILED", { detail: "ENOENT spark-web" })).toMatchObject({
      code: "DISPATCH_FAILED",
      detail: "ENOENT spark-web",
      exitCode: 127,
    });
  });
});
