-- Graduate the active control-plane schema to Hub terminology while preserving
-- the historical 0017/0020 migration names in schema_migrations.
ALTER TABLE cockpit_access_tokens RENAME TO hub_access_tokens;
DROP INDEX cockpit_access_tokens_state_idx;
CREATE INDEX hub_access_tokens_state_idx
  ON hub_access_tokens(used_at, revoked_at, expires_at, created_at);

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
