-- The hub-user family converges on one Hub session whose workspace visibility
-- comes from per-daemon grants. user_daemon_grants is the single record of
-- which hub user may reach workspaces and sessions owned by each daemon;
-- workspace-scoped browser sessions and one-time workspace access tokens are
-- retired outright.

CREATE TABLE user_daemon_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
  granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- One active grant per (user, daemon); a revoked grant can be re-issued.
CREATE UNIQUE INDEX user_daemon_grants_active_unique
  ON user_daemon_grants(user_id, runtime_id)
  WHERE revoked_at IS NULL;

CREATE INDEX user_daemon_grants_runtime_idx
  ON user_daemon_grants(runtime_id, revoked_at);

-- Existing Hub owners keep their current reach: every active owner receives an
-- explicit grant for every daemon known at migration time. Daemons registered
-- later grant active owners at registration.
INSERT INTO user_daemon_grants
  (id, user_id, runtime_id, granted_by_user_id, created_at)
SELECT 'udg_' || lower(hex(randomblob(16))),
       u.id,
       rc.id,
       u.id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users u
CROSS JOIN runtime_connections rc
WHERE u.role = 'owner'
  AND u.status = 'active';

-- Workspace-only browser sessions and unused workspace access tokens have no
-- successor credential; revoke them at the migration instant.
UPDATE sessions
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE workspace_id IS NOT NULL
  AND revoked_at IS NULL;

UPDATE workspace_access_tokens
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE revoked_at IS NULL;

-- All sessions are hub-user sessions now; retire the workspace scope column.
DROP INDEX sessions_workspace_active_idx;

ALTER TABLE sessions RENAME TO sessions_legacy;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_secret_hash TEXT,
  user_agent_hash TEXT,
  refresh_token_hash TEXT,
  refresh_expires_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

INSERT INTO sessions
  (id, user_id, token_hash, csrf_secret_hash, user_agent_hash,
   refresh_token_hash, refresh_expires_at, created_at, last_seen_at, expires_at, revoked_at)
SELECT id, user_id, token_hash, csrf_secret_hash, user_agent_hash,
       refresh_token_hash, refresh_expires_at, created_at, last_seen_at, expires_at, revoked_at
FROM sessions_legacy;

DROP TABLE sessions_legacy;

CREATE UNIQUE INDEX sessions_refresh_token_unique
  ON sessions(refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;

DROP TABLE workspace_access_tokens;

-- Hub access tokens now carry the daemon grants and member identity they mint
-- at exchange. The physical record stays on the legacy table behind the
-- writable hub_access_tokens view; extend both.
ALTER TABLE cockpit_access_tokens
  ADD COLUMN daemon_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cockpit_access_tokens
  ADD COLUMN member_name TEXT;

DROP TRIGGER hub_access_tokens_insert;
DROP TRIGGER hub_access_tokens_update;
DROP TRIGGER hub_access_tokens_delete;
DROP VIEW hub_access_tokens;

CREATE VIEW hub_access_tokens AS
SELECT id,
       token_hash,
       label,
       created_by_user_id,
       daemon_ids_json,
       member_name,
       created_at,
       expires_at,
       used_at,
       revoked_at
FROM cockpit_access_tokens;

CREATE TRIGGER hub_access_tokens_insert
INSTEAD OF INSERT ON hub_access_tokens
BEGIN
  INSERT INTO cockpit_access_tokens (
    id,
    token_hash,
    label,
    created_by_user_id,
    daemon_ids_json,
    member_name,
    created_at,
    expires_at,
    used_at,
    revoked_at
  ) VALUES (
    NEW.id,
    NEW.token_hash,
    NEW.label,
    NEW.created_by_user_id,
    NEW.daemon_ids_json,
    NEW.member_name,
    NEW.created_at,
    NEW.expires_at,
    NEW.used_at,
    NEW.revoked_at
  );
END;

CREATE TRIGGER hub_access_tokens_update
INSTEAD OF UPDATE ON hub_access_tokens
BEGIN
  UPDATE cockpit_access_tokens
  SET id = NEW.id,
      token_hash = NEW.token_hash,
      label = NEW.label,
      created_by_user_id = NEW.created_by_user_id,
      daemon_ids_json = NEW.daemon_ids_json,
      member_name = NEW.member_name,
      created_at = NEW.created_at,
      expires_at = NEW.expires_at,
      used_at = NEW.used_at,
      revoked_at = NEW.revoked_at
  WHERE id = OLD.id;
END;

CREATE TRIGGER hub_access_tokens_delete
INSTEAD OF DELETE ON hub_access_tokens
BEGIN
  DELETE FROM cockpit_access_tokens WHERE id = OLD.id;
END;
