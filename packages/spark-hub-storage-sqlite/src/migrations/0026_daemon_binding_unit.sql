-- Daemon is the hub registration and binding unit. A daemon (one per
-- machine/installation) owns every workspace that runs on it; each local
-- workspace is one runtime_workspace_bindings row with its own active lease.
--
-- Snapshot the enrollment scopes that authorized each daemon registration so
-- operator surfaces can distinguish daemon-level enrollment
-- (["daemon:attach"]) from legacy workspace-scoped enrollment
-- (["workspace:register", ...]) without replaying token history.
ALTER TABLE runtime_connections
  ADD COLUMN enrollment_scopes_json TEXT NOT NULL DEFAULT '[]';
