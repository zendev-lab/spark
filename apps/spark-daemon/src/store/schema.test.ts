import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.js";

describe("migrateSparkDaemonDatabase", () => {
  it("creates durable Workbench bindings, typed checkpoints, and action receipts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      migrateSparkDaemonDatabase(db);
      expect(tableExists(db, "workbench_artifact_bindings")).toBe(true);
      expect(tableExists(db, "workbench_checkpoints")).toBe(true);
      expect(tableExists(db, "workbench_action_receipts")).toBe(true);
      expect(columnNames(db, "workbench_artifact_bindings")).toEqual(
        expect.arrayContaining([
          "owner_session_id",
          "goal_id",
          "workflow_run_id",
          "loop_id",
          "artifact_ref",
          "revision",
          "artifact_hash",
          "generation",
          "lifecycle",
        ]),
      );
      expect(primaryKeyColumns(db, "workbench_checkpoints")).toEqual([
        "binding_id",
        "checkpoint_id",
      ]);
    } finally {
      db.close();
    }
  });

  it("migrates the draft-global Workbench checkpoint key to binding scope", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE workbench_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        stage TEXT NOT NULL,
        artifact_ref TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        artifact_hash TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);

      migrateSparkDaemonDatabase(db);

      expect(primaryKeyColumns(db, "workbench_checkpoints")).toEqual([
        "binding_id",
        "checkpoint_id",
      ]);
    } finally {
      db.close();
    }
  });

  it("renames legacy daemon-owned tables before applying the current schema", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE runner_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO runner_meta (key, value, updated_at)
        VALUES ('schema', 'legacy', '2026-06-20T00:00:00.000Z');
      `);

      migrateSparkDaemonDatabase(db);

      expect(tableExists(db, "runner_meta")).toBe(false);
      expect(tableExists(db, "daemon_meta")).toBe(true);
      expect(db.prepare("SELECT value FROM daemon_meta WHERE key = ?").get("schema")).toMatchObject(
        { value: "legacy" },
      );
    } finally {
      db.close();
    }
  });

  it("upgrades pending completion deliveries with claim lease columns", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE session_request_completion_deliveries (
          source_invocation_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          delivered_at TEXT
        );
        INSERT INTO session_request_completion_deliveries
          (source_invocation_id, status, attempt_count, created_at, updated_at)
        VALUES ('inv_pending', 'pending', 2, '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:01.000Z');
      `);

      migrateSparkDaemonDatabase(db);

      const columns = db.prepare("PRAGMA table_info(session_request_completion_deliveries)").all();
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "claim_token" }),
          expect.objectContaining({ name: "claim_expires_at" }),
        ]),
      );
      expect(
        db.prepare("SELECT status, attempt_count FROM session_request_completion_deliveries").get(),
      ).toEqual({ status: "pending", attempt_count: 2 });
    } finally {
      db.close();
    }
  });

  it("expands legacy workspace client rows with nullable session lease columns", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE daemon_workspace_clients (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          display_name TEXT,
          status TEXT NOT NULL,
          attached_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          lease_expires_at TEXT,
          released_at TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        INSERT INTO daemon_workspace_clients
          (id, workspace_id, kind, status, attached_at, last_seen_at, metadata_json)
        VALUES
          ('legacy-client', 'workspace-1', 'interactive', 'connected',
           '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '{}');
      `);

      migrateSparkDaemonDatabase(db);
      migrateSparkDaemonDatabase(db);

      expect(columnNames(db, "daemon_workspace_clients")).toEqual(
        expect.arrayContaining(["session_id", "lease_fence"]),
      );
      expect(
        db
          .prepare(
            "SELECT session_id AS sessionId, lease_fence AS leaseFence FROM daemon_workspace_clients WHERE id = ?",
          )
          .get("legacy-client"),
      ).toEqual({ sessionId: null, leaseFence: null });
    } finally {
      db.close();
    }
  });

  it("retires permanent daemon error rows without deleting other outbox work", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
        VALUES
          ('evt_error_1', 'daemon.error', '{}', 'pending', '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z'),
          ('evt_error_2', 'daemon.error', '{}', 'pending', '2026-06-20T00:00:01.000Z', '2026-06-20T00:00:01.000Z'),
          ('evt_projection', 'projection.example', '{}', 'pending', '2026-06-20T00:00:02.000Z', '2026-06-20T00:00:02.000Z');
      `);

      migrateSparkDaemonDatabase(db);
      db.prepare(
        `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
         VALUES ('evt_error_late', 'daemon.error', '{}', 'pending', '2026-06-20T00:00:03.000Z', '2026-06-20T00:00:03.000Z')`,
      ).run();
      migrateSparkDaemonDatabase(db);

      expect(db.prepare("SELECT id, kind FROM outbox ORDER BY id").all()).toEqual([
        { id: "evt_projection", kind: "projection.example" },
      ]);
      expect(
        db
          .prepare("SELECT value FROM daemon_meta WHERE key = ?")
          .get("migration.retire-daemon-error-outbox-v1"),
      ).toEqual({ value: "complete" });
    } finally {
      db.close();
    }
  });

  it("migrates bound drivers and retires hook-owned legacy kinds", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      db.exec(`
        CREATE TABLE driver_wakeups (
          driver_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          lane TEXT NOT NULL,
          owner_session_id TEXT NOT NULL,
          continuity TEXT NOT NULL,
          status TEXT NOT NULL,
          generation INTEGER NOT NULL,
          due_at TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          last_invocation_id TEXT,
          reason TEXT,
          error TEXT,
          prompt TEXT NOT NULL,
          wake_prompt TEXT,
          route_json TEXT NOT NULL,
          domain_state_digest TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO invocations (
           id, status, task_json, source_kind, created_at, updated_at
         ) VALUES (?, 'running', ?, 'loop.tick', ?, ?)`,
      ).run(
        "inv-implement",
        JSON.stringify({ type: "loop.tick", kind: "implement" }),
        "2026-07-25T00:00:00.000Z",
        "2026-07-25T00:00:00.000Z",
      );
      const insertDriver = db.prepare(
        `INSERT INTO driver_wakeups (
           driver_id, kind, lane, owner_session_id, continuity, status, generation,
           attempt, last_invocation_id, prompt, route_json, created_at, updated_at
         ) VALUES (?, ?, ?, 'session-one', 'session', 'running', 1, 0, ?, 'prompt', ?, ?, ?)`,
      );
      const route = JSON.stringify({ cwd: "/tmp/project" });
      insertDriver.run(
        "implement:session-one",
        "implement",
        "foreground",
        "inv-implement",
        route,
        "2026-07-25T00:00:00.000Z",
        "2026-07-25T00:00:00.000Z",
      );
      insertDriver.run(
        "goal-one",
        "goal",
        "foreground",
        null,
        route,
        "2026-07-25T00:00:00.000Z",
        "2026-07-25T00:00:00.000Z",
      );

      migrateSparkDaemonDatabase(db);

      expect(db.prepare("SELECT loop_id, binding_json FROM loop_wakeups").all()).toEqual([
        { loop_id: "goal-one", binding_json: '{"goalId":"goal-one"}' },
      ]);
      expect(
        db.prepare("SELECT status, error_code FROM invocations WHERE id = ?").get("inv-implement"),
      ).toEqual({ status: "cancelled", error_code: "LOOP_BINDING_RETIRED" });
      expect(columnNames(db, "driver_wakeups")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("widens an existing channel delivery ledger for durable inbound receipts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE channel_deliveries (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('reply', 'ask', 'interaction_ack')),
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'delivered')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          next_attempt_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_token TEXT,
          lease_expires_at TEXT,
          claimed_at TEXT,
          last_error TEXT,
          receipt_json TEXT,
          delivered_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO channel_deliveries (
          id, kind, idempotency_key, payload_json, status, next_attempt_at, created_at, updated_at
        ) VALUES (
          'old-reply', 'reply', 'old-reply-key', '{}', 'pending',
          '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
        );
      `);

      migrateSparkDaemonDatabase(db);
      db.prepare(
        `INSERT INTO channel_deliveries (
           id, kind, idempotency_key, payload_json, status, next_attempt_at, created_at, updated_at
         ) VALUES (?, 'inbound', ?, '{}', 'pending', ?, ?, ?)`,
      ).run(
        "new-inbound",
        "new-inbound-key",
        "2026-07-15T00:00:01.000Z",
        "2026-07-15T00:00:01.000Z",
        "2026-07-15T00:00:01.000Z",
      );

      expect(db.prepare("SELECT id, kind FROM channel_deliveries ORDER BY id").all()).toEqual([
        { id: "new-inbound", kind: "inbound" },
        { id: "old-reply", kind: "reply" },
      ]);
      expect(indexNames(db, "channel_deliveries")).toContain("channel_deliveries_due_idx");
    } finally {
      db.close();
    }
  });

  it("creates the durable invocation lifecycle schema and indexes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      expect(tableExists(db, "invocations")).toBe(true);
      expect(tableExists(db, "invocation_events")).toBe(true);
      expect(tableExists(db, "loop_wakeups")).toBe(true);
      expect(tableExists(db, "loop_hidden_sessions")).toBe(true);
      expect(tableExists(db, "invocation_event_deliveries")).toBe(true);
      expect(tableExists(db, "invocation_event_delivery_consumers")).toBe(true);
      expect(tableExists(db, "runtime_command_receipts")).toBe(true);
      expect(tableExists(db, "qqbot_gateway_cursors")).toBe(true);
      expect(columnNames(db, "runtime_command_receipts")).toEqual(
        expect.arrayContaining([
          "command_id",
          "payload_hash",
          "session_id",
          "idempotency_key",
          "request_message_id",
          "claim_token",
          "lease_expires_at",
          "payload_json",
          "delivery_count",
          "ack_json",
          "terminal_message_id",
          "terminal_json",
          "terminal_acked_at",
        ]),
      );
      expect(columnNames(db, "invocations")).toEqual(
        expect.arrayContaining([
          "session_id",
          "idempotency_key",
          "retry_of_invocation_id",
          "worker_id",
          "cancel_reason",
          "error_code",
          "error_message",
          "claimed_at",
          "started_at",
          "finished_at",
        ]),
      );
      expect(columnNames(db, "loop_wakeups")).toEqual(
        expect.arrayContaining([
          "loop_id",
          "owner_session_id",
          "binding_json",
          "continuity",
          "status",
          "generation",
          "cycle_step",
          "due_at",
          "attempt",
          "last_invocation_id",
          "domain_state_digest",
          "wake_prompt",
        ]),
      );
      expect(indexNames(db, "loop_wakeups")).toEqual(
        expect.arrayContaining(["loop_wakeups_due_idx", "loop_wakeups_owner_idx"]),
      );
      expect(indexNames(db, "loop_hidden_sessions")).toContain("loop_hidden_sessions_gc_idx");
      expect(indexNames(db, "invocations")).toEqual(
        expect.arrayContaining([
          "invocations_status_idx",
          "invocations_session_status_idx",
          "invocations_session_updated_idx",
        ]),
      );
      expect(indexNames(db, "invocation_events")).toEqual(
        expect.arrayContaining([
          "invocation_events_cursor_idx",
          "invocation_events_delivery_order_idx",
        ]),
      );
      expect(indexColumns(db, "invocation_events_delivery_order_idx")).toEqual([
        "created_at",
        "invocation_id",
        "sequence",
      ]);
      expect(() => migrateSparkDaemonDatabase(db)).not.toThrow();
      expect(indexColumns(db, "invocation_events_delivery_order_idx")).toEqual([
        "created_at",
        "invocation_id",
        "sequence",
      ]);
      expect(indexNames(db, "invocation_event_deliveries")).toContain(
        "invocation_event_deliveries_cursor_idx",
      );
      expect(indexNames(db, "runtime_command_receipts")).toContain(
        "runtime_command_receipts_terminal_idx",
      );
    } finally {
      db.close();
    }
  });

  it("migrates an existing driver runtime schema into loop storage", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE driver_wakeups (
          driver_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          lane TEXT NOT NULL,
          owner_session_id TEXT NOT NULL,
          continuity TEXT NOT NULL,
          status TEXT NOT NULL,
          generation INTEGER NOT NULL,
          due_at TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          last_invocation_id TEXT,
          reason TEXT,
          error TEXT,
          prompt TEXT NOT NULL,
          route_json TEXT NOT NULL,
          domain_state_digest TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO driver_wakeups (
          driver_id, kind, lane, owner_session_id, continuity, status, generation,
          due_at, attempt, last_invocation_id, reason, error, prompt, route_json,
          domain_state_digest, created_at, updated_at
        ) VALUES (
          'goal-legacy', 'goal', 'foreground', 'session-legacy', 'session', 'scheduled', 2,
          '2026-07-01T00:00:00.000Z', 0, NULL, 'legacy', NULL, 'continue', '{}',
          NULL, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        );
      `);

      migrateSparkDaemonDatabase(db);

      expect(columnNames(db, "driver_wakeups")).toEqual([]);
      expect(
        db.prepare("SELECT loop_id, binding_json, generation FROM loop_wakeups").get(),
      ).toEqual({
        loop_id: "goal-legacy",
        binding_json: '{"goalId":"goal-legacy"}',
        generation: 2,
      });
    } finally {
      db.close();
    }
  });

  it("migrates pre-registration workspace rows into daemon-owned workspace projections", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          local_workspace_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          local_path TEXT NOT NULL,
          status TEXT NOT NULL,
          capabilities_json TEXT NOT NULL DEFAULT '{}',
          diagnostics_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (local_workspace_key),
          UNIQUE (local_path)
        );
        INSERT INTO workspaces
          (id, local_workspace_key, display_name, local_path, status, capabilities_json, diagnostics_json, created_at, updated_at)
        VALUES
          ('rtwb_legacy_available', 'workspace-a', 'Workspace A', '/tmp/workspace-a', 'available', '{}', '{}', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
          ('rtwb_legacy_detached', 'workspace-b', 'Workspace B', '/tmp/workspace-b', 'unavailable', '{}', '{"userDetached":true}', '2026-06-02T00:00:00.000Z', '2026-06-03T00:00:00.000Z');
      `);

      migrateSparkDaemonDatabase(db);

      expect(workspaceColumns(db, "workspaces")).toEqual(
        expect.arrayContaining(["server_url", "profile_source_kind", "profile_imported_at"]),
      );
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE server_url = ''").get(),
      ).toMatchObject({ count: 2 });
      expect(
        db
          .prepare(
            `SELECT rw.name,
                    rw.slug,
                    rw.local_path AS localPath,
                    rw.last_known_status AS lastKnownStatus,
                    rw.last_known_offline_reason AS lastKnownOfflineReason,
                    rs.server_url AS serverUrl
             FROM daemon_workspaces rw
             JOIN daemon_servers rs ON rs.id = rw.server_id
             ORDER BY rw.id`,
          )
          .all(),
      ).toEqual([
        {
          name: "Workspace A",
          slug: "workspace-a",
          localPath: "/tmp/workspace-a",
          lastKnownStatus: "available",
          lastKnownOfflineReason: null,
          serverUrl: "",
        },
        {
          name: "Workspace B",
          slug: "workspace-b",
          localPath: "/tmp/workspace-b",
          lastKnownStatus: "unavailable",
          lastKnownOfflineReason: "user-detached",
          serverUrl: "",
        },
      ]);
      expect(tableExists(db, "daemon_workspace_clients")).toBe(true);
    } finally {
      db.close();
    }
  });
  it("adds durable cycle policy, checkpoint, counters, and Goal settlement storage", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE loop_wakeups (
          loop_id TEXT PRIMARY KEY,
          owner_session_id TEXT NOT NULL,
          binding_json TEXT NOT NULL DEFAULT '{}',
          continuity TEXT NOT NULL,
          status TEXT NOT NULL,
          generation INTEGER NOT NULL,
          cycle_step TEXT,
          due_at TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          last_invocation_id TEXT,
          reason TEXT,
          error TEXT,
          prompt TEXT NOT NULL,
          wake_prompt TEXT,
          route_json TEXT NOT NULL,
          domain_state_digest TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO loop_wakeups
          (loop_id, owner_session_id, continuity, status, generation, prompt, route_json,
           created_at, updated_at)
        VALUES
          ('legacy-loop', 'owner', 'session', 'scheduled', 1, 'tick', '{"cwd":"/workspace"}',
           '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z');
      `);

      migrateSparkDaemonDatabase(db);
      migrateSparkDaemonDatabase(db);

      expect(columnNames(db, "loop_wakeups")).toEqual(
        expect.arrayContaining([
          "policy_json",
          "workflow_definition_digest",
          "checkpoint_json",
          "counters_json",
        ]),
      );
      expect(tableExists(db, "loop_goal_settlements")).toBe(true);
      expect(
        db
          .prepare(
            "SELECT policy_json AS policy, checkpoint_json AS checkpoint, counters_json AS counters FROM loop_wakeups WHERE loop_id = 'legacy-loop'",
          )
          .get(),
      ).toMatchObject({
        policy: expect.stringContaining('"cadenceMs":30000'),
        checkpoint: null,
        counters: expect.stringContaining('"llmRequestsAvoided":0'),
      });
    } finally {
      db.close();
    }
  });
});

function workspaceColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return workspaceColumns(db, table);
}

function primaryKeyColumns(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

function indexNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(
    (index) => index.name,
  );
}

function indexColumns(db: DatabaseSync, index: string): string[] {
  return (db.prepare("PRAGMA index_info(" + index + ")").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}
