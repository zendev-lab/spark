import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { migrate, openDatabase } from "@zendev-lab/spark-hub-storage-sqlite";
import { createId } from "@zendev-lab/spark-protocol";

import { runSparkHubCli } from "./hub-cli.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("creates, lists, and shows a durable Hub delegation through canonical CLI commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "spark-hub-cli-"));
  roots.push(root);
  const databasePath = join(root, "hub.sqlite");
  const db = openDatabase({ path: databasePath });
  migrate(db);
  const now = "2026-08-03T00:00:00.000Z";
  db.prepare(
    `INSERT INTO users
      (id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, 'owner@example.test', 'Owner', 'owner', 'active', ?, ?)`,
  ).run(createId("usr"), now, now);
  const sourceWorkspaceId = createId("ws");
  const targetWorkspaceId = createId("ws");
  const insertWorkspace = db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, status, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
  );
  insertWorkspace.run(sourceWorkspaceId, "source", "Source", now, now);
  insertWorkspace.run(targetWorkspaceId, "target", "Target", now, now);
  db.prepare("UPDATE workspaces SET provisioning_state = 'active' WHERE id IN (?, ?)").run(
    sourceWorkspaceId,
    targetWorkspaceId,
  );
  const sourceRuntimeId = createId("rt");
  const sourceBindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
       created_at, updated_at)
     VALUES (?, 'install-source', 'Source runtime', 'offline', '1', '{}', '{}', ?, ?)`,
  ).run(sourceRuntimeId, now, now);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
       diagnostics_json, administrator_session_id, administrator_provisioning_state,
       created_at, updated_at)
     VALUES (?, ?, 'source-local', 'Source', 'available', '{}', '{}',
             'sess_source_administrator', 'active', ?, ?)`,
  ).run(sourceBindingId, sourceRuntimeId, now, now);
  db.prepare(
    `INSERT INTO workspace_leases
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
     VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
  ).run(createId("wob"), sourceWorkspaceId, sourceBindingId, now, now);
  db.close();

  const createdOutput: string[] = [];
  const errors: string[] = [];
  const code = await runSparkHubCli(
    [
      "delegation",
      "create",
      "--source",
      "source",
      "--target",
      "target",
      "--goal",
      "Validate compatibility",
      "--database",
      databasePath,
      "--json",
    ],
    { write: (text) => createdOutput.push(text) },
    { write: (text) => errors.push(text) },
  );
  expect(errors).toEqual([]);
  expect(code).toBe(0);
  const created = JSON.parse(createdOutput.join("\n")) as {
    delegation: { request: { delegationId: string }; status: string };
  };
  expect(created.delegation.status).toBe("retry_wait");

  const listOutput: string[] = [];
  expect(
    await runSparkHubCli(
      ["delegation", "list", "--workspace", "source", "--database", databasePath, "--json"],
      { write: (text) => listOutput.push(text) },
      { write: (text) => errors.push(text) },
    ),
  ).toBe(0);
  expect(JSON.parse(listOutput.join("\n")).delegations).toHaveLength(1);

  const showOutput: string[] = [];
  expect(
    await runSparkHubCli(
      [
        "delegation",
        "show",
        created.delegation.request.delegationId,
        "--database",
        databasePath,
        "--json",
      ],
      { write: (text) => showOutput.push(text) },
      { write: (text) => errors.push(text) },
    ),
  ).toBe(0);
  expect(JSON.parse(showOutput.join("\n"))).toMatchObject({
    plane: "hub",
    resource: "delegation",
    messages: [{ sequence: 1, kind: "request", deliveryStatus: "queued" }],
  });
});

it("lists daemons as the hub binding unit with their workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "spark-hub-cli-"));
  roots.push(root);
  const databasePath = join(root, "hub.sqlite");
  const db = openDatabase({ path: databasePath });
  migrate(db);
  const now = "2026-08-03T00:00:00.000Z";
  const runtimeId = createId("rt");
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
       enrollment_scopes_json, created_at, updated_at)
     VALUES (?, 'install-machine-a', 'Machine A daemon', 'online', '1', '{}', '{}',
             '["daemon:attach", "runtime:refresh"]', ?, ?)`,
  ).run(runtimeId, now, now);
  const workspaceId = createId("ws");
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, status, settings_json, created_at, updated_at)
     VALUES (?, 'spore', 'Spore', 'active', '{}', ?, ?)`,
  ).run(workspaceId, now, now);
  const bindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, local_path, display_name, status, capabilities_json,
       diagnostics_json, administrator_session_id, administrator_provisioning_state,
       created_at, updated_at)
     VALUES (?, ?, 'spore', '/Users/test/workspaces/spore', 'Spore', 'available', '{}', '{}',
             'sess_spore_administrator', 'active', ?, ?)`,
  ).run(bindingId, runtimeId, now, now);
  db.prepare(
    `INSERT INTO workspace_leases
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
     VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
  ).run(createId("wob"), workspaceId, bindingId, now, now);
  db.close();

  const output: string[] = [];
  const errors: string[] = [];
  const code = await runSparkHubCli(
    ["daemon", "list", "--database", databasePath, "--json"],
    { write: (text) => output.push(text) },
    { write: (text) => errors.push(text) },
  );
  expect(errors).toEqual([]);
  expect(code).toBe(0);
  const parsed = JSON.parse(output.join("\n")) as {
    plane: string;
    resource: string;
    daemons: Array<{
      id: string;
      installationId: string;
      name: string;
      status: string;
      workspaceCount: number;
      workspaceNames: string[];
      enrollmentScope: string;
    }>;
  };
  expect(parsed).toMatchObject({ plane: "hub", resource: "daemon" });
  expect(parsed.daemons).toEqual([
    {
      id: runtimeId,
      installationId: "install-machine-a",
      name: "Machine A daemon",
      status: "online",
      protocolVersion: "1",
      workspaceCount: 1,
      workspaceNames: ["Spore"],
      enrollmentScope: "daemon",
    },
  ]);
});
