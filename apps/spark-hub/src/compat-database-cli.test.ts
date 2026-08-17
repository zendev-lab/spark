import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHubCompatDatabaseCli } from "./compat-database-cli.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spark-hub-compat-probe-"));
  roots.push(root);
  return { database: join(root, "hub.sqlite") };
}

async function invoke(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runHubCompatDatabaseCli(argv, {
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  return {
    code,
    stdout: stdout ? JSON.parse(stdout) : undefined,
    stderr: stderr ? JSON.parse(stderr) : undefined,
  };
}

describe("Hub packaged database compatibility probe", () => {
  it("writes and reads a sentinel through the owner access-token path", async () => {
    const { database } = fixture();
    const created = await invoke([
      "write-read",
      "--database",
      database,
      "--value",
      "baseline",
      "--json",
    ]);
    expect(created).toMatchObject({
      code: 0,
      stdout: {
        schemaVersion: 1,
        action: "write-read",
        owner: "hub",
        head: "0024",
        sentinel: "baseline",
        previousValues: expect.any(Array),
      },
    });
    expect(created.stdout.ledger).toHaveLength(24);
    expect(created.stdout.ledger.every(({ state }: { state: string }) => state === "clean")).toBe(
      true,
    );
    expect((await invoke(["inspect", "--database", database, "--json"])).stdout).toMatchObject({
      sentinel: "baseline",
    });
    expect(
      (await invoke(["write-read", "--database", database, "--value", "candidate", "--json"]))
        .stdout,
    ).toMatchObject({
      sentinel: "candidate",
      previousValues: expect.arrayContaining(["baseline"]),
    });
  });

  it("uses a deterministic default sentinel when --value is omitted", async () => {
    const { database } = fixture();
    expect(await invoke(["write-read", "--database", database, "--json"])).toMatchObject({
      code: 0,
      stdout: { sentinel: "spark-database-compatibility-sentinel" },
    });
  });

  it.each(["future", "dirty", "checksum"])("rejects unsafe %s state", async (kind) => {
    const { database } = fixture();
    expect(
      (await invoke(["write-read", "--database", database, "--value", "seed", "--json"])).code,
    ).toBe(0);
    expect(
      await invoke(["inject-unsafe", "--database", database, "--kind", kind, "--json"]),
    ).toMatchObject({ code: 0, stdout: { owner: "hub", injected: kind } });
    expect((await invoke(["inspect", "--database", database, "--json"])).code).toBe(1);
  });

  it("rolls back a deterministic SQL interruption and reopens cleanly", async () => {
    const { database } = fixture();
    expect(
      await invoke(["interrupt", "--database", database, "--boundary", "before-commit", "--json"]),
    ).toMatchObject({ code: 1, stderr: { owner: "hub", ok: false } });
    expect(await invoke(["inspect", "--database", database, "--json"])).toMatchObject({
      code: 0,
      stdout: { schemaVersion: 1, owner: "hub", previousValues: [] },
    });
  });
});
