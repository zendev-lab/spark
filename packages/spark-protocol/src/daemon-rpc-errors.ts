import { z } from "zod";

export const sparkDaemonLifecycleRpcErrorCodeOptions = [
  "daemon_restart_conflict",
  "daemon_restart_unavailable",
] as const;

export const sparkChannelRpcErrorCodeOptions = [
  "channel_runtime_unavailable",
  "channel_not_configured",
  "channel_route_not_found",
  "channel_adapter_exists",
  "channel_adapter_unavailable",
  "channel_invalid_action",
  "channel_unsupported_operation",
  "channel_interaction_not_supported",
  "channel_unsupported_adapter",
  "channel_adapter_not_found",
  "channel_image_not_supported",
  "channel_adapter_required",
  "channel_recipient_required",
  "channel_invalid_config",
  "channel_delivery_not_sent",
  "channel_delivery_outcome_unknown",
] as const;

export const sparkLoopRpcErrorCodeOptions = [
  "loop_owner_not_found",
  "loop_owner_archived",
  "loop_active_conflict",
  "loop_not_found",
  "loop_schedule_invalid",
  "loop_generation_conflict",
] as const;

export const sparkInvocationRpcErrorCodeOptions = [
  "invocation_not_found",
  "invocation_not_terminal",
  "invocation_not_retryable",
  "invocation_cursor_gap",
  "invocation_idempotency_conflict",
  "session_not_idle",
] as const;

export const sparkModelRpcErrorCodeOptions = [
  "model_control_unavailable",
  "model_not_found",
  "model_unavailable",
  "provider_not_found",
  "provider_auth_method_unsupported",
  "provider_oauth_not_supported",
  "provider_oauth_flow_not_found",
  "provider_oauth_prompt_conflict",
  "provider_oauth_response_invalid",
] as const;

export const sparkUplinkRpcErrorCodeOptions = [
  "uplink_url_invalid",
  "uplink_profile_not_found",
  "uplink_profile_unrunnable",
  "uplink_parked",
  "uplink_workspace_not_found",
  "uplink_workspace_ambiguous",
  "uplink_transfer_rejected",
] as const;

export const sparkWorkspaceRpcErrorCodeOptions = [
  "workspace_path_conflict",
  "workspace_cwd_invalid",
  "registration_grant_refused",
  "relocation_target_unchanged",
  "relocation_target_invalid",
  "relocation_instance_mismatch",
  "relocation_runtime_mismatch",
  "relocation_source_not_found",
  "relocation_target_collision",
  "relocation_source_not_configured",
  "relocation_source_required",
  "relocation_https_required",
  "relocation_websocket_invalid",
  "relocation_config_changed",
  "relocation_config_incomplete",
  "relocation_metadata_rejected",
  "relocation_preflight_rejected",
  "workspace_not_found",
  "workspace_client_not_found",
  "workspace_client_conflict",
  "workspace_lifecycle_conflict",
  "workspace_registration_failed",
  "workspace_registration_invalid",
  "workspace_registration_unavailable",
  "workspace_transfer_unavailable",
  "workspace_transfer_not_found",
] as const;

export const sparkTaskClaimRpcErrorCodeOptions = [
  "task_claim_lease_invalid",
  "task_claim_not_found",
  "task_claim_conflict",
  "task_claim_store_busy",
  "task_claim_recovery_refused",
] as const;

export const sparkHumanRpcErrorCodeOptions = [
  "human_interaction_not_found",
  "human_interaction_ambiguous",
  "human_wait_registry_unavailable",
  "human_interaction_responder_unavailable",
] as const;

export const sparkDelegationRpcErrorCodeOptions = [
  "workspace_main_session_required",
  "delegation_action_invalid",
  "delegation_not_found",
  "delegation_state_conflict",
  "delegation_invocation_mismatch",
] as const;

export const sparkDaemonRpcDomainErrorCodeOptions = [
  ...sparkDaemonLifecycleRpcErrorCodeOptions,
  ...sparkChannelRpcErrorCodeOptions,
  ...sparkLoopRpcErrorCodeOptions,
  ...sparkInvocationRpcErrorCodeOptions,
  ...sparkModelRpcErrorCodeOptions,
  ...sparkUplinkRpcErrorCodeOptions,
  ...sparkWorkspaceRpcErrorCodeOptions,
  ...sparkTaskClaimRpcErrorCodeOptions,
  ...sparkHumanRpcErrorCodeOptions,
  ...sparkDelegationRpcErrorCodeOptions,
] as const;

export const sparkDaemonRpcDomainErrorCodeSchema = z.enum(sparkDaemonRpcDomainErrorCodeOptions);

export type SparkDaemonLifecycleRpcErrorCode =
  (typeof sparkDaemonLifecycleRpcErrorCodeOptions)[number];
export type SparkChannelRpcErrorCode = (typeof sparkChannelRpcErrorCodeOptions)[number];
export type SparkLoopRpcErrorCode = (typeof sparkLoopRpcErrorCodeOptions)[number];
export type SparkInvocationRpcErrorCode = (typeof sparkInvocationRpcErrorCodeOptions)[number];
export type SparkModelRpcErrorCode = (typeof sparkModelRpcErrorCodeOptions)[number];
export type SparkUplinkRpcErrorCode = (typeof sparkUplinkRpcErrorCodeOptions)[number];
export type SparkWorkspaceRpcErrorCode = (typeof sparkWorkspaceRpcErrorCodeOptions)[number];
export type SparkTaskClaimRpcErrorCode = (typeof sparkTaskClaimRpcErrorCodeOptions)[number];
export type SparkHumanRpcErrorCode = (typeof sparkHumanRpcErrorCodeOptions)[number];
export type SparkDelegationRpcErrorCode = (typeof sparkDelegationRpcErrorCodeOptions)[number];
export type SparkDaemonRpcDomainErrorCode = z.infer<typeof sparkDaemonRpcDomainErrorCodeSchema>;

export function isSparkDaemonRpcDomainErrorCode(
  value: unknown,
): value is SparkDaemonRpcDomainErrorCode {
  return sparkDaemonRpcDomainErrorCodeSchema.safeParse(value).success;
}
