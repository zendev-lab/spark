-- Earlier Hub releases reused member principals by display name, so distinct
-- browser credentials could share the union of their daemon grants. Those
-- principals cannot be separated reliably after the fact. Retire their active
-- authority and require owners to issue fresh Hub keys under the isolated
-- principal model.

UPDATE sessions
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE revoked_at IS NULL
  AND user_id IN (SELECT id FROM users WHERE role = 'member');

UPDATE user_daemon_grants
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE revoked_at IS NULL
  AND user_id IN (SELECT id FROM users WHERE role = 'member');

UPDATE users
SET status = 'disabled',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE role = 'member'
  AND status = 'active';
