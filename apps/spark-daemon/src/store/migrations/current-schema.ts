import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export function prepareCurrentDaemonSchema(db: DatabaseSync): void {
  renameLegacySparkDaemonTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invocations (
      id TEXT PRIMARY KEY,
      command_id TEXT,
      workspace_binding_id TEXT,
      session_id TEXT,
      idempotency_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      prompt TEXT,
      task_json TEXT,
      result_json TEXT,
      source_kind TEXT,
      source_ref TEXT,
      parent_invocation_id TEXT REFERENCES invocations(id),
      retry_of_invocation_id TEXT REFERENCES invocations(id),
      claim_class TEXT NOT NULL DEFAULT 'root' CHECK (claim_class IN ('root', 'structured')),
      execution_profile_json TEXT,
      retention_summary_json TEXT,
      payload_redacted_at TEXT,
      worker_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT,
      error_code TEXT,
      error_message TEXT,
      event_cursor INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      retained_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invocation_events (
      invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (invocation_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS usage_executions (
      execution_id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL REFERENCES invocations(id),
      root_invocation_id TEXT NOT NULL REFERENCES invocations(id),
      parent_execution_id TEXT REFERENCES usage_executions(execution_id),
      scope_kind TEXT NOT NULL CHECK (scope_kind = 'repro'),
      repro_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'root_session', 'side_thread', 'task_execution', 'role_run', 'workflow_agent'
      )),
      kind_provisional INTEGER NOT NULL DEFAULT 0 CHECK (kind_provisional IN (0, 1)),
      detail_kind TEXT,
      persistence TEXT NOT NULL CHECK (persistence IN ('anonymous', 'persistent')),
      session_id TEXT,
      run_ref TEXT,
      started_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage_receipts (
      event_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES usage_executions(execution_id),
      invocation_id TEXT NOT NULL REFERENCES invocations(id),
      response_ordinal INTEGER NOT NULL CHECK (response_ordinal > 0),
      measurement TEXT NOT NULL CHECK (measurement IN ('reported', 'estimated', 'missing')),
      provider TEXT,
      model TEXT,
      provider_response_id TEXT,
      provider_total_tokens INTEGER CHECK (
        provider_total_tokens IS NULL OR provider_total_tokens >= 0
      ),
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
      cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
      reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
      cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
      observed_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_execution_lifecycle_events (
      event_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES usage_executions(execution_id),
      status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'cancelled')),
      observed_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loop_wakeups (
      loop_id TEXT PRIMARY KEY,
      owner_session_id TEXT NOT NULL,
      binding_json TEXT NOT NULL DEFAULT '{}',
      continuity TEXT NOT NULL CHECK (continuity IN ('session', 'fresh')),
      session_lifetime TEXT NOT NULL DEFAULT 'driver' CHECK (session_lifetime IN ('driver', 'driver_tick')),
      driver_session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'retry_wait', 'dormant', 'paused', 'blocked', 'completed', 'stopped')),
      generation INTEGER NOT NULL CHECK (generation > 0),
      cycle_step TEXT CHECK (cycle_step IS NULL OR cycle_step IN ('before_tick', 'invoke', 'after_tick', 'settle')),
      policy_json TEXT NOT NULL DEFAULT '{"cadenceMs":30000,"retry":{"maxAttempts":3,"delaysMs":[30000,60000,120000]},"beforeTick":[],"afterTick":[]}',
      workflow_definition_digest TEXT,
      checkpoint_json TEXT,
      counters_json TEXT NOT NULL DEFAULT '{"tickCount":0,"skippedCount":0,"llmRequestsAvoided":0,"conditionRetryCount":0}',
      due_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      last_invocation_id TEXT REFERENCES invocations(id),
      reason TEXT,
      error TEXT,
      prompt TEXT NOT NULL,
      wake_prompt TEXT,
      route_json TEXT NOT NULL,
      domain_state_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loop_hidden_sessions (
      execution_session_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL REFERENCES loop_wakeups(loop_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0),
      invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      session_path TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT,
      gc_after TEXT
    );

    CREATE TABLE IF NOT EXISTS loop_goal_settlements (
      loop_id TEXT NOT NULL REFERENCES loop_wakeups(loop_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0),
      goal_id TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'error')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT,
      PRIMARY KEY (loop_id, generation)
    );

    CREATE TABLE IF NOT EXISTS workbench_artifact_bindings (
      binding_id TEXT PRIMARY KEY,
      owner_session_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      loop_id TEXT NOT NULL UNIQUE REFERENCES loop_wakeups(loop_id) ON DELETE CASCADE,
      repro_id TEXT NOT NULL,
      artifact_ref TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      artifact_hash TEXT,
      projection_digest TEXT,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('pending', 'live', 'sealed', 'error')),
      generation INTEGER NOT NULL CHECK (generation > 0),
      last_stage TEXT CHECK (last_stage IS NULL OR last_stage IN ('contract', 'reference', 'target', 'alignment', 'delivery')),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sealed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workbench_checkpoints (
      checkpoint_id TEXT NOT NULL,
      binding_id TEXT NOT NULL REFERENCES workbench_artifact_bindings(binding_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('stage', 'final', 'manual')),
      stage TEXT NOT NULL CHECK (stage IN ('contract', 'reference', 'target', 'alignment', 'delivery')),
      artifact_ref TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      artifact_hash TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (binding_id, checkpoint_id)
    );

    CREATE TABLE IF NOT EXISTS workbench_action_receipts (
      idempotency_key TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      binding_id TEXT NOT NULL REFERENCES workbench_artifact_bindings(binding_id) ON DELETE CASCADE,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invocation_event_deliveries (
      destination TEXT NOT NULL,
      invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (destination, invocation_id)
    );

    CREATE TABLE IF NOT EXISTS invocation_event_delivery_consumers (
      destination TEXT PRIMARY KEY,
      registered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_administrator_sessions (
      workspace_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_administrator_provisioning (
      workspace_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('provisioning', 'active', 'failed')),
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daemon_delegation_projections (
      delegation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('source', 'target')),
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'retry_wait', 'delivering', 'running', 'awaiting_source',
        'cancelling', 'completed', 'rejected', 'failed', 'cancelled'
      )),
      request_json TEXT NOT NULL,
      receipt_json TEXT,
      message_sequence INTEGER NOT NULL DEFAULT 0 CHECK (message_sequence >= 0),
      invocation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (delegation_id, workspace_id)
    );

    CREATE INDEX IF NOT EXISTS daemon_delegation_projections_workspace_status_idx
      ON daemon_delegation_projections(workspace_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS session_request_completion_deliveries (
      source_invocation_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claim_token TEXT,
      claim_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS channel_deliveries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('reply', 'ask', 'interaction_ack', 'inbound', 'notification')),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'delivered', 'uncertain')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      claimed_at TEXT,
      dispatched_at TEXT,
      last_error TEXT,
      receipt_json TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qqbot_gateway_cursors (
      workspace_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, adapter_id)
    );

    CREATE TABLE IF NOT EXISTS runtime_command_receipts (
      command_id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('daemon', 'workspace')),
      workspace_binding_id TEXT,
      workspace_id TEXT,
      project_id TEXT,
      session_id TEXT,
      idempotency_key TEXT,
      request_message_id TEXT,
      payload_json TEXT,
      claim_token TEXT,
      lease_expires_at TEXT,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'accepted', 'succeeded', 'failed', 'rejected')),
      delivery_count INTEGER NOT NULL DEFAULT 1,
      ack_json TEXT,
      terminal_message_id TEXT,
      terminal_json TEXT,
      terminal_acked_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daemon_human_waits (
      human_request_id TEXT PRIMARY KEY,
      interaction_request_id TEXT,
      evidence_request_json TEXT,
      invocation_id TEXT,
      workspace_binding_id TEXT,
      workspace_id TEXT,
      project_id TEXT,
      tool_call_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT,
      accepted_response_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daemon_human_answer_events (
      answer_event_id TEXT PRIMARY KEY,
      human_request_id TEXT NOT NULL REFERENCES daemon_human_waits(human_request_id) ON DELETE CASCADE,
      interaction_request_id TEXT NOT NULL,
      human_response_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      wake_completed_at TEXT,
      wake_loop_id TEXT,
      wake_generation INTEGER,
      UNIQUE (human_request_id, human_response_id),
      UNIQUE (interaction_request_id, human_response_id)
    );

    CREATE TABLE IF NOT EXISTS daemon_repro_formal_evidence_receipts (
      receipt_key TEXT PRIMARY KEY,
      workspace_cwd TEXT NOT NULL,
      repro_id TEXT NOT NULL,
      requirement_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lens_provider_results (
      provider_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      produced_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, capability, revision_digest)
    );

    CREATE TABLE IF NOT EXISTS lens_observations (
      observation_ref TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lens_patch_proposals (
      proposal_ref TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      base_revision_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'applied', 'stale', 'rejected')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lens_observation_dispositions (
      observation_ref TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (
        disposition IN ('false_positive', 'deferred', 'flagged', 'suppressed')
      ),
      patch_proposal_ref TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lens_provider_processes (
      process_key TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      worktree_root TEXT NOT NULL,
      project_root TEXT NOT NULL,
      config_digest TEXT NOT NULL,
      executable_digest TEXT NOT NULL,
      daemon_instance_id TEXT NOT NULL,
      process_marker TEXT NOT NULL,
      pid INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'stopped', 'crashed', 'recovered')),
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      exited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS lens_code_symbols (
      workspace_root TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      PRIMARY KEY (workspace_root, symbol_id)
    );

    CREATE TABLE IF NOT EXISTS lens_code_graph_meta (
      workspace_root TEXT PRIMARY KEY,
      revision_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lens_code_files (
      workspace_root TEXT NOT NULL,
      path TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      PRIMARY KEY (workspace_root, path)
    );

    CREATE TABLE IF NOT EXISTS lens_code_edges (
      workspace_root TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      from_path TEXT NOT NULL,
      to_path TEXT,
      from_symbol TEXT,
      to_symbol TEXT,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      PRIMARY KEY (workspace_root, edge_id)
    );

    CREATE INDEX IF NOT EXISTS invocations_status_idx ON invocations(status, created_at);
    CREATE INDEX IF NOT EXISTS loop_wakeups_due_idx
      ON loop_wakeups(status, due_at, updated_at)
      WHERE status IN ('scheduled', 'retry_wait');
    CREATE INDEX IF NOT EXISTS loop_wakeups_owner_idx
      ON loop_wakeups(owner_session_id, status);
    CREATE INDEX IF NOT EXISTS loop_hidden_sessions_gc_idx
      ON loop_hidden_sessions(status, gc_after)
      WHERE status = 'archived';
    CREATE INDEX IF NOT EXISTS loop_goal_settlements_pending_idx
      ON loop_goal_settlements(status, updated_at)
      WHERE status IN ('pending', 'error');
    CREATE INDEX IF NOT EXISTS workbench_artifact_bindings_session_idx
      ON workbench_artifact_bindings(owner_session_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS workbench_checkpoints_binding_idx
      ON workbench_checkpoints(binding_id, created_at);
    CREATE INDEX IF NOT EXISTS invocation_events_cursor_idx
      ON invocation_events(invocation_id, sequence);
    CREATE INDEX IF NOT EXISTS invocation_events_delivery_order_idx
      ON invocation_events(created_at, invocation_id, sequence);
    CREATE INDEX IF NOT EXISTS invocation_event_deliveries_cursor_idx
      ON invocation_event_deliveries(destination, invocation_id, sequence);
    CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox(status, created_at);
    CREATE INDEX IF NOT EXISTS channel_deliveries_due_idx
      ON channel_deliveries(status, next_attempt_at, lease_expires_at, created_at)
      WHERE status IN ('pending', 'retry_wait');
    CREATE TRIGGER IF NOT EXISTS channel_deliveries_idempotency_key_immutable
      BEFORE UPDATE OF idempotency_key ON channel_deliveries
      WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
      BEGIN
        SELECT RAISE(ABORT, 'channel delivery idempotency_key is immutable');
      END;
    CREATE INDEX IF NOT EXISTS runtime_command_receipts_terminal_idx
      ON runtime_command_receipts(terminal_acked_at, completed_at)
      WHERE terminal_json IS NOT NULL;
    CREATE INDEX IF NOT EXISTS daemon_human_waits_status_idx ON daemon_human_waits(status, created_at);
    CREATE INDEX IF NOT EXISTS daemon_human_answer_events_request_idx
      ON daemon_human_answer_events(human_request_id, created_at);
    CREATE INDEX IF NOT EXISTS lens_provider_results_revision_idx
      ON lens_provider_results(revision_digest, capability);
    CREATE INDEX IF NOT EXISTS lens_observations_revision_idx
      ON lens_observations(workspace_root, revision_digest);
    CREATE INDEX IF NOT EXISTS lens_patch_proposals_revision_idx
      ON lens_patch_proposals(workspace_root, base_revision_digest, status);
    CREATE INDEX IF NOT EXISTS lens_observation_dispositions_revision_idx
      ON lens_observation_dispositions(workspace_root, revision_digest);
    CREATE INDEX IF NOT EXISTS lens_provider_processes_status_idx
      ON lens_provider_processes(status, last_heartbeat_at);
    CREATE INDEX IF NOT EXISTS lens_code_symbols_search_idx
      ON lens_code_symbols(workspace_root, revision_digest, name);
    CREATE INDEX IF NOT EXISTS lens_code_symbols_path_idx
      ON lens_code_symbols(workspace_root, revision_digest, path);
    CREATE INDEX IF NOT EXISTS lens_code_edges_from_idx
      ON lens_code_edges(workspace_root, revision_digest, from_path);
    CREATE INDEX IF NOT EXISTS lens_code_edges_to_idx
      ON lens_code_edges(workspace_root, revision_digest, to_path);
  `);
  migrateWorkspaceAdministratorSessionsTable(db);
}

function migrateWorkspaceAdministratorSessionsTable(db: DatabaseSync): void {
  if (!tableExists(db, "workspace_main_sessions")) return;
  db.exec(`
    INSERT OR IGNORE INTO workspace_administrator_sessions
      (workspace_id, session_id, created_at, updated_at)
    SELECT workspace_id, session_id, created_at, updated_at
    FROM workspace_main_sessions;
    DROP TABLE workspace_main_sessions;
  `);
}

export function migrateWorkbenchCheckpointKey(db: DatabaseSync): void {
  const primaryKey = (
    db.prepare("PRAGMA table_info(workbench_checkpoints)").all() as unknown as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  if (primaryKey.join(",") === "binding_id,checkpoint_id") return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE workbench_checkpoints RENAME TO workbench_checkpoints_legacy_key;
      CREATE TABLE workbench_checkpoints (
        checkpoint_id TEXT NOT NULL,
        binding_id TEXT NOT NULL REFERENCES workbench_artifact_bindings(binding_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('stage', 'final', 'manual')),
        stage TEXT NOT NULL CHECK (stage IN ('contract', 'reference', 'target', 'alignment', 'delivery')),
        artifact_ref TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        artifact_hash TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (binding_id, checkpoint_id)
      );
      INSERT OR IGNORE INTO workbench_checkpoints (
        checkpoint_id, binding_id, kind, stage, artifact_ref, revision,
        artifact_hash, summary_json, created_at
      )
      SELECT checkpoint_id, binding_id, kind, stage, artifact_ref, revision,
             artifact_hash, summary_json, created_at
      FROM workbench_checkpoints_legacy_key;
      DROP TABLE workbench_checkpoints_legacy_key;
      CREATE INDEX IF NOT EXISTS workbench_checkpoints_binding_idx
        ON workbench_checkpoints(binding_id, created_at);
    `);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function addMissingUsageExecutionColumns(db: DatabaseSync): void {
  const columns = workspaceColumns(db, "usage_executions");
  if (!columns.has("kind_provisional")) {
    db.exec(
      "ALTER TABLE usage_executions ADD COLUMN kind_provisional INTEGER NOT NULL DEFAULT 0 CHECK (kind_provisional IN (0, 1))",
    );
  }
}

export function migrateWorkspaceLifecycleTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_lifecycle (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('merged', 'unregistered')),
      merged_into_workspace_id TEXT REFERENCES workspaces(id),
      previous_local_path TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      CHECK (
        (state = 'merged' AND merged_into_workspace_id IS NOT NULL AND merged_into_workspace_id <> workspace_id)
        OR (state = 'unregistered' AND merged_into_workspace_id IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS workspace_lifecycle_merge_target_idx
      ON workspace_lifecycle(merged_into_workspace_id)
      WHERE state = 'merged';
  `);
}

export function migrateSessionRequestCompletionDeliverySchema(db: DatabaseSync): void {
  const columns = workspaceColumns(db, "session_request_completion_deliveries");
  if (!columns.has("claim_token") || !columns.has("claim_expires_at")) {
    db.exec(`
      ALTER TABLE session_request_completion_deliveries
        RENAME TO session_request_completion_deliveries_legacy;
      CREATE TABLE session_request_completion_deliveries (
        source_invocation_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claim_token TEXT,
        claim_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );
      INSERT INTO session_request_completion_deliveries
        (source_invocation_id, status, attempt_count, last_error, created_at, updated_at, delivered_at)
      SELECT source_invocation_id, status, attempt_count, last_error, created_at, updated_at, delivered_at
      FROM session_request_completion_deliveries_legacy;
      DROP TABLE session_request_completion_deliveries_legacy;
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_request_completion_due
      ON session_request_completion_deliveries(status, claim_expires_at, updated_at)
  `);
}

export function addMissingLoopColumns(db: DatabaseSync): void {
  const columns = workspaceColumns(db, "loop_wakeups");
  if (!columns.has("session_lifetime")) {
    db.exec(
      "ALTER TABLE loop_wakeups ADD COLUMN session_lifetime TEXT NOT NULL DEFAULT 'driver' CHECK (session_lifetime IN ('driver', 'driver_tick'))",
    );
    db.exec(
      "UPDATE loop_wakeups SET session_lifetime = CASE continuity WHEN 'fresh' THEN 'driver_tick' ELSE 'driver' END",
    );
  }
  if (!columns.has("driver_session_id")) {
    db.exec("ALTER TABLE loop_wakeups ADD COLUMN driver_session_id TEXT");
    db.exec(
      "UPDATE loop_wakeups SET driver_session_id = 'driver_' || hex(loop_id) || '_' || generation WHERE driver_session_id IS NULL",
    );
  }
  if (!columns.has("wake_prompt")) {
    db.exec("ALTER TABLE loop_wakeups ADD COLUMN wake_prompt TEXT");
  }
  if (!columns.has("policy_json")) {
    db.exec(
      `ALTER TABLE loop_wakeups ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{"cadenceMs":30000,"retry":{"maxAttempts":3,"delaysMs":[30000,60000,120000]},"beforeTick":[],"afterTick":[]}'`,
    );
  }
  if (!columns.has("checkpoint_json")) {
    db.exec("ALTER TABLE loop_wakeups ADD COLUMN checkpoint_json TEXT");
  }
  if (!columns.has("workflow_definition_digest")) {
    db.exec("ALTER TABLE loop_wakeups ADD COLUMN workflow_definition_digest TEXT");
  }
  if (!columns.has("counters_json")) {
    db.exec(
      `ALTER TABLE loop_wakeups ADD COLUMN counters_json TEXT NOT NULL DEFAULT '{"tickCount":0,"skippedCount":0,"llmRequestsAvoided":0,"conditionRetryCount":0}'`,
    );
  }
}

export function addMissingRuntimeCommandReceiptColumns(db: DatabaseSync): void {
  const columns = workspaceColumns(db, "runtime_command_receipts");
  for (const [name, type] of [
    ["session_id", "TEXT"],
    ["idempotency_key", "TEXT"],
    ["request_message_id", "TEXT"],
    ["payload_json", "TEXT"],
    ["claim_token", "TEXT"],
    ["lease_expires_at", "TEXT"],
  ] as const) {
    if (!columns.has(name))
      db.exec(`ALTER TABLE runtime_command_receipts ADD COLUMN ${name} ${type}`);
  }
}

export function backfillInvocationEventDeliveryConsumers(db: DatabaseSync): void {
  db.exec(`
    INSERT OR IGNORE INTO invocation_event_delivery_consumers (destination, registered_at)
    SELECT DISTINCT destination, MIN(updated_at)
    FROM invocation_event_deliveries
    GROUP BY destination
  `);
}

export function addMissingHumanWaitColumns(db: DatabaseSync): void {
  const humanWaitColumns = workspaceColumns(db, "daemon_human_waits");
  if (!humanWaitColumns.has("accepted_response_id")) {
    db.exec("ALTER TABLE daemon_human_waits ADD COLUMN accepted_response_id TEXT");
  }
  if (!humanWaitColumns.has("interaction_request_id")) {
    db.exec("ALTER TABLE daemon_human_waits ADD COLUMN interaction_request_id TEXT");
  }
  if (!humanWaitColumns.has("evidence_request_json")) {
    db.exec("ALTER TABLE daemon_human_waits ADD COLUMN evidence_request_json TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_human_answer_events (
      answer_event_id TEXT PRIMARY KEY,
      human_request_id TEXT NOT NULL REFERENCES daemon_human_waits(human_request_id) ON DELETE CASCADE,
      interaction_request_id TEXT NOT NULL,
      human_response_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      wake_completed_at TEXT,
      wake_loop_id TEXT,
      wake_generation INTEGER,
      UNIQUE (human_request_id, human_response_id),
      UNIQUE (interaction_request_id, human_response_id)
    );
  `);
  const humanAnswerEventColumns = workspaceColumns(db, "daemon_human_answer_events");
  if (!humanAnswerEventColumns.has("wake_completed_at")) {
    db.exec("ALTER TABLE daemon_human_answer_events ADD COLUMN wake_completed_at TEXT");
  }
  if (!humanAnswerEventColumns.has("wake_loop_id")) {
    db.exec("ALTER TABLE daemon_human_answer_events ADD COLUMN wake_loop_id TEXT");
  }
  if (!humanAnswerEventColumns.has("wake_generation")) {
    db.exec("ALTER TABLE daemon_human_answer_events ADD COLUMN wake_generation INTEGER");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS daemon_human_waits_evidence_interaction_idx
      ON daemon_human_waits(interaction_request_id)
      WHERE evidence_request_json IS NOT NULL;
    CREATE INDEX IF NOT EXISTS daemon_human_answer_events_request_idx
      ON daemon_human_answer_events(human_request_id, created_at);
  `);
}

export function ensureReproFormalEvidenceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_repro_formal_evidence_receipts (
      receipt_key TEXT PRIMARY KEY,
      workspace_cwd TEXT NOT NULL,
      repro_id TEXT NOT NULL,
      requirement_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function migrateChannelDeliverySchema(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_deliveries'")
    .get() as { sql?: string } | undefined;
  if (
    !row?.sql ||
    (row.sql.includes("'inbound'") &&
      row.sql.includes("'notification'") &&
      row.sql.includes("'uncertain'") &&
      workspaceColumns(db, "channel_deliveries").has("dispatched_at"))
  ) {
    return;
  }

  const columns = workspaceColumns(db, "channel_deliveries");
  const dispatchedAt = columns.has("dispatched_at") ? "dispatched_at" : "NULL";

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP INDEX IF EXISTS channel_deliveries_due_idx;
      DROP TRIGGER IF EXISTS channel_deliveries_idempotency_key_immutable;
      ALTER TABLE channel_deliveries RENAME TO channel_deliveries_legacy;
      CREATE TABLE channel_deliveries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('reply', 'ask', 'interaction_ack', 'inbound', 'notification')),
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'delivered', 'uncertain')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        claimed_at TEXT,
        dispatched_at TEXT,
        last_error TEXT,
        receipt_json TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO channel_deliveries (
        id, kind, idempotency_key, payload_json, status, attempt_count,
        next_attempt_at, lease_owner, lease_token, lease_expires_at, claimed_at, dispatched_at,
        last_error, receipt_json, delivered_at, created_at, updated_at
      )
      SELECT
        id, kind, idempotency_key, payload_json, status, attempt_count,
        next_attempt_at, lease_owner, lease_token, lease_expires_at, claimed_at, ${dispatchedAt},
        last_error, receipt_json, delivered_at, created_at, updated_at
      FROM channel_deliveries_legacy;
      DROP TABLE channel_deliveries_legacy;
      CREATE INDEX channel_deliveries_due_idx
        ON channel_deliveries(status, next_attempt_at, lease_expires_at, created_at)
        WHERE status IN ('pending', 'retry_wait');
      CREATE TRIGGER channel_deliveries_idempotency_key_immutable
        BEFORE UPDATE OF idempotency_key ON channel_deliveries
        WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
        BEGIN
          SELECT RAISE(ABORT, 'channel delivery idempotency_key is immutable');
        END;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** One-way hard cut from the legacy kind/lane driver tables to bound loops. */
export function migrateLegacyDriverTables(db: DatabaseSync): void {
  if (!tableExists(db, "driver_wakeups")) return;
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const legacyColumns = workspaceColumns(db, "driver_wakeups");
    if (!legacyColumns.has("wake_prompt")) {
      db.exec("ALTER TABLE driver_wakeups ADD COLUMN wake_prompt TEXT");
    }
    db.prepare(
      `UPDATE invocations
       SET status = 'cancelled',
           cancel_reason = COALESCE(cancel_reason, 'continuation moved to phase lifecycle'),
           error_code = COALESCE(error_code, 'LOOP_BINDING_RETIRED'),
           error_message = COALESCE(error_message, 'implement and session TODO are not loop bindings'),
           updated_at = ?, finished_at = COALESCE(finished_at, ?)
       WHERE status IN ('queued', 'running')
         AND id IN (
           SELECT last_invocation_id FROM driver_wakeups
           WHERE kind IN ('implement', 'session_todo') AND last_invocation_id IS NOT NULL
         )`,
    ).run(now, now);
    db.exec(`
      INSERT OR IGNORE INTO loop_wakeups (
        loop_id, owner_session_id, binding_json, continuity, session_lifetime,
        driver_session_id, status, generation, cycle_step,
        due_at, attempt, last_invocation_id, reason, error, prompt, wake_prompt, route_json,
        domain_state_digest, created_at, updated_at
      )
      SELECT driver_id, owner_session_id,
        CASE kind
          WHEN 'goal' THEN json_object('goalId', driver_id)
          WHEN 'repro' THEN json_object('reproId', driver_id)
          WHEN 'workflow' THEN json_object('workflowRunId', driver_id)
          ELSE '{}'
        END,
        continuity,
        CASE continuity WHEN 'fresh' THEN 'driver_tick' ELSE 'driver' END,
        'driver_' || hex(driver_id) || '_' || generation,
        status, generation,
        CASE WHEN status = 'running' THEN 'invoke' ELSE NULL END,
        due_at, attempt, last_invocation_id, reason, error, prompt, wake_prompt, route_json,
        domain_state_digest, created_at, updated_at
      FROM driver_wakeups
      WHERE kind IN ('goal', 'loop', 'repro', 'workflow');
    `);
    if (tableExists(db, "driver_hidden_sessions")) {
      db.exec(`
        INSERT OR IGNORE INTO loop_hidden_sessions (
          execution_session_id, loop_id, generation, invocation_id, status, session_path,
          created_at, archived_at, gc_after
        )
        SELECT execution_session_id, driver_id, generation, invocation_id, status, session_path,
          created_at, archived_at, gc_after
        FROM driver_hidden_sessions
        WHERE driver_id IN (SELECT loop_id FROM loop_wakeups);
      `);
    }
    const rows = db
      .prepare(
        "SELECT id, task_json, source_kind, idempotency_key FROM invocations WHERE source_kind = 'driver.tick'",
      )
      .all() as Array<{
      id: string;
      task_json: string | null;
      source_kind: string | null;
      idempotency_key: string | null;
    }>;
    for (const row of rows) {
      const task = row.task_json ? (JSON.parse(row.task_json) as Record<string, unknown>) : {};
      const legacyKind = typeof task.kind === "string" ? task.kind : undefined;
      const loopId = typeof task.driverId === "string" ? task.driverId : task.loopId;
      if (!legacyKind || !["goal", "loop", "repro", "workflow"].includes(legacyKind)) {
        continue;
      }
      const binding =
        legacyKind === "goal"
          ? { goalId: loopId }
          : legacyKind === "repro"
            ? { reproId: loopId }
            : legacyKind === "workflow"
              ? { workflowRunId: loopId }
              : {};
      delete task.driverId;
      delete task.kind;
      task.type = "loop.tick";
      task.loopId = loopId;
      task.binding = binding;
      db.prepare(
        "UPDATE invocations SET task_json = ?, source_kind = 'loop.tick', idempotency_key = REPLACE(idempotency_key, 'driver.tick:', 'loop.tick:') WHERE id = ?",
      ).run(JSON.stringify(task), row.id);
    }
    db.exec("DROP TABLE IF EXISTS driver_hidden_sessions; DROP TABLE driver_wakeups;");
    db.prepare(
      `INSERT INTO daemon_meta (key, value, updated_at)
       VALUES ('migration.driver-to-loop-v1', 'complete', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * `daemon.error` rows were historically written to the business outbox even
 * though no transport consumed them. A disconnected Hub could therefore
 * create one permanent pending row per reconnect attempt. Scrub those rows on
 * every open as well as recording the migration: this remains safe if an old
 * daemon briefly writes again while a newer CLI is stopping/replacing it.
 * Daemon errors now go to process logs while projection connectivity is
 * represented by daemon_servers.
 */
export function retireLegacyDaemonErrorOutbox(db: DatabaseSync): void {
  const migrationKey = "migration.retire-daemon-error-outbox-v1";
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM outbox WHERE kind = 'daemon.error'").run();
    db.prepare(
      `INSERT INTO daemon_meta (key, value, updated_at)
       VALUES (?, 'complete', ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    ).run(migrationKey, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function renameLegacySparkDaemonTables(db: DatabaseSync): void {
  for (const [legacy, current] of [
    ["runner_meta", "daemon_meta"],
    ["runner_human_waits", "daemon_human_waits"],
    ["runner_servers", "daemon_servers"],
    ["runner_server_credentials", "daemon_server_credentials"],
    ["runner_workspaces", "daemon_workspaces"],
    ["runner_workspace_grants", "daemon_workspace_grants"],
  ] as const) {
    if (tableExists(db, legacy) && !tableExists(db, current)) {
      db.exec(`ALTER TABLE ${legacy} RENAME TO ${current}`);
    }
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}

export function addMissingInvocationColumns(db: DatabaseSync): void {
  const columns = workspaceColumns(db, "invocations");
  const additions = [
    ["workspace_binding_id", "TEXT"],
    ["session_id", "TEXT"],
    ["idempotency_key", "TEXT"],
    ["task_json", "TEXT"],
    ["result_json", "TEXT"],
    ["source_kind", "TEXT"],
    ["source_ref", "TEXT"],
    ["parent_invocation_id", "TEXT REFERENCES invocations(id)"],
    ["retry_of_invocation_id", "TEXT REFERENCES invocations(id)"],
    ["claim_class", "TEXT NOT NULL DEFAULT 'root' CHECK (claim_class IN ('root', 'structured'))"],
    ["execution_profile_json", "TEXT"],
    ["retention_summary_json", "TEXT"],
    ["payload_redacted_at", "TEXT"],
    ["worker_id", "TEXT"],
    ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["cancel_reason", "TEXT"],
    ["error_code", "TEXT"],
    ["error_message", "TEXT"],
    ["claimed_at", "TEXT"],
    ["started_at", "TEXT"],
    ["finished_at", "TEXT"],
    ["retained_at", "TEXT"],
  ] as const;
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE invocations ADD COLUMN ${name} ${type}`);
  }
  if (!columns.has("event_cursor")) {
    db.exec(`ALTER TABLE invocations ADD COLUMN event_cursor INTEGER NOT NULL DEFAULT 0`);
    // One-time backfill so listSummaryPage can avoid scanning invocation_events.
    db.exec(`
      UPDATE invocations
      SET event_cursor = COALESCE((
        SELECT MAX(sequence)
        FROM invocation_events
        WHERE invocation_events.invocation_id = invocations.id
      ), 0)
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS invocation_events (
      invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (invocation_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS invocations_session_status_idx ON invocations(session_id, status);
    CREATE INDEX IF NOT EXISTS invocations_claim_class_status_idx
      ON invocations(claim_class, status, created_at);
    CREATE INDEX IF NOT EXISTS invocations_session_updated_idx
      ON invocations(session_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS invocations_created_at_idx
      ON invocations(created_at DESC);
    CREATE INDEX IF NOT EXISTS invocations_parent_idx
      ON invocations(parent_invocation_id);
    CREATE INDEX IF NOT EXISTS invocations_retry_idx
      ON invocations(retry_of_invocation_id);
    CREATE INDEX IF NOT EXISTS usage_executions_invocation_idx
      ON usage_executions(invocation_id, started_at);
    CREATE INDEX IF NOT EXISTS usage_executions_root_idx
      ON usage_executions(root_invocation_id, started_at);
    CREATE INDEX IF NOT EXISTS usage_executions_repro_idx
      ON usage_executions(repro_id, started_at);
    CREATE INDEX IF NOT EXISTS token_usage_receipts_execution_idx
      ON token_usage_receipts(execution_id, observed_at);
    CREATE UNIQUE INDEX IF NOT EXISTS token_usage_receipts_execution_ordinal_idx
      ON token_usage_receipts(execution_id, response_ordinal);
    CREATE INDEX IF NOT EXISTS usage_execution_lifecycle_idx
      ON usage_execution_lifecycle_events(execution_id, observed_at);
    CREATE INDEX IF NOT EXISTS token_usage_receipts_invocation_idx
      ON token_usage_receipts(invocation_id, observed_at);
    CREATE INDEX IF NOT EXISTS invocations_retention_idx
      ON invocations(finished_at, id)
      WHERE retained_at IS NULL
        AND status IN ('succeeded', 'failed', 'cancelled');
    CREATE UNIQUE INDEX IF NOT EXISTS invocations_idempotency_idx
      ON invocations(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS invocation_event_delivery_consumers (
      destination TEXT PRIMARY KEY,
      registered_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS invocation_events_cursor_idx
      ON invocation_events(invocation_id, sequence);
    CREATE INDEX IF NOT EXISTS invocation_events_kind_created_idx
      ON invocation_events(kind, created_at, invocation_id, sequence);
  `);
}

export function migrateWorkspacesTable(db: DatabaseSync): void {
  const columns = workspaceColumns(db, "workspaces");
  if (columns.size === 0) {
    createWorkspacesTable(db);
    return;
  }

  if (columns.has("server_url")) {
    addMissingWorkspaceProfileColumns(db, columns);
    return;
  }

  db.exec("ALTER TABLE workspaces RENAME TO workspaces_legacy");
  createWorkspacesTable(db);
  db.exec(`
    INSERT OR IGNORE INTO workspaces
      (id, server_url, local_workspace_key, display_name, local_path, status, capabilities_json, diagnostics_json, created_at, updated_at)
    SELECT
      id,
      '',
      local_workspace_key,
      display_name,
      local_path,
      status,
      capabilities_json,
      diagnostics_json,
      created_at,
      updated_at
    FROM workspaces_legacy;

    DROP TABLE workspaces_legacy;
  `);
}

function createWorkspacesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      server_url TEXT NOT NULL DEFAULT '',
      local_workspace_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      status TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      diagnostics_json TEXT NOT NULL DEFAULT '{}',
      profile_source_kind TEXT,
      profile_ref TEXT,
      profile_commit TEXT,
      profile_imported_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (server_url, local_workspace_key),
      UNIQUE (server_url, local_path)
    )
  `);
}

export function migrateSparkDaemonRegistrationTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_servers (
      id TEXT PRIMARY KEY,
      server_url TEXT NOT NULL UNIQUE,
      first_registered_at TEXT NOT NULL,
      last_connected_at TEXT,
      last_disconnect_reason TEXT,
      protocol_version TEXT
    );

    CREATE TABLE IF NOT EXISTS daemon_server_credentials (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL UNIQUE REFERENCES daemon_servers(id),
      runtime_id TEXT NOT NULL,
      runtime_token_hash TEXT NOT NULL,
      refresh_token_hash TEXT,
      runtime_token_expires_at TEXT,
      refresh_token_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daemon_workspaces (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES daemon_servers(id),
      server_workspace_id TEXT,
      server_binding_id TEXT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      local_path TEXT NOT NULL,
      profile_source_kind TEXT,
      profile_ref TEXT,
      profile_commit TEXT,
      registered_at TEXT NOT NULL,
      last_known_status TEXT NOT NULL,
      last_known_offline_reason TEXT,
      last_status_changed_at TEXT NOT NULL,
      UNIQUE (server_id, local_path),
      UNIQUE (server_id, slug)
    );

    CREATE TABLE IF NOT EXISTS daemon_workspace_grants (
      id TEXT PRIMARY KEY,
      daemon_workspace_id TEXT NOT NULL REFERENCES daemon_workspaces(id),
      grant_token_hash TEXT,
      server_grant_id TEXT,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS daemon_workspace_clients (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('interactive', 'headless', 'executor')),
      display_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
      attached_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      lease_expires_at TEXT,
      released_at TEXT,
      session_id TEXT,
      lease_fence TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS daemon_relocation_audit (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      from_server_url TEXT NOT NULL,
      to_server_url TEXT NOT NULL,
      workspace_count INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded')),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS daemon_workspaces_status_idx
      ON daemon_workspaces(last_known_status);
    CREATE INDEX IF NOT EXISTS daemon_workspace_grants_workspace_idx
      ON daemon_workspace_grants(daemon_workspace_id);
    CREATE INDEX IF NOT EXISTS daemon_workspace_clients_workspace_status_idx
      ON daemon_workspace_clients(workspace_id, status, kind);
    CREATE INDEX IF NOT EXISTS daemon_workspace_clients_lease_idx
      ON daemon_workspace_clients(status, lease_expires_at);
  `);
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(daemon_workspace_clients)").all() as Array<{ name: string }>
    ).map((column) => column.name),
  );
  for (const name of ["session_id", "lease_fence"] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE daemon_workspace_clients ADD COLUMN ${name} TEXT`);
  }
}

export function backfillSparkDaemonRegistrationTables(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT id,
              server_url AS serverUrl,
              local_workspace_key AS localWorkspaceKey,
              display_name AS displayName,
              local_path AS localPath,
              status,
              diagnostics_json AS diagnosticsJson,
              profile_source_kind AS profileSourceKind,
              profile_ref AS profileRef,
              profile_commit AS profileCommit,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM workspaces`,
    )
    .all() as Array<{
    id: string;
    serverUrl: string;
    localWorkspaceKey: string;
    displayName: string;
    localPath: string;
    status: string;
    diagnosticsJson: string;
    profileSourceKind: string | null;
    profileRef: string | null;
    profileCommit: string | null;
    createdAt: string;
    updatedAt: string;
  }>;

  for (const row of rows) {
    const serverId = ensureSparkDaemonServer(db, row.serverUrl, row.createdAt ?? now);
    const offlineReason = offlineReasonFromDiagnostics(row.status, row.diagnosticsJson);
    db.prepare(
      `INSERT OR IGNORE INTO daemon_workspaces
        (id, server_id, server_workspace_id, server_binding_id, name, slug, local_path, profile_source_kind, profile_ref, profile_commit, registered_at, last_known_status, last_known_offline_reason, last_status_changed_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      serverId,
      row.id,
      row.displayName,
      row.localWorkspaceKey,
      row.localPath,
      row.profileSourceKind,
      row.profileRef,
      row.profileCommit,
      row.createdAt ?? now,
      row.status,
      offlineReason,
      row.updatedAt ?? now,
    );
  }
}

function ensureSparkDaemonServer(db: DatabaseSync, serverUrl: string, now: string): string {
  const existing = db
    .prepare("SELECT id FROM daemon_servers WHERE server_url = ? LIMIT 1")
    .get(serverUrl) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }

  const id = `rnsrv_${cryptoRandomId()}`;
  db.prepare(
    `INSERT INTO daemon_servers
      (id, server_url, first_registered_at)
     VALUES (?, ?, ?)`,
  ).run(id, serverUrl, now);
  return id;
}

function offlineReasonFromDiagnostics(status: string, diagnosticsJson: string): string | null {
  if (status === "available") {
    return null;
  }

  try {
    const diagnostics = JSON.parse(diagnosticsJson) as Record<string, unknown>;
    if (diagnostics.userDetached === true) {
      return "user-detached";
    }
    if (diagnostics.pathMissing === true) {
      return "path-missing";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

function cryptoRandomId(): string {
  return randomUUID().replaceAll("-", "");
}

function addMissingWorkspaceProfileColumns(db: DatabaseSync, columns: Set<string>): void {
  const profileColumns: Array<[name: string, definition: string]> = [
    ["profile_source_kind", "profile_source_kind TEXT"],
    ["profile_ref", "profile_ref TEXT"],
    ["profile_commit", "profile_commit TEXT"],
    ["profile_imported_at", "profile_imported_at TEXT"],
  ];

  for (const [name, definition] of profileColumns) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE workspaces ADD COLUMN ${definition}`);
    }
  }
}

function workspaceColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}
