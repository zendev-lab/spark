import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDaemonCompatDatabaseCli } from "./compat-database-cli.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-compat-probe-"));
  roots.push(root);
  return { database: join(root, "daemon.sqlite") };
}

function invoke(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runDaemonCompatDatabaseCli(argv, {
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  return {
    code,
    stdout: stdout ? JSON.parse(stdout) : undefined,
    stderr: stderr ? JSON.parse(stderr) : undefined,
  };
}

describe("daemon packaged database compatibility probe", () => {
  it("writes and reads a sentinel through the owner database path", () => {
    const { database } = fixture();
    const created = invoke(["write-read", "--database", database, "--value", "baseline", "--json"]);
    expect(created).toMatchObject({
      code: 0,
      stdout: {
        schemaVersion: 1,
        action: "write-read",
        owner: "daemon",
        head: "legacy-inline-v0",
        sentinel: "baseline",
        previousValues: expect.any(Array),
      },
    });
    expect(created.stdout.ledger).toEqual([
      expect.objectContaining({ id: "legacy-inline-v0", state: "legacy-unverified" }),
    ]);
    expect(invoke(["inspect", "--database", database, "--json"]).stdout).toMatchObject({
      sentinel: "baseline",
    });
    expect(
      invoke(["write-read", "--database", database, "--value", "candidate", "--json"]).stdout,
    ).toMatchObject({
      sentinel: "candidate",
      previousValues: expect.arrayContaining(["baseline"]),
    });
  });

  it("uses a deterministic default sentinel when --value is omitted", () => {
    const { database } = fixture();
    expect(invoke(["write-read", "--database", database, "--json"])).toMatchObject({
      code: 0,
      stdout: { sentinel: "spark-database-compatibility-sentinel" },
    });
  });

  it.each(["future", "dirty", "checksum"])("rejects unsafe %s state", (kind) => {
    const { database } = fixture();
    expect(invoke(["write-read", "--database", database, "--value", "seed", "--json"]).code).toBe(
      0,
    );
    expect(
      invoke(["inject-unsafe", "--database", database, "--kind", kind, "--json"]),
    ).toMatchObject({ code: 0, stdout: { owner: "daemon", injected: kind } });
    expect(invoke(["inspect", "--database", database, "--json"]).code).toBe(1);
  });

  it("rolls back a deterministic interruption and reopens cleanly", () => {
    const { database } = fixture();
    expect(
      invoke(["interrupt", "--database", database, "--boundary", "before-commit", "--json"]),
    ).toMatchObject({ code: 1, stderr: { owner: "daemon", ok: false } });
    expect(invoke(["inspect", "--database", database, "--json"])).toMatchObject({
      code: 0,
      stdout: {
        schemaVersion: 1,
        owner: "daemon",
        previousValues: ["legacy-daemon-schema"],
      },
    });
  });
});
