import { describe, expect, it } from "vitest";
import { parseSparkDatabaseCompatibilityProbeArguments } from "./database-compatibility-probe.ts";

describe("parseSparkDatabaseCompatibilityProbeArguments", () => {
  it.each(["write-read", "create-write", "read-write"])(
    "normalizes the %s owner read/write action",
    (action) => {
      expect(
        parseSparkDatabaseCompatibilityProbeArguments([
          action,
          "--database",
          "/tmp/test.sqlite",
          "--value",
          "sentinel",
          "--json",
        ]),
      ).toEqual({
        action: "write-read",
        databasePath: "/tmp/test.sqlite",
        json: true,
        value: "sentinel",
      });
    },
  );

  it("parses a migration-scoped deterministic interruption", () => {
    expect(
      parseSparkDatabaseCompatibilityProbeArguments([
        "interrupt",
        "--database",
        "/tmp/test.sqlite",
        "--migration",
        "0022",
        "--boundary",
        "before-commit",
        "--json",
      ]),
    ).toEqual({
      action: "interrupt",
      databasePath: "/tmp/test.sqlite",
      json: true,
      migrationId: "0022",
      boundary: "before-commit",
    });
  });

  it.each(["future", "dirty", "checksum"])("parses unsafe %s injection", (kind) => {
    expect(
      parseSparkDatabaseCompatibilityProbeArguments([
        "inject-unsafe",
        "--database",
        "/tmp/test.sqlite",
        "--kind",
        kind,
        "--json",
      ]),
    ).toMatchObject({ action: "inject-unsafe", unsafeKind: kind });
  });

  it.each([
    [[], /action must/u],
    [["inspect", "--database", "/tmp/test.sqlite"], /requires --json/u],
    [["inspect", "--json"], /requires --database/u],
    [["inspect", "--database", "relative.sqlite", "--json"], /must be absolute/u],
    [
      ["interrupt", "--database", "/tmp/test.sqlite", "--boundary", "other", "--json"],
      /before-commit/u,
    ],
    [["inject-unsafe", "--database", "/tmp/test.sqlite", "--json"], /requires --kind/u],
    [
      ["inspect", "--database", "/tmp/test.sqlite", "--value", "x", "--json"],
      /not valid for inspect/u,
    ],
  ])("rejects malformed or out-of-contract probe arguments", (argv, error) => {
    expect(() => parseSparkDatabaseCompatibilityProbeArguments(argv)).toThrow(error);
  });
});
