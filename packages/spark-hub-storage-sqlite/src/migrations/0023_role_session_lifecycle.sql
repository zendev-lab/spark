ALTER TABLE workspaces ADD COLUMN provisioning_state TEXT NOT NULL DEFAULT 'provisioning'
  CHECK (provisioning_state IN ('provisioning', 'active', 'failed'));
ALTER TABLE workspaces ADD COLUMN provisioning_error TEXT;
ALTER TABLE workspaces ADD COLUMN provisioning_retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE runtime_workspace_bindings
  RENAME COLUMN main_session_id TO administrator_session_id;
ALTER TABLE runtime_workspace_bindings DROP COLUMN main_session_generation;
ALTER TABLE runtime_workspace_bindings ADD COLUMN administrator_provisioning_state TEXT NOT NULL DEFAULT 'provisioning'
  CHECK (administrator_provisioning_state IN ('provisioning', 'active', 'failed'));
ALTER TABLE runtime_workspace_bindings ADD COLUMN administrator_provisioning_error TEXT;
ALTER TABLE runtime_workspace_bindings ADD COLUMN administrator_provisioning_retry_count INTEGER NOT NULL DEFAULT 0;

UPDATE runtime_workspace_bindings
SET administrator_provisioning_state = CASE
  WHEN administrator_session_id IS NULL THEN 'provisioning'
  ELSE 'active'
END;

UPDATE workspaces
SET provisioning_state = CASE
  WHEN EXISTS (
    SELECT 1
    FROM workspace_leases wl
    JOIN runtime_workspace_bindings rwb ON rwb.id = wl.runtime_workspace_binding_id
    WHERE wl.workspace_id = workspaces.id
      AND wl.ended_at IS NULL
      AND rwb.administrator_session_id IS NOT NULL
  ) THEN 'active'
  ELSE 'provisioning'
END;

-- Runtime session data is a daemon-owned projection cache. Discard the old
-- mixed-status records so no legacy record_json or dual-read path survives.
DROP TABLE runtime_invocation_event_projections;
DROP TABLE runtime_invocation_projections;
DROP TABLE runtime_session_projections;

CREATE TABLE runtime_session_projections (
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('daemon', 'workspace')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT REFERENCES runtime_workspace_bindings(id) ON DELETE CASCADE,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open', 'closing', 'closed')),
  placement TEXT NOT NULL CHECK (placement IN ('active', 'archived')),
  activity TEXT NOT NULL CHECK (activity IN ('idle', 'queued', 'running')),
  lifetime TEXT NOT NULL CHECK (lifetime IN ('persistent', 'scoped', 'ephemeral')),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN (
    'workspace', 'session', 'side_thread', 'task_run', 'task_revision',
    'workflow_run', 'driver', 'driver_tick', 'invocation'
  )),
  record_json TEXT NOT NULL,
  snapshot_json TEXT,
  snapshot_total_messages INTEGER NOT NULL DEFAULT 0,
  snapshot_loaded_messages INTEGER NOT NULL DEFAULT 0,
  snapshot_hidden_messages INTEGER NOT NULL DEFAULT 0,
  projected_at TEXT NOT NULL,
  PRIMARY KEY (runtime_id, session_id),
  CHECK (
    (scope = 'daemon' AND workspace_id IS NULL AND runtime_workspace_binding_id IS NULL)
    OR
    (scope = 'workspace' AND workspace_id IS NOT NULL AND runtime_workspace_binding_id IS NOT NULL)
  )
);

CREATE INDEX runtime_session_projections_scope_lifecycle_idx
  ON runtime_session_projections(
    runtime_id, scope, workspace_id, lifecycle, placement, activity, projected_at
  );

CREATE TABLE runtime_invocation_projections (
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  runtime_invocation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('daemon', 'workspace')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_workspace_binding_id TEXT REFERENCES runtime_workspace_bindings(id) ON DELETE CASCADE,
  command_id TEXT REFERENCES runtime_control_commands(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'lost'
  )),
  event_cursor INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  terminal_reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (runtime_id, runtime_invocation_id),
  FOREIGN KEY (runtime_id, session_id)
    REFERENCES runtime_session_projections(runtime_id, session_id) ON DELETE CASCADE,
  CHECK (
    (scope = 'daemon' AND workspace_id IS NULL AND runtime_workspace_binding_id IS NULL)
    OR
    (scope = 'workspace' AND workspace_id IS NOT NULL AND runtime_workspace_binding_id IS NOT NULL)
  )
);

CREATE INDEX runtime_invocation_projections_session_status_idx
  ON runtime_invocation_projections(runtime_id, session_id, status, updated_at);

CREATE TABLE runtime_invocation_event_projections (
  runtime_id TEXT NOT NULL,
  runtime_invocation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (runtime_id, runtime_invocation_id, sequence),
  FOREIGN KEY (runtime_id, runtime_invocation_id)
    REFERENCES runtime_invocation_projections(runtime_id, runtime_invocation_id) ON DELETE CASCADE
);

CREATE INDEX runtime_invocation_event_projections_cursor_idx
  ON runtime_invocation_event_projections(runtime_id, runtime_invocation_id, sequence);

CREATE TEMP TABLE workspace_delegations_v21 AS
SELECT * FROM workspace_delegations;
CREATE TEMP TABLE workspace_delegation_messages_v21 AS
SELECT * FROM workspace_delegation_messages;

DROP TABLE workspace_delegation_messages;
DROP TABLE workspace_delegations;

CREATE TABLE workspace_delegations (
  id TEXT PRIMARY KEY,
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  target_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL DEFAULT '[]',
  requested_role TEXT,
  actor_kind TEXT NOT NULL CHECK (
    actor_kind IN ('hub_owner', 'workspace_administrator_session')
  ),
  actor_id TEXT NOT NULL,
  actor_session_id TEXT,
  lineage_json TEXT NOT NULL DEFAULT '[]',
  hop_count INTEGER NOT NULL DEFAULT 1 CHECK (hop_count BETWEEN 1 AND 4),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'retry_wait', 'delivering', 'running', 'awaiting_source',
    'cancelling', 'completed', 'rejected', 'failed', 'cancelled'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  next_message_sequence INTEGER NOT NULL DEFAULT 1,
  target_session_id TEXT,
  target_invocation_id TEXT,
  receipt_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (source_workspace_id <> target_workspace_id),
  CHECK (
    (actor_kind = 'workspace_administrator_session' AND actor_session_id IS NOT NULL)
    OR actor_kind = 'hub_owner'
  )
);

INSERT INTO workspace_delegations (
  id, source_workspace_id, target_workspace_id, goal, constraints_json, requested_role,
  actor_kind, actor_id, actor_session_id, lineage_json, hop_count, idempotency_key,
  status, version, next_message_sequence, target_session_id, target_invocation_id,
  receipt_json, failure_code, failure_message, created_at, updated_at, terminal_at
)
SELECT
  id, source_workspace_id, target_workspace_id, goal, constraints_json,
  CASE requested_role
    WHEN 'scout' THEN 'explorer'
    WHEN 'researcher' THEN 'explorer'
    WHEN 'worker' THEN 'executor'
    WHEN 'role:builtin-scout' THEN 'role:builtin-explorer'
    WHEN 'role:builtin-researcher' THEN 'role:builtin-explorer'
    WHEN 'role:builtin-worker' THEN 'role:builtin-executor'
    ELSE requested_role
  END,
  CASE actor_kind
    WHEN 'workspace_main_session' THEN 'workspace_administrator_session'
    ELSE actor_kind
  END,
  actor_id, actor_session_id, lineage_json, hop_count, idempotency_key,
  status, version, next_message_sequence, target_session_id, target_invocation_id,
  receipt_json, failure_code, failure_message, created_at, updated_at, terminal_at
FROM workspace_delegations_v21;

CREATE UNIQUE INDEX workspace_delegations_source_idempotency_unique
  ON workspace_delegations(source_workspace_id, idempotency_key);
CREATE INDEX workspace_delegations_source_status_idx
  ON workspace_delegations(source_workspace_id, status, updated_at DESC);
CREATE INDEX workspace_delegations_target_status_idx
  ON workspace_delegations(target_workspace_id, status, updated_at DESC);

CREATE TABLE workspace_delegation_messages (
  delegation_id TEXT NOT NULL REFERENCES workspace_delegations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'question', 'reply', 'receipt', 'cancel')),
  from_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  to_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  payload_json TEXT NOT NULL,
  runtime_control_command_id TEXT REFERENCES runtime_control_commands(id) ON DELETE SET NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN (
    'queued', 'delivered', 'accepted', 'succeeded', 'failed', 'rejected', 'cancelled'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (delegation_id, sequence),
  CHECK (from_workspace_id <> to_workspace_id)
);

INSERT INTO workspace_delegation_messages
SELECT * FROM workspace_delegation_messages_v21;

CREATE UNIQUE INDEX workspace_delegation_messages_command_unique
  ON workspace_delegation_messages(runtime_control_command_id)
  WHERE runtime_control_command_id IS NOT NULL;
CREATE INDEX workspace_delegation_messages_delivery_idx
  ON workspace_delegation_messages(delivery_status, updated_at);

DROP TABLE workspace_delegation_messages_v21;
DROP TABLE workspace_delegations_v21;
