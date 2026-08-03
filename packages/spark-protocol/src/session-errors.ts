import { z } from "zod";
import { sparkSideThreadErrorCodeOptions } from "./side-thread.ts";

/**
 * Session-registry and daemon session-control failures outside the dedicated
 * Side Thread protocol. Keep this list exhaustive: SparkSessionRegistryError
 * consumes the combined union so a new domain code must be registered here.
 */
export const sparkSessionRegistryDomainErrorCodeOptions = [
  "binding_ambiguous",
  "binding_conflict",
  "binding_not_found",
  "binding_unbound",
  "create_required",
  "daemon_cwd_unavailable",
  "daemon_identity_unavailable",
  "invalid_registry",
  "invalid_scope",
  "invalid_session_path",
  "invalid_session_role",
  "invalid_session_tag",
  "invalid_session_snapshot",
  "session_archived",
  "session_channel_bound",
  "session_cwd_unavailable",
  "session_exists",
  "session_local_path_forbidden",
  "session_list_cursor_not_found",
  "session_role_conflict",
  "session_media_invalid",
  "session_media_not_found",
  "session_mail_not_found",
  "session_mail_origin_binding_required",
  "session_mail_self_target",
  "session_mail_store_unavailable",
  "session_mail_target_archived",
  "session_mail_target_not_local",
  "session_mail_not_channel_delivery",
  "session_mail_not_notification",
  "session_mail_not_user_visible",
  "session_mail_workspace_scope_mismatch",
  "session_not_found",
  "session_registry_unavailable",
  "session_scope_mismatch",
  "session_snapshot_cursor_not_found",
  "session_snapshot_mismatch",
  "session_storage_unavailable",
  "session_transcript_cas_failed",
  "session_transcript_conflict",
  "side_thread_config_empty",
  "workspace_cwd_unavailable",
] as const;

/** Complete typed error vocabulary emitted by the durable session subsystem. */
export const sparkSessionRegistryErrorCodeOptions = [
  ...sparkSessionRegistryDomainErrorCodeOptions,
  ...sparkSideThreadErrorCodeOptions,
] as const;

export const sparkSessionRegistryErrorCodeSchema = z.enum(sparkSessionRegistryErrorCodeOptions);

export type SparkSessionRegistryDomainErrorCode =
  (typeof sparkSessionRegistryDomainErrorCodeOptions)[number];
export type SparkSessionRegistryErrorCode = z.infer<typeof sparkSessionRegistryErrorCodeSchema>;

export function isSparkSessionRegistryErrorCode(
  value: unknown,
): value is SparkSessionRegistryErrorCode {
  return sparkSessionRegistryErrorCodeSchema.safeParse(value).success;
}
