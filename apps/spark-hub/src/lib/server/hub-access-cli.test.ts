import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";

import { runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openDatabase } from "@zendev-lab/spark-hub-storage-sqlite";

import { handleHubAccessCliCommand } from "./hub-access-cli.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedRuntime(databasePath: string, runtimeId: string): void {
  const db = openDatabase({ path: databasePath });
  try {
    migrate(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, ?, 'CLI runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, "install-cli", runtimeProtocolVersion, now, now);
  } finally {
    db.close();
  }
}

it("creates a Hub access key bound to daemon grants and lists only metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "spark-hub-access-cli-"));
  roots.push(root);
  const databasePath = join(root, "hub.sqlite");
  seedRuntime(databasePath, "rt_cli_access");

  const created = await handleHubAccessCliCommand({
    operation: "create",
    databasePath,
    label: "Remote bootstrap",
    daemons: ["rt_cli_access"],
    user: "reviewer",
  });
  assert.equal(created.operation, "create");
  assert.equal(created.status, "created");
  if (created.operation !== "create") throw new Error("expected create");
  assert.match(created.token, /^spark_hub_auth_/);
  assert.equal(created.loginPath, "/login");
  assert.match(created.text, /shown once/);
  assert.match(created.text, /rt_cli_access/);
  assert.match(created.text, /reviewer/);

  const listed = await handleHubAccessCliCommand({
    operation: "list",
    databasePath,
  });
  assert.equal(listed.operation, "list");
  if (listed.operation !== "list") throw new Error("expected list");
  assert.equal(listed.tokens.length, 1);
  assert.equal(listed.tokens[0]?.id, created.tokenId);
  assert.deepEqual(listed.tokens[0]?.daemonIds, ["rt_cli_access"]);
  assert.equal(listed.tokens[0]?.memberName, "reviewer");
  assert.doesNotMatch(JSON.stringify(listed.tokens), /spark_hub_auth_/);

  const revoked = await handleHubAccessCliCommand({
    operation: "revoke",
    databasePath,
    tokenId: created.tokenId,
  });
  assert.equal(revoked.status, "revoked");
});

it("requires at least one daemon grant when creating a Hub access key", async () => {
  const root = mkdtempSync(join(tmpdir(), "spark-hub-access-cli-"));
  roots.push(root);
  const databasePath = join(root, "hub.sqlite");
  seedRuntime(databasePath, "rt_cli_access");

  await assert.rejects(
    () => handleHubAccessCliCommand({ operation: "create", databasePath }),
    /--daemon/u,
  );
});
