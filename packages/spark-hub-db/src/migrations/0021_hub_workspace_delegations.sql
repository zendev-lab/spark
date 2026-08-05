ALTER TABLE runtime_workspace_bindings ADD COLUMN main_session_id TEXT;
ALTER TABLE runtime_workspace_bindings ADD COLUMN main_session_generation INTEGER;

CREATE TABLE workspace_delegations (
  id TEXT PRIMARY KEY,
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  target_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL DEFAULT '[]',
  requested_role TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('hub_owner', 'workspace_main_session')),
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
  target_session_generation INTEGER,
  target_invocation_id TEXT,
  receipt_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (source_workspace_id <> target_workspace_id),
  CHECK (
    (actor_kind = 'workspace_main_session' AND actor_session_id IS NOT NULL)
    OR actor_kind = 'hub_owner'
  )
);

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

CREATE UNIQUE INDEX workspace_delegation_messages_command_unique
  ON workspace_delegation_messages(runtime_control_command_id)
  WHERE runtime_control_command_id IS NOT NULL;

CREATE INDEX workspace_delegation_messages_delivery_idx
  ON workspace_delegation_messages(delivery_status, updated_at);
