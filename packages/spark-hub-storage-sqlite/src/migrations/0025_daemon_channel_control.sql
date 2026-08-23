DROP INDEX runtime_channel_control_projections_workspace_idx;

DROP TABLE runtime_channel_control_projections;

CREATE TABLE runtime_channel_control_projections (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_connections(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  projected_at TEXT NOT NULL
);

ALTER TABLE runtime_ephemeral_secret_audit
  RENAME TO runtime_ephemeral_secret_audit_workspace_legacy;

CREATE TABLE runtime_ephemeral_secret_audit (
  request_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  browser_request_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'provider.auth.api_key.set',
    'provider.auth.login.respond',
    'channel.configure'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'pending',
    'succeeded',
    'failed',
    'rejected',
    'disconnected',
    'timed_out'
  )),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

INSERT INTO runtime_ephemeral_secret_audit (
  request_id,
  runtime_id,
  actor_user_id,
  browser_request_id,
  operation,
  outcome,
  created_at,
  completed_at
)
SELECT
  request_id,
  runtime_id,
  actor_user_id,
  browser_request_id,
  operation,
  outcome,
  created_at,
  completed_at
FROM runtime_ephemeral_secret_audit_workspace_legacy;

DROP TABLE runtime_ephemeral_secret_audit_workspace_legacy;

CREATE INDEX runtime_ephemeral_secret_audit_runtime_created_idx
  ON runtime_ephemeral_secret_audit(runtime_id, created_at);
