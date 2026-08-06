import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const checker = resolve("scripts/check-hub-terminology.mjs");
const allowlist = resolve("test/fixtures/hub-compatibility-allowlist.json");

test("every remaining Cockpit reference has exactly one compatibility classification", () => {
  const result = runChecker(resolve("."), allowlist);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Hub terminology compatibility report/u);
  assert.match(result.stdout, /archived-0\.2-documentation/u);
  assert.match(result.stdout, /legacy-layout-migration/u);
  assert.match(result.stdout, /frozen-wire-value/u);
  assert.match(result.stdout, /n-minus-one-updater-compatibility/u);
  assert.match(result.stdout, /classified=\d+ violations=0/u);
});

test("an injected unallowlisted Cockpit reference fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-hub-terminology-"));
  try {
    await mkdir(join(root, "test", "fixtures"), { recursive: true });
    await writeFile(join(root, "active-product.ts"), 'export const product = "Cockpit";\n');
    const fixtureAllowlist = join(root, "test", "fixtures", "allowlist.json");
    await writeFile(fixtureAllowlist, JSON.stringify({ schemaVersion: 2, rules: [] }));

    const result = runChecker(root, fixtureAllowlist);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /active-product\.ts:1/u);
    assert.match(result.stderr, /found 0/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an injected Cockpit reference inside an allowlisted file fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-hub-terminology-bound-"));
  try {
    await mkdir(join(root, "test", "fixtures"), { recursive: true });
    const approvedPath = "approved.ts";
    const approvedLine = 'export const legacy = "Cockpit";';
    await writeFile(join(root, approvedPath), `${approvedLine}\n`);
    const fixtureAllowlist = join(root, "test", "fixtures", "allowlist.json");
    await writeFile(
      fixtureAllowlist,
      JSON.stringify({
        schemaVersion: 2,
        rules: [
          {
            pattern: approvedPath,
            category: "legacy-test",
            approvedOccurrenceCount: 1,
            approvedOccurrencesSha256: occurrenceDigest([`${approvedPath}\u0000${approvedLine}`]),
          },
        ],
      }),
    );

    const approved = runChecker(root, fixtureAllowlist);
    assert.equal(approved.status, 0, approved.stderr);

    await appendFile(join(root, approvedPath), 'export const injected = "Cockpit";\n');
    const injected = runChecker(root, fixtureAllowlist);
    assert.notEqual(injected.status, 0);
    assert.match(injected.stderr, /approved occurrence set changed/u);
    assert.match(injected.stderr, /count 1 -> 2/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function occurrenceDigest(occurrenceIds: string[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...occurrenceIds].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      ),
    )
    .digest("hex");
}

function runChecker(root: string, allowlistPath: string) {
  return spawnSync(process.execPath, [checker], {
    cwd: resolve("."),
    env: {
      ...process.env,
      SPARK_HUB_TERMINOLOGY_ROOT: root,
      SPARK_HUB_TERMINOLOGY_ALLOWLIST: allowlistPath,
    },
    encoding: "utf8",
  });
}
