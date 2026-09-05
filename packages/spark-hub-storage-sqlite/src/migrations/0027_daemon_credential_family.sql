-- The hub-daemon credential family gets one canonical record. One-shot
-- enrollment tokens and device authorizations are bootstrap exchanges for the
-- family; the access/refresh pair they issue is the daemon's renewable
-- credential and lives only in daemon_credentials. bootstrap_* records which
-- exchange vehicle authorized the daemon's first credential, and
-- rotated_from_id links each renewal to the refresh credential it consumed.

CREATE TABLE daemon_credentials (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL DEFAULT 'hub-daemon' CHECK (family = 'hub-daemon'),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  bootstrap_kind TEXT CHECK (bootstrap_kind IN ('enrollment', 'device')),
  bootstrap_id TEXT,
  rotated_from_id TEXT REFERENCES daemon_credentials(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX daemon_credentials_runtime_state_idx
  ON daemon_credentials(runtime_id, revoked_at, expires_at, created_at);

-- Access and refresh credentials were distinguished by scope content in
-- runtime_tokens; the canonical family record makes the kind explicit.
INSERT INTO daemon_credentials
  (id, family, kind, runtime_id, token_hash, label, scopes_json, created_at, expires_at, revoked_at)
SELECT id,
       'hub-daemon',
       CASE WHEN scopes_json LIKE '%runtime:refresh%' THEN 'refresh' ELSE 'access' END,
       runtime_id,
       token_hash,
       label,
       scopes_json,
       created_at,
       expires_at,
       revoked_at
FROM runtime_tokens;

-- Best-effort lineage for credentials issued before the family record
-- existed: the latest consumed bootstrap exchange of each runtime authorized
-- its first credential; a device authorization wins only when it was consumed
-- after the latest consumed enrollment token.
UPDATE daemon_credentials
SET bootstrap_kind = 'enrollment',
    bootstrap_id = (
      SELECT et.id
      FROM runtime_enrollment_tokens et
      WHERE et.created_runtime_id = daemon_credentials.runtime_id
        AND et.used_at IS NOT NULL
      ORDER BY et.used_at DESC
      LIMIT 1
    )
WHERE EXISTS (
  SELECT 1
  FROM runtime_enrollment_tokens et
  WHERE et.created_runtime_id = daemon_credentials.runtime_id
    AND et.used_at IS NOT NULL
);

UPDATE daemon_credentials
SET bootstrap_kind = 'device',
    bootstrap_id = (
      SELECT da.id
      FROM runtime_device_authorizations da
      WHERE da.created_runtime_id = daemon_credentials.runtime_id
        AND da.consumed_at IS NOT NULL
      ORDER BY da.consumed_at DESC
      LIMIT 1
    )
WHERE EXISTS (
  SELECT 1
  FROM runtime_device_authorizations da
  WHERE da.created_runtime_id = daemon_credentials.runtime_id
    AND da.consumed_at IS NOT NULL
    AND da.consumed_at >= COALESCE(
      (
        SELECT et.used_at
        FROM runtime_enrollment_tokens et
        WHERE et.created_runtime_id = daemon_credentials.runtime_id
          AND et.used_at IS NOT NULL
        ORDER BY et.used_at DESC
        LIMIT 1
      ),
      ''
    )
);

-- Re-point the uplink session's credential reference at the canonical family
-- table before retiring runtime_tokens. Credential ids are preserved by the
-- backfill above, so existing token_id values stay valid.
DROP INDEX runtime_sessions_runtime_status_idx;

ALTER TABLE runtime_sessions RENAME TO runtime_sessions_legacy;

CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES daemon_credentials(id) ON DELETE SET NULL,
  transport TEXT NOT NULL CHECK (transport IN ('websocket')),
  status TEXT NOT NULL CHECK (status IN ('connected', 'closed', 'stale')),
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  remote_addr_hash TEXT
);

INSERT INTO runtime_sessions
  (id, runtime_id, token_id, transport, status, connected_at, last_seen_at, closed_at, close_reason, remote_addr_hash)
SELECT id, runtime_id, token_id, transport, status, connected_at, last_seen_at, closed_at, close_reason, remote_addr_hash
FROM runtime_sessions_legacy;

DROP TABLE runtime_sessions_legacy;

CREATE INDEX runtime_sessions_runtime_status_idx
  ON runtime_sessions(runtime_id, status);

DROP TABLE runtime_tokens;
