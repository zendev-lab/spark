import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";

import { migrate, openDatabase } from "@zendev-lab/spark-hub-storage-sqlite";

import { handleHubAccessCliCommand } from "./hub-access-cli.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("creates a Hub access key once and lists only metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "spark-hub-access-cli-"));
  roots.push(root);
  const databasePath = join(root, "hub.sqlite");
  const db = openDatabase({ path: databasePath });
  migrate(db);
  db.close();

  const created = await handleHubAccessCliCommand({
    operation: "create",
    databasePath,
    label: "Remote bootstrap",
  });
  assert.equal(created.operation, "create");
  assert.equal(created.status, "created");
  if (created.operation !== "create") throw new Error("expected create");
  assert.match(created.token, /^spark_hub_auth_/);
  assert.equal(created.loginPath, "/login");
  assert.match(created.text, /shown once/);

  const listed = await handleHubAccessCliCommand({
    operation: "list",
    databasePath,
  });
  assert.equal(listed.operation, "list");
  if (listed.operation !== "list") throw new Error("expected list");
  assert.equal(listed.tokens.length, 1);
  assert.equal(listed.tokens[0]?.id, created.tokenId);
  assert.doesNotMatch(JSON.stringify(listed.tokens), /spark_hub_auth_/);

  const revoked = await handleHubAccessCliCommand({
    operation: "revoke",
    databasePath,
    tokenId: created.tokenId,
  });
  assert.equal(revoked.status, "revoked");
});
