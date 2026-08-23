-- Graduate the active control-plane API to Hub terminology while preserving
-- the historical 0017/0020 migration names in schema_migrations.
--
-- 0.3.0 is an expand-only migration and supports rollback to the published
-- 0.2.x Cockpit CLI. Keep the single physical token table under its legacy
-- name for that window so old clients retain SQLite change-count semantics;
-- current Hub clients use the writable compatibility view below.
DROP INDEX cockpit_access_tokens_state_idx;
CREATE INDEX hub_access_tokens_state_idx
  ON cockpit_access_tokens(used_at, revoked_at, expires_at, created_at);

CREATE VIEW hub_access_tokens AS
SELECT id,
       token_hash,
       label,
       created_by_user_id,
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
    created_at,
    expires_at,
    used_at,
    revoked_at
  ) VALUES (
    NEW.id,
    NEW.token_hash,
    NEW.label,
    NEW.created_by_user_id,
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

UPDATE app_settings
SET key = 'spark_hub:instance_id'
WHERE key = 'spark_cockpit:instance_id'
  AND NOT EXISTS (
    SELECT 1 FROM app_settings WHERE key = 'spark_hub:instance_id'
  );
DELETE FROM app_settings
WHERE key = 'spark_cockpit:instance_id'
  AND EXISTS (
    SELECT 1 FROM app_settings AS canonical
    WHERE canonical.key = 'spark_hub:instance_id'
      AND canonical.value_json = app_settings.value_json
  );

UPDATE app_settings
SET key = 'spark_hub:web_push_subscription'
WHERE key = 'spark_cockpit:web_push_subscription'
  AND NOT EXISTS (
    SELECT 1 FROM app_settings WHERE key = 'spark_hub:web_push_subscription'
  );
DELETE FROM app_settings
WHERE key = 'spark_cockpit:web_push_subscription'
  AND EXISTS (
    SELECT 1 FROM app_settings AS canonical
    WHERE canonical.key = 'spark_hub:web_push_subscription'
      AND canonical.value_json = app_settings.value_json
  );
