import { describe, expect, it } from "vitest";
import {
  SparkVersionedDataError,
  assertVersionedDataVersion,
  invalidVersionedDataSchema,
  parseVersionedDataJson,
} from "./versioned-data.ts";

const options = {
  source: "/tmp/spark-state.json",
  dataKind: "Spark updater state",
  supportedVersions: [1] as const,
  action: "Run `spark update repair` or remove the file and retry.",
};

function captureError(operation: () => unknown): SparkVersionedDataError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SparkVersionedDataError);
    if (error instanceof SparkVersionedDataError) return error;
  }
  throw new Error("expected SparkVersionedDataError");
}

describe("versioned data diagnostics", () => {
  it("reports malformed JSON with the concrete source and action", () => {
    const error = captureError(() =>
      parseVersionedDataJson('{"schemaVersion":1,"secret":"do-not-echo",', options),
    );

    expect(error.diagnostic).toMatchObject({
      code: "invalid_json",
      source: "/tmp/spark-state.json",
      dataKind: "Spark updater state",
      versionField: "schemaVersion",
      supportedVersions: [1],
      action: "Run `spark update repair` or remove the file and retry.",
    });
    expect(error.message).toContain("is not valid JSON");
    expect(error.message).not.toContain("do-not-echo");
    expect(error.message).toContain("Action: Run `spark update repair`");
  });

  it("distinguishes a non-object root from a missing version", () => {
    const invalidRoot = captureError(() => assertVersionedDataVersion([], options));
    expect(invalidRoot.diagnostic).toMatchObject({
      code: "invalid_root",
      supportedVersions: [1],
    });
    expect(invalidRoot.message).toContain("JSON root must be an object");
    expect(invalidRoot.message).toContain("received an array");

    const missingVersion = captureError(() => assertVersionedDataVersion({}, options));
    expect(missingVersion.diagnostic).toMatchObject({
      code: "missing_version",
      supportedVersions: [1],
    });
    expect(missingVersion.message).toContain('missing "schemaVersion"');
    expect(missingVersion.message).toContain("schemaVersion must be 1");
  });

  it("preserves the received and supported versions", () => {
    const error = captureError(() => assertVersionedDataVersion({ schemaVersion: 2 }, options));

    expect(error.diagnostic).toEqual({
      code: "version_mismatch",
      source: "/tmp/spark-state.json",
      dataKind: "Spark updater state",
      versionField: "schemaVersion",
      supportedVersions: [1],
      receivedVersion: "2",
      message:
        "Spark updater state version mismatch at /tmp/spark-state.json: schemaVersion must be 1; received 2.",
      action: "Run `spark update repair` or remove the file and retry.",
    });
  });

  it("bounds untrusted version values without serializing full objects", () => {
    const oversizedVersion = `v-${"x".repeat(10_000)}`;
    const stringError = captureError(() =>
      assertVersionedDataVersion({ schemaVersion: oversizedVersion }, options),
    );
    expect(stringError.diagnostic.receivedVersion?.length).toBeLessThanOrEqual(240);
    expect(stringError.message).not.toContain(oversizedVersion);

    const objectError = captureError(() =>
      assertVersionedDataVersion(
        { schemaVersion: { nested: "secret payload", another: true } },
        options,
      ),
    );
    expect(objectError.diagnostic.receivedVersion).toBe('an object(keys="nested", "another")');
    expect(objectError.message).not.toContain("secret payload");
  });

  it("accepts an explicitly supported version and custom field", () => {
    const value: unknown = { format: "spark.snapshot.v2" };
    assertVersionedDataVersion(value, {
      ...options,
      versionField: "format",
      supportedVersions: ["spark.snapshot.v1", "spark.snapshot.v2"],
    });

    expect(value.format).toBe("spark.snapshot.v2");
  });

  it("bounds schema issues while retaining exact paths", () => {
    const issues = Array.from({ length: 10 }, (_, index) => ({
      path: `$.field${index}`,
      message: `issue ${index}`,
    }));
    const error = invalidVersionedDataSchema(options, issues, 1);

    expect(error.diagnostic).toMatchObject({
      code: "invalid_schema",
      receivedVersion: "1",
      issues: issues.slice(0, 8),
    });
    expect(error.message).toContain("$.field0: issue 0");
    expect(error.message).toContain("2 additional issue(s) omitted");
    expect(error.message).not.toContain("$.field8");
  });

  it("bounds each schema issue path and message", () => {
    const oversizedPath = `$.${"field".repeat(100)}`;
    const oversizedMessage = "invalid".repeat(100);
    const error = invalidVersionedDataSchema(
      options,
      [{ path: oversizedPath, message: oversizedMessage }],
      1,
    );

    expect(error.diagnostic.issues?.[0]?.path.length).toBeLessThanOrEqual(160);
    expect(error.diagnostic.issues?.[0]?.message.length).toBeLessThanOrEqual(240);
    expect(error.message).not.toContain(oversizedPath);
    expect(error.message).not.toContain(oversizedMessage);
  });
});
