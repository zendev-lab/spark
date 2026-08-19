import { type ContractRouterClient, type ErrorMap, oc } from "@orpc/contract";
import { z } from "zod";
import {
  sparkDirectAnswerProvenanceSchema,
  sparkEvidenceAnswerEventSchema,
  sparkEvidenceRequestBindingSchema,
  sparkHumanInteractionDeliveryOutcomeSchema,
  sparkHumanWaitRespondentSchema,
} from "./human-interaction.ts";
import {
  localRpcMethodToSparkCommandKind,
  sparkProtocolJsonObjectSchema,
  sparkProtocolJsonValueSchema,
} from "./command-events.ts";
import {
  sparkLoopListResultSchema,
  sparkLoopMutationRequestSchema,
  sparkLoopMutationResultSchema,
  sparkLoopScheduleRequestSchema,
  sparkLoopStartRequestSchema,
  sparkLoopStatusRequestSchema,
  sparkLoopWakeRequestSchema,
} from "./loop.ts";
import type {
  SparkChannelRpcErrorCode,
  SparkDaemonLifecycleRpcErrorCode,
  SparkLoopRpcErrorCode,
  SparkHumanRpcErrorCode,
  SparkInvocationRpcErrorCode,
  SparkModelRpcErrorCode,
  SparkTaskClaimRpcErrorCode,
  SparkUplinkRpcErrorCode,
  SparkWorkspaceRpcErrorCode,
} from "./daemon-rpc-errors.ts";
import {
  sparkInvocationListRequestSchema,
  sparkInvocationListResultSchema,
  sparkInvocationRetentionApplyRequestSchema,
  sparkInvocationRetentionApplyResultSchema,
  sparkInvocationRetentionPreviewRequestSchema,
  sparkInvocationRetentionPreviewResultSchema,
  sparkInvocationRetryRequestSchema,
  sparkInvocationRetryResultSchema,
  sparkTurnCancelRequestSchema,
  sparkTurnCancelResultSchema,
  sparkTurnResultSchema,
  sparkTurnStatusRequestSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  sparkTurnStreamRequestSchema,
  sparkTurnSubmitRequestSchema,
  sparkTurnSubmitResultSchema,
} from "./invocation-lifecycle.ts";
import {
  sparkAuthImportReportSchema,
  sparkAuthFlowSchema,
  sparkDefaultModelSetRequestSchema,
  sparkEnabledModelsSetRequestSchema,
  sparkModelControlSnapshotSchema,
  sparkPiAuthImportRequestSchema,
} from "./model-control.ts";
import { isoDateTimeSchema, prefixedIdSchema } from "./refs.ts";
import { sparkSessionModeResultSchema, sparkSessionSetModeRequestSchema } from "./session-mode.ts";
import {
  executorClientProjectionSchema,
  runtimeWorkspaceBindingStatusSchema,
  workspaceBorrowedStateSchema,
  workspaceClientKindSchema,
  workspaceClientProjectionSchema,
  workspaceClientStatusSchema,
} from "./runtime-v1/messages.ts";
import { workspaceBrowserAuthorizationSchema } from "./runtime-v1/registration.ts";
import {
  sparkAssignmentSchema,
  sparkSessionArchiveRequestSchema,
  sparkSessionBindRequestSchema,
  sparkSessionCloseRequestSchema,
  sparkSessionCompactRequestSchema,
  sparkSessionCreateRequestSchema,
  sparkSessionForkRequestSchema,
  sparkSessionGetRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionPromptHistoryRequestSchema,
  sparkSessionRetryTargetRequestSchema,
  sparkSessionRetryTargetSchema,
  sparkSessionPeerProjectionSchema,
  sparkSessionProjectionSchema,
  sparkSessionSpawnRequestSchema,
  sparkSessionSetModelRequestSchema,
  sparkSessionSetThinkingRequestSchema,
  sparkSessionSnapshotRequestSchema,
  sparkSessionUnbindRequestSchema,
} from "./session-assignment.ts";
import {
  sparkSessionInboxRequestSchema,
  sparkSessionInboxResultSchema,
  sparkSessionMailMutationRequestSchema,
  sparkSessionMailMutationResultSchema,
  sparkSessionSendRequestSchema,
  sparkSessionSendResultSchema,
} from "./session-mail.ts";
import type { SparkSessionRegistryErrorCode } from "./session-errors.ts";
import {
  sparkSideThreadConfigureRequestSchema,
  sparkSideThreadEnsureRequestSchema,
  sparkSideThreadErrorCodeOptions,
  sparkSideThreadHandoffRequestSchema,
  sparkSideThreadHandoffResultSchema,
  sparkSideThreadResetRequestSchema,
  sparkSideThreadSnapshotRequestSchema,
  sparkSideThreadSnapshotSchema,
  sparkSideThreadSubmitRequestSchema,
  sparkSideThreadSubmitResultSchema,
} from "./side-thread.ts";
import {
  sparkTaskClaimAcquireRequestSchema,
  sparkTaskClaimMutationResultSchema,
  sparkTaskClaimRecoverRequestSchema,
  sparkTaskClaimReleaseRequestSchema,
} from "./task-claim.ts";
import {
  sparkLegacyTokenUsageBackfillRequestSchema,
  sparkLegacyTokenUsageBackfillResultSchema,
  sparkTokenUsageAggregateSchema,
  sparkTokenUsageByPersistenceSchema,
  sparkTokenUsagePersistenceRequestSchema,
  sparkTokenUsageSummaryRequestSchema,
} from "./token-usage.ts";
import {
  sparkReproMutationResultSchema,
  sparkReproStartRequestSchema,
  sparkReproStatusRequestSchema,
  sparkReproStatusResultSchema,
  sparkReproStopRequestSchema,
} from "./repro.ts";
import { sparkSessionPromptHistorySchema, sparkSessionViewSchema } from "./protocol.ts";
import { SPARK_PROTOCOL_VERSION } from "./version.ts";
import {
  workspaceDelegationExecuteRequestSchema,
  workspaceDelegationExecuteResultSchema,
} from "./workspace-delegation.ts";

export type SparkLocalRpcMethod = keyof typeof localRpcMethodToSparkCommandKind;
/** @deprecated Prefer {@link SparkLocalRpcMethod}. */
export type SparkLocalRpcOrpcMethod = SparkLocalRpcMethod;

export const sparkLocalRpcSideThreadOrpcErrors = {
  side_thread_parent_not_found: { status: 404 },
  side_thread_parent_archived: { status: 409 },
  side_thread_nesting_forbidden: { status: 409 },
  side_thread_scope_mismatch: { status: 409 },
  side_thread_not_found: { status: 404 },
  side_thread_archived: { status: 409 },
  side_thread_generation_conflict: { status: 409 },
  side_thread_head_conflict: { status: 409 },
  side_thread_idempotency_conflict: { status: 409 },
  side_thread_direct_submit_forbidden: { status: 403 },
  side_thread_mutation_forbidden: { status: 403 },
  side_thread_busy: { status: 409 },
  side_thread_drain_timeout: { status: 408 },
  side_thread_transcript_invalid: { status: 500 },
  side_thread_model_unavailable: { status: 422 },
  side_thread_handoff_too_large: { status: 413 },
} as const satisfies Record<(typeof sparkSideThreadErrorCodeOptions)[number], { status: number }>;

export const sparkLocalRpcReadinessOrpcErrors = {
  daemon_starting: { status: 503 },
} as const;

export const sparkLocalRpcDelegationOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  workspace_administrator_session_required: { status: 403 },
  delegation_action_invalid: { status: 422 },
  delegation_not_found: { status: 404 },
  delegation_state_conflict: { status: 409 },
  delegation_invocation_mismatch: { status: 403 },
} as const;

type SparkLocalRpcErrorSpec = {
  status: number;
  data?: z.ZodType;
};

export const sparkLocalRpcSessionOrpcErrors = {
  binding_ambiguous: { status: 409 },
  binding_conflict: { status: 409 },
  binding_not_found: { status: 404 },
  binding_unbound: { status: 404 },
  create_required: { status: 422 },
  daemon_cwd_unavailable: { status: 422 },
  daemon_identity_unavailable: { status: 422 },
  invalid_registry: { status: 500 },
  invalid_scope: { status: 422 },
  invalid_session_path: { status: 422 },
  invalid_session_role: { status: 422 },
  invalid_session_tag: { status: 422 },
  invalid_session_snapshot: { status: 500 },
  session_archived: { status: 409 },
  session_channel_bound: { status: 409 },
  session_cwd_unavailable: { status: 422 },
  session_exists: { status: 409 },
  session_local_path_forbidden: { status: 403 },
  session_list_cursor_not_found: { status: 404 },
  session_role_conflict: { status: 409 },
  session_mail_not_found: { status: 404 },
  session_mail_not_channel_delivery: { status: 422 },
  session_mail_not_notification: { status: 422 },
  session_mail_not_user_visible: { status: 422 },
  session_mail_origin_binding_required: { status: 422 },
  session_mail_queue_full: { status: 429 },
  session_mail_self_target: { status: 422 },
  session_mail_store_unavailable: { status: 503 },
  session_mail_target_active: { status: 409 },
  session_mail_target_archived: { status: 409 },
  session_mail_target_not_local: { status: 422 },
  session_mail_workspace_scope_mismatch: { status: 403 },
  session_media_invalid: { status: 422 },
  session_media_not_found: { status: 404 },
  invalid_session_name: { status: 422 },
  session_closed: { status: 409 },
  session_closing: { status: 409 },
  session_not_found: { status: 404 },
  session_owner_invalid: { status: 409 },
  session_owner_not_found: { status: 404 },
  session_owner_scope_mismatch: { status: 409 },
  session_registry_conflict: { status: 409 },
  session_registry_unavailable: { status: 503 },
  session_restore_forbidden: { status: 403 },
  session_scope_mismatch: { status: 409 },
  session_snapshot_cursor_not_found: { status: 404 },
  session_snapshot_mismatch: { status: 409 },
  session_storage_unavailable: { status: 503 },
  session_transcript_cas_failed: { status: 409 },
  session_transcript_changed: { status: 409 },
  session_transcript_conflict: { status: 409 },
  side_thread_config_empty: { status: 422 },
  workspace_cwd_unavailable: { status: 422 },
  workspace_administrator_session_mutation_forbidden: { status: 403 },
  ...sparkLocalRpcSideThreadOrpcErrors,
} as const satisfies Record<SparkSessionRegistryErrorCode, { status: number }>;

export const sparkLocalRpcDaemonOrpcErrors = {
  daemon_restart_conflict: { status: 409 },
  daemon_restart_unavailable: { status: 503 },
} as const satisfies Record<SparkDaemonLifecycleRpcErrorCode, SparkLocalRpcErrorSpec>;

const sparkChannelDeliveryErrorDataSchema = z.object({
  certainty: z.enum(["not-sent", "unknown"]),
});

export const sparkLocalRpcChannelOrpcErrors = {
  channel_runtime_unavailable: { status: 503 },
  channel_not_configured: { status: 422 },
  channel_route_not_found: { status: 404 },
  channel_adapter_exists: { status: 409 },
  channel_adapter_unavailable: { status: 503 },
  channel_invalid_action: { status: 422 },
  channel_unsupported_operation: { status: 422 },
  channel_interaction_not_supported: { status: 422 },
  channel_unsupported_adapter: { status: 422 },
  channel_adapter_not_found: { status: 404 },
  channel_image_not_supported: { status: 422 },
  channel_adapter_required: { status: 422 },
  channel_recipient_required: { status: 422 },
  channel_invalid_config: { status: 422 },
  channel_delivery_not_sent: {
    status: 502,
    data: sparkChannelDeliveryErrorDataSchema,
  },
  channel_delivery_outcome_unknown: {
    status: 502,
    data: sparkChannelDeliveryErrorDataSchema,
  },
} as const satisfies Record<SparkChannelRpcErrorCode, SparkLocalRpcErrorSpec>;

export const sparkLocalRpcLoopOrpcErrors = {
  loop_owner_not_found: { status: 404 },
  loop_owner_archived: { status: 409 },
  loop_active_conflict: { status: 409 },
  loop_not_found: { status: 404 },
  loop_schedule_invalid: { status: 422 },
  loop_generation_conflict: { status: 409 },
} as const satisfies Record<SparkLoopRpcErrorCode, SparkLocalRpcErrorSpec>;

export const sparkLocalRpcInvocationOrpcErrors = {
  invocation_not_found: { status: 404 },
  invocation_not_terminal: { status: 409 },
  invocation_not_retryable: { status: 409 },
  invocation_cursor_gap: { status: 409 },
  invocation_idempotency_conflict: { status: 409 },
  session_not_idle: { status: 409 },
} as const satisfies Record<SparkInvocationRpcErrorCode, SparkLocalRpcErrorSpec>;

export const sparkLocalRpcModelOrpcErrors = {
  model_control_unavailable: { status: 503 },
  role_model_type_unconfigured: { status: 422 },
  model_not_found: { status: 404 },
  model_not_enabled: { status: 422 },
  enabled_models_intent_required: { status: 403 },
  model_unavailable: { status: 422 },
  provider_not_found: { status: 404 },
  provider_auth_method_unsupported: { status: 422 },
  provider_oauth_not_supported: { status: 422 },
  provider_oauth_flow_not_found: { status: 404 },
  provider_oauth_prompt_conflict: { status: 409 },
  provider_oauth_response_invalid: { status: 422 },
} as const satisfies Record<SparkModelRpcErrorCode, SparkLocalRpcErrorSpec>;

export const sparkLocalRpcTaskClaimOrpcErrors = {
  task_claim_lease_invalid: { status: 403 },
  task_claim_not_found: { status: 404 },
  task_claim_conflict: { status: 409 },
  task_claim_store_busy: { status: 503 },
  task_claim_recovery_refused: { status: 409 },
} as const satisfies Record<SparkTaskClaimRpcErrorCode, SparkLocalRpcErrorSpec>;

export const sparkLocalRpcUplinkOrpcErrors = {
  uplink_url_invalid: { status: 422 },
  uplink_profile_not_found: { status: 404 },
  uplink_profile_unrunnable: { status: 422 },
  uplink_parked: { status: 409 },
  uplink_workspace_not_found: { status: 404 },
  uplink_workspace_ambiguous: { status: 409 },
  uplink_transfer_rejected: { status: 409 },
} as const satisfies Record<SparkUplinkRpcErrorCode, SparkLocalRpcErrorSpec>;

export const sparkLocalRpcWorkspaceOrpcErrors = {
  workspace_path_conflict: {
    status: 409,
    data: z.object({ kind: z.enum(["same-path", "same-key", "nested"]) }),
  },
  workspace_cwd_invalid: { status: 422 },
  registration_grant_refused: { status: 403 },
  relocation_target_unchanged: { status: 409 },
  relocation_target_invalid: { status: 422 },
  relocation_instance_mismatch: { status: 409 },
  relocation_runtime_mismatch: { status: 409 },
  relocation_source_not_found: { status: 404 },
  relocation_target_collision: { status: 409 },
  relocation_source_not_configured: { status: 422 },
  relocation_source_required: { status: 422 },
  relocation_https_required: { status: 422 },
  relocation_websocket_invalid: { status: 422 },
  relocation_config_changed: { status: 409 },
  relocation_config_incomplete: { status: 422 },
  relocation_metadata_rejected: { status: 502 },
  relocation_preflight_rejected: { status: 502 },
  workspace_not_found: { status: 404 },
  workspace_client_not_found: { status: 404 },
  workspace_client_conflict: { status: 409 },
  workspace_lifecycle_conflict: { status: 409 },
  workspace_registration_failed: { status: 502 },
  workspace_registration_invalid: { status: 422 },
  workspace_registration_unavailable: { status: 503 },
  workspace_transfer_unavailable: { status: 503 },
  workspace_transfer_not_found: { status: 404 },
} as const satisfies Record<SparkWorkspaceRpcErrorCode, SparkLocalRpcErrorSpec>;

export const sparkLocalRpcHumanOrpcErrors = {
  human_interaction_not_found: { status: 404 },
  human_interaction_ambiguous: { status: 409 },
  human_interaction_forbidden: { status: 403 },
  human_wait_registry_unavailable: { status: 503 },
  human_interaction_responder_unavailable: { status: 503 },
} as const satisfies Record<SparkHumanRpcErrorCode, SparkLocalRpcErrorSpec>;

/** Complete compatibility union. Individual procedures expose narrower maps. */
export const sparkLocalRpcCommonOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  ...sparkLocalRpcSessionOrpcErrors,
  ...sparkLocalRpcDaemonOrpcErrors,
  ...sparkLocalRpcChannelOrpcErrors,
  ...sparkLocalRpcLoopOrpcErrors,
  ...sparkLocalRpcInvocationOrpcErrors,
  ...sparkLocalRpcModelOrpcErrors,
  ...sparkLocalRpcUplinkOrpcErrors,
  ...sparkLocalRpcWorkspaceOrpcErrors,
  ...sparkLocalRpcTaskClaimOrpcErrors,
  ...sparkLocalRpcHumanOrpcErrors,
} as const;

export const sparkLocalRpcOrpcErrors = {
  ...sparkLocalRpcCommonOrpcErrors,
  ...sparkLocalRpcSideThreadOrpcErrors,
} as const;

const sparkLocalRpcSessionRegistryBaseOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  invalid_registry: sparkLocalRpcSessionOrpcErrors.invalid_registry,
  session_registry_unavailable: sparkLocalRpcSessionOrpcErrors.session_registry_unavailable,
} as const;

const sparkLocalRpcSessionListOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  daemon_identity_unavailable: sparkLocalRpcSessionOrpcErrors.daemon_identity_unavailable,
  session_list_cursor_not_found: sparkLocalRpcSessionOrpcErrors.session_list_cursor_not_found,
  session_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_scope_mismatch,
} as const;

const sparkLocalRpcSessionGetOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  session_not_found: sparkLocalRpcSessionOrpcErrors.session_not_found,
  session_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_scope_mismatch,
  side_thread_not_found: sparkLocalRpcSessionOrpcErrors.side_thread_not_found,
} as const;

const sparkLocalRpcSessionSnapshotOrpcErrors = {
  ...sparkLocalRpcSessionGetOrpcErrors,
  invalid_session_snapshot: sparkLocalRpcSessionOrpcErrors.invalid_session_snapshot,
  session_snapshot_cursor_not_found:
    sparkLocalRpcSessionOrpcErrors.session_snapshot_cursor_not_found,
  session_snapshot_mismatch: sparkLocalRpcSessionOrpcErrors.session_snapshot_mismatch,
  session_storage_unavailable: sparkLocalRpcSessionOrpcErrors.session_storage_unavailable,
} as const;

const sparkLocalRpcSessionPromptHistoryOrpcErrors = {
  ...sparkLocalRpcSessionGetOrpcErrors,
  invalid_session_snapshot: sparkLocalRpcSessionOrpcErrors.invalid_session_snapshot,
  session_snapshot_mismatch: sparkLocalRpcSessionOrpcErrors.session_snapshot_mismatch,
  session_storage_unavailable: sparkLocalRpcSessionOrpcErrors.session_storage_unavailable,
} as const;

const sparkLocalRpcSessionCreateOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  create_required: sparkLocalRpcSessionOrpcErrors.create_required,
  daemon_cwd_unavailable: sparkLocalRpcSessionOrpcErrors.daemon_cwd_unavailable,
  daemon_identity_unavailable: sparkLocalRpcSessionOrpcErrors.daemon_identity_unavailable,
  invalid_scope: sparkLocalRpcSessionOrpcErrors.invalid_scope,
  invalid_session_path: sparkLocalRpcSessionOrpcErrors.invalid_session_path,
  invalid_session_role: sparkLocalRpcSessionOrpcErrors.invalid_session_role,
  session_exists: sparkLocalRpcSessionOrpcErrors.session_exists,
  session_local_path_forbidden: sparkLocalRpcSessionOrpcErrors.session_local_path_forbidden,
  session_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_scope_mismatch,
  workspace_cwd_unavailable: sparkLocalRpcSessionOrpcErrors.workspace_cwd_unavailable,
} as const;

const sparkLocalRpcManagedChildSessionOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  invalid_scope: sparkLocalRpcSessionOrpcErrors.invalid_scope,
  invalid_session_role: sparkLocalRpcSessionOrpcErrors.invalid_session_role,
  session_archived: sparkLocalRpcSessionOrpcErrors.session_archived,
  session_channel_bound: sparkLocalRpcSessionOrpcErrors.session_channel_bound,
  session_closed: sparkLocalRpcSessionOrpcErrors.session_closed,
  session_closing: sparkLocalRpcSessionOrpcErrors.session_closing,
  session_exists: sparkLocalRpcSessionOrpcErrors.session_exists,
  session_owner_not_found: sparkLocalRpcSessionOrpcErrors.session_owner_not_found,
  session_owner_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_owner_scope_mismatch,
  session_storage_unavailable: sparkLocalRpcSessionOrpcErrors.session_storage_unavailable,
  session_transcript_changed: sparkLocalRpcSessionOrpcErrors.session_transcript_changed,
  session_transcript_conflict: sparkLocalRpcSessionOrpcErrors.session_transcript_conflict,
  workspace_cwd_unavailable: sparkLocalRpcSessionOrpcErrors.workspace_cwd_unavailable,
} as const;

const sparkLocalRpcSessionBindOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  binding_conflict: sparkLocalRpcSessionOrpcErrors.binding_conflict,
  session_archived: sparkLocalRpcSessionOrpcErrors.session_archived,
  session_not_found: sparkLocalRpcSessionOrpcErrors.session_not_found,
  session_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_scope_mismatch,
  side_thread_mutation_forbidden: sparkLocalRpcSessionOrpcErrors.side_thread_mutation_forbidden,
} as const;

const sparkLocalRpcSessionUnbindOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  binding_ambiguous: sparkLocalRpcSessionOrpcErrors.binding_ambiguous,
  binding_not_found: sparkLocalRpcSessionOrpcErrors.binding_not_found,
  session_not_found: sparkLocalRpcSessionOrpcErrors.session_not_found,
  session_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_scope_mismatch,
  side_thread_mutation_forbidden: sparkLocalRpcSessionOrpcErrors.side_thread_mutation_forbidden,
} as const;

const sparkLocalRpcSessionArchiveOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  session_channel_bound: sparkLocalRpcSessionOrpcErrors.session_channel_bound,
  session_not_found: sparkLocalRpcSessionOrpcErrors.session_not_found,
  session_owner_invalid: sparkLocalRpcSessionOrpcErrors.session_owner_invalid,
  session_registry_conflict: sparkLocalRpcSessionOrpcErrors.session_registry_conflict,
  session_restore_forbidden: sparkLocalRpcSessionOrpcErrors.session_restore_forbidden,
  session_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_scope_mismatch,
  side_thread_mutation_forbidden: sparkLocalRpcSessionOrpcErrors.side_thread_mutation_forbidden,
} as const;

const sparkLocalRpcSessionCompactOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  session_archived: sparkLocalRpcSessionOrpcErrors.session_archived,
  session_cwd_unavailable: sparkLocalRpcSessionOrpcErrors.session_cwd_unavailable,
  session_not_found: sparkLocalRpcSessionOrpcErrors.session_not_found,
  session_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_scope_mismatch,
  side_thread_mutation_forbidden: sparkLocalRpcSessionOrpcErrors.side_thread_mutation_forbidden,
  invocation_idempotency_conflict:
    sparkLocalRpcInvocationOrpcErrors.invocation_idempotency_conflict,
  model_not_found: sparkLocalRpcModelOrpcErrors.model_not_found,
  model_unavailable: sparkLocalRpcModelOrpcErrors.model_unavailable,
} as const;

const sparkLocalRpcSessionInboxOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  session_mail_store_unavailable: sparkLocalRpcSessionOrpcErrors.session_mail_store_unavailable,
} as const;

const sparkLocalRpcSessionMailMutationOrpcErrors = {
  ...sparkLocalRpcSessionInboxOrpcErrors,
  session_mail_not_found: sparkLocalRpcSessionOrpcErrors.session_mail_not_found,
} as const;

const sparkLocalRpcReadinessDaemonOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  ...sparkLocalRpcDaemonOrpcErrors,
} as const;

const sparkLocalRpcReadinessChannelOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  ...sparkLocalRpcChannelOrpcErrors,
} as const;

const sparkLocalRpcChannelStatusOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  channel_runtime_unavailable: sparkLocalRpcChannelOrpcErrors.channel_runtime_unavailable,
} as const;

const sparkLocalRpcChannelNotifyOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  channel_runtime_unavailable: sparkLocalRpcChannelOrpcErrors.channel_runtime_unavailable,
  channel_not_configured: sparkLocalRpcChannelOrpcErrors.channel_not_configured,
  channel_route_not_found: sparkLocalRpcChannelOrpcErrors.channel_route_not_found,
  channel_adapter_unavailable: sparkLocalRpcChannelOrpcErrors.channel_adapter_unavailable,
  channel_unsupported_operation: sparkLocalRpcChannelOrpcErrors.channel_unsupported_operation,
  channel_adapter_not_found: sparkLocalRpcChannelOrpcErrors.channel_adapter_not_found,
  channel_adapter_required: sparkLocalRpcChannelOrpcErrors.channel_adapter_required,
  channel_recipient_required: sparkLocalRpcChannelOrpcErrors.channel_recipient_required,
  channel_delivery_not_sent: sparkLocalRpcChannelOrpcErrors.channel_delivery_not_sent,
  channel_delivery_outcome_unknown: sparkLocalRpcChannelOrpcErrors.channel_delivery_outcome_unknown,
} as const;

const sparkLocalRpcReadinessLoopStartOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  loop_owner_not_found: sparkLocalRpcLoopOrpcErrors.loop_owner_not_found,
  loop_owner_archived: sparkLocalRpcLoopOrpcErrors.loop_owner_archived,
  loop_active_conflict: sparkLocalRpcLoopOrpcErrors.loop_active_conflict,
} as const;

const sparkLocalRpcReadinessLoopMutationOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  loop_not_found: sparkLocalRpcLoopOrpcErrors.loop_not_found,
} as const;

const sparkLocalRpcReadinessLoopRestartOrpcErrors = {
  ...sparkLocalRpcReadinessLoopMutationOrpcErrors,
  loop_active_conflict: sparkLocalRpcLoopOrpcErrors.loop_active_conflict,
} as const;

const sparkLocalRpcReadinessLoopScheduleOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  loop_schedule_invalid: sparkLocalRpcLoopOrpcErrors.loop_schedule_invalid,
  loop_generation_conflict: sparkLocalRpcLoopOrpcErrors.loop_generation_conflict,
} as const;

const sparkLocalRpcSessionInvocationNotFoundOrpcErrors = {
  ...sparkLocalRpcSessionOrpcErrors,
  invocation_not_found: sparkLocalRpcInvocationOrpcErrors.invocation_not_found,
} as const;

const sparkLocalRpcTurnResultOrpcErrors = {
  invocation_not_found: sparkLocalRpcInvocationOrpcErrors.invocation_not_found,
  invocation_not_terminal: sparkLocalRpcInvocationOrpcErrors.invocation_not_terminal,
} as const;

const sparkLocalRpcTurnStreamOrpcErrors = {
  ...sparkLocalRpcSessionInvocationNotFoundOrpcErrors,
  invocation_cursor_gap: sparkLocalRpcInvocationOrpcErrors.invocation_cursor_gap,
} as const;

const sparkLocalRpcReadinessSessionInvocationRetryOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  ...sparkLocalRpcSessionOrpcErrors,
  invocation_not_found: sparkLocalRpcInvocationOrpcErrors.invocation_not_found,
  invocation_not_retryable: sparkLocalRpcInvocationOrpcErrors.invocation_not_retryable,
} as const;

const sparkLocalRpcTurnSubmitOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  session_not_found: sparkLocalRpcSessionOrpcErrors.session_not_found,
  session_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_scope_mismatch,
  session_cwd_unavailable: sparkLocalRpcSessionOrpcErrors.session_cwd_unavailable,
  side_thread_direct_submit_forbidden:
    sparkLocalRpcSessionOrpcErrors.side_thread_direct_submit_forbidden,
  invocation_idempotency_conflict:
    sparkLocalRpcInvocationOrpcErrors.invocation_idempotency_conflict,
  session_not_idle: sparkLocalRpcInvocationOrpcErrors.session_not_idle,
  model_not_found: sparkLocalRpcModelOrpcErrors.model_not_found,
  model_unavailable: sparkLocalRpcModelOrpcErrors.model_unavailable,
} as const;

const sparkLocalRpcSessionSendOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  session_not_found: sparkLocalRpcSessionOrpcErrors.session_not_found,
  session_scope_mismatch: sparkLocalRpcSessionOrpcErrors.session_scope_mismatch,
  session_cwd_unavailable: sparkLocalRpcSessionOrpcErrors.session_cwd_unavailable,
  side_thread_not_found: sparkLocalRpcSessionOrpcErrors.side_thread_not_found,
  session_mail_not_found: sparkLocalRpcSessionOrpcErrors.session_mail_not_found,
  session_mail_origin_binding_required:
    sparkLocalRpcSessionOrpcErrors.session_mail_origin_binding_required,
  session_mail_queue_full: sparkLocalRpcSessionOrpcErrors.session_mail_queue_full,
  session_mail_self_target: sparkLocalRpcSessionOrpcErrors.session_mail_self_target,
  session_mail_target_active: sparkLocalRpcSessionOrpcErrors.session_mail_target_active,
  session_mail_store_unavailable: sparkLocalRpcSessionOrpcErrors.session_mail_store_unavailable,
  session_mail_target_archived: sparkLocalRpcSessionOrpcErrors.session_mail_target_archived,
  session_mail_target_not_local: sparkLocalRpcSessionOrpcErrors.session_mail_target_not_local,
  session_mail_workspace_scope_mismatch:
    sparkLocalRpcSessionOrpcErrors.session_mail_workspace_scope_mismatch,
  invocation_idempotency_conflict:
    sparkLocalRpcInvocationOrpcErrors.invocation_idempotency_conflict,
  session_not_idle: sparkLocalRpcInvocationOrpcErrors.session_not_idle,
  ...sparkLocalRpcModelOrpcErrors,
} as const;

const sparkLocalRpcReadinessSessionModelOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  session_archived: sparkLocalRpcSessionOrpcErrors.session_archived,
  session_not_found: sparkLocalRpcSessionOrpcErrors.session_not_found,
  side_thread_mutation_forbidden: sparkLocalRpcSessionOrpcErrors.side_thread_mutation_forbidden,
  model_control_unavailable: sparkLocalRpcModelOrpcErrors.model_control_unavailable,
  model_not_found: sparkLocalRpcModelOrpcErrors.model_not_found,
  model_not_enabled: sparkLocalRpcModelOrpcErrors.model_not_enabled,
  model_unavailable: sparkLocalRpcModelOrpcErrors.model_unavailable,
} as const;

const sparkLocalRpcReadinessSessionChannelOrpcErrors = {
  ...sparkLocalRpcSessionRegistryBaseOrpcErrors,
  session_not_found: sparkLocalRpcSessionOrpcErrors.session_not_found,
  session_mail_not_found: sparkLocalRpcSessionOrpcErrors.session_mail_not_found,
  session_mail_not_channel_delivery:
    sparkLocalRpcSessionOrpcErrors.session_mail_not_channel_delivery,
  session_mail_not_notification: sparkLocalRpcSessionOrpcErrors.session_mail_not_notification,
  session_mail_not_user_visible: sparkLocalRpcSessionOrpcErrors.session_mail_not_user_visible,
  session_mail_store_unavailable: sparkLocalRpcSessionOrpcErrors.session_mail_store_unavailable,
  ...sparkLocalRpcChannelOrpcErrors,
} as const;

const sparkLocalRpcReadinessModelOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  ...sparkLocalRpcModelOrpcErrors,
} as const;

const sparkLocalRpcModelCatalogOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  model_control_unavailable: sparkLocalRpcModelOrpcErrors.model_control_unavailable,
} as const;

const sparkLocalRpcEnabledModelsSetOrpcErrors = {
  ...sparkLocalRpcModelCatalogOrpcErrors,
  enabled_models_intent_required: sparkLocalRpcModelOrpcErrors.enabled_models_intent_required,
} as const;

const sparkLocalRpcModelSelectionOrpcErrors = {
  ...sparkLocalRpcModelCatalogOrpcErrors,
  model_not_found: sparkLocalRpcModelOrpcErrors.model_not_found,
  model_not_enabled: sparkLocalRpcModelOrpcErrors.model_not_enabled,
  model_unavailable: sparkLocalRpcModelOrpcErrors.model_unavailable,
} as const;

const sparkLocalRpcProviderApiKeyOrpcErrors = {
  ...sparkLocalRpcModelCatalogOrpcErrors,
  provider_not_found: sparkLocalRpcModelOrpcErrors.provider_not_found,
  provider_auth_method_unsupported: sparkLocalRpcModelOrpcErrors.provider_auth_method_unsupported,
} as const;

const sparkLocalRpcProviderOAuthStartOrpcErrors = {
  ...sparkLocalRpcModelCatalogOrpcErrors,
  provider_not_found: sparkLocalRpcModelOrpcErrors.provider_not_found,
  provider_oauth_not_supported: sparkLocalRpcModelOrpcErrors.provider_oauth_not_supported,
} as const;

const sparkLocalRpcProviderOAuthStatusOrpcErrors = {
  ...sparkLocalRpcModelCatalogOrpcErrors,
  provider_oauth_flow_not_found: sparkLocalRpcModelOrpcErrors.provider_oauth_flow_not_found,
} as const;

const sparkLocalRpcProviderOAuthRespondOrpcErrors = {
  ...sparkLocalRpcProviderOAuthStatusOrpcErrors,
  provider_oauth_prompt_conflict: sparkLocalRpcModelOrpcErrors.provider_oauth_prompt_conflict,
  provider_oauth_response_invalid: sparkLocalRpcModelOrpcErrors.provider_oauth_response_invalid,
} as const;

const sparkLocalRpcUplinkProfileOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  uplink_url_invalid: sparkLocalRpcUplinkOrpcErrors.uplink_url_invalid,
  uplink_profile_not_found: sparkLocalRpcUplinkOrpcErrors.uplink_profile_not_found,
} as const;

const sparkLocalRpcUplinkPreferOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  ...sparkLocalRpcUplinkOrpcErrors,
  workspace_path_conflict: sparkLocalRpcWorkspaceOrpcErrors.workspace_path_conflict,
} as const;

const sparkLocalRpcWorkspaceRegisterOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  workspace_path_conflict: sparkLocalRpcWorkspaceOrpcErrors.workspace_path_conflict,
  registration_grant_refused: sparkLocalRpcWorkspaceOrpcErrors.registration_grant_refused,
  workspace_registration_failed: sparkLocalRpcWorkspaceOrpcErrors.workspace_registration_failed,
  workspace_registration_invalid: sparkLocalRpcWorkspaceOrpcErrors.workspace_registration_invalid,
  workspace_registration_unavailable:
    sparkLocalRpcWorkspaceOrpcErrors.workspace_registration_unavailable,
} as const;

const sparkLocalRpcWorkspaceRelocateOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  relocation_target_unchanged: sparkLocalRpcWorkspaceOrpcErrors.relocation_target_unchanged,
  relocation_target_invalid: sparkLocalRpcWorkspaceOrpcErrors.relocation_target_invalid,
  relocation_instance_mismatch: sparkLocalRpcWorkspaceOrpcErrors.relocation_instance_mismatch,
  relocation_runtime_mismatch: sparkLocalRpcWorkspaceOrpcErrors.relocation_runtime_mismatch,
  relocation_source_not_found: sparkLocalRpcWorkspaceOrpcErrors.relocation_source_not_found,
  relocation_target_collision: sparkLocalRpcWorkspaceOrpcErrors.relocation_target_collision,
  relocation_source_not_configured:
    sparkLocalRpcWorkspaceOrpcErrors.relocation_source_not_configured,
  relocation_source_required: sparkLocalRpcWorkspaceOrpcErrors.relocation_source_required,
  relocation_https_required: sparkLocalRpcWorkspaceOrpcErrors.relocation_https_required,
  relocation_websocket_invalid: sparkLocalRpcWorkspaceOrpcErrors.relocation_websocket_invalid,
  relocation_config_changed: sparkLocalRpcWorkspaceOrpcErrors.relocation_config_changed,
  relocation_config_incomplete: sparkLocalRpcWorkspaceOrpcErrors.relocation_config_incomplete,
  relocation_metadata_rejected: sparkLocalRpcWorkspaceOrpcErrors.relocation_metadata_rejected,
  relocation_preflight_rejected: sparkLocalRpcWorkspaceOrpcErrors.relocation_preflight_rejected,
} as const;

const sparkLocalRpcWorkspaceEnsureOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  workspace_path_conflict: sparkLocalRpcWorkspaceOrpcErrors.workspace_path_conflict,
  workspace_not_found: sparkLocalRpcWorkspaceOrpcErrors.workspace_not_found,
  workspace_cwd_invalid: sparkLocalRpcWorkspaceOrpcErrors.workspace_cwd_invalid,
} as const;

const sparkLocalRpcWorkspaceMutationOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  workspace_not_found: sparkLocalRpcWorkspaceOrpcErrors.workspace_not_found,
} as const;

const sparkLocalRpcWorkspaceLifecycleOrpcErrors = {
  ...sparkLocalRpcWorkspaceMutationOrpcErrors,
  workspace_path_conflict: sparkLocalRpcWorkspaceOrpcErrors.workspace_path_conflict,
  workspace_lifecycle_conflict: sparkLocalRpcWorkspaceOrpcErrors.workspace_lifecycle_conflict,
  workspace_registration_invalid: sparkLocalRpcWorkspaceOrpcErrors.workspace_registration_invalid,
} as const;

const sparkLocalRpcWorkspaceClientAttachOrpcErrors = {
  ...sparkLocalRpcWorkspaceMutationOrpcErrors,
  workspace_client_conflict: sparkLocalRpcWorkspaceOrpcErrors.workspace_client_conflict,
} as const;

const sparkLocalRpcReadinessTaskClaimOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  ...sparkLocalRpcTaskClaimOrpcErrors,
} as const;

const sparkLocalRpcWorkspaceClientMutationOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  workspace_client_not_found: sparkLocalRpcWorkspaceOrpcErrors.workspace_client_not_found,
} as const;

const sparkLocalRpcWorkspaceTransferOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  workspace_transfer_unavailable: sparkLocalRpcWorkspaceOrpcErrors.workspace_transfer_unavailable,
  workspace_transfer_not_found: sparkLocalRpcWorkspaceOrpcErrors.workspace_transfer_not_found,
} as const;

const sparkLocalRpcReadinessSideThreadOrpcErrors = {
  ...sparkLocalRpcReadinessOrpcErrors,
  ...sparkLocalRpcSideThreadOrpcErrors,
} as const;

const sparkLocalRpcNoOrpcErrors = {} as const;

export type SparkLocalRpcOrpcErrorCode = keyof typeof sparkLocalRpcOrpcErrors;

export function isSparkLocalRpcOrpcErrorCode(value: unknown): value is SparkLocalRpcOrpcErrorCode {
  return typeof value === "string" && value in sparkLocalRpcOrpcErrors;
}

export const sparkLocalRpcEmptyInputSchema = z.object({}).default({});

export const sparkLocalRpcDaemonLifecycleSchema = z.object({
  state: z.enum(["starting", "running", "draining", "stopping"]),
  phase: z
    .enum([
      "initializing",
      "serving",
      "draining-active-work",
      "draining-channel-ingress",
      "stopping",
    ])
    .optional(),
  process: z
    .object({
      pid: z.number().int().positive(),
      instanceId: z.string().min(1),
      generation: z.string().min(1),
      protocolVersion: z.literal(SPARK_PROTOCOL_VERSION),
      startedAt: isoDateTimeSchema,
      acceptedRestartId: z.string().min(1).optional(),
      predecessorInstanceId: z.string().min(1).optional(),
      predecessorGeneration: z.string().min(1).optional(),
    })
    .optional(),
  restartId: z.string().min(1).optional(),
  targetInstanceId: z.string().min(1).optional(),
  targetGeneration: z.string().min(1).optional(),
  targetVersion: z.string().min(1).optional(),
  targetBuildFingerprint: z.string().min(1).optional(),
  restartRequestedAt: isoDateTimeSchema.optional(),
  drain: z
    .object({
      observedAt: isoDateTimeSchema,
      stage: z.enum(["active-work", "channel-ingress"]),
      scheduler: z.array(
        z.object({
          invocationId: z.string().min(1),
          kind: z.string().min(1),
          startedAt: isoDateTimeSchema,
          sessionId: z.string().min(1).optional(),
        }),
      ),
      direct: z.array(
        z.object({
          invocationId: z.string().min(1),
          kind: z.string().min(1),
          startedAt: isoDateTimeSchema,
          sessionId: z.string().min(1).optional(),
        }),
      ),
    })
    .optional(),
  stopRequestedAt: isoDateTimeSchema.optional(),
  stopReason: z.string().optional(),
});

export const sparkLocalRpcDaemonStatusResultSchema = z.object({
  servers: z.array(
    z.object({
      url: z.string(),
      workspaceCount: z.number().int().nonnegative(),
      wsConnected: z.boolean(),
      lastHeartbeatAt: isoDateTimeSchema.optional(),
      lastDisconnectReason: z.string().optional(),
    }),
  ),
  invocations: z.object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  invocationHealth: z.object({
    oldestQueuedAt: isoDateTimeSchema.optional(),
    oldestRunningAt: isoDateTimeSchema.optional(),
  }),
  execution: z
    .object({
      backend: z.literal("in_process"),
      rootConcurrency: z.number().int().min(1).max(64),
      questionOverflow: z.literal(1),
    })
    .optional(),
  channelDeliveries: z
    .object({
      pending: z.number().int().nonnegative(),
      retrying: z.number().int().nonnegative(),
      inFlight: z.number().int().nonnegative(),
      delivered: z.number().int().nonnegative(),
      uncertain: z.number().int().nonnegative(),
      oldestPendingAt: isoDateTimeSchema.optional(),
      lastError: z.string().optional(),
      lastErrorAt: isoDateTimeSchema.optional(),
    })
    .optional(),
  lifecycle: sparkLocalRpcDaemonLifecycleSchema,
  buildFingerprint: z.string().min(1).optional(),
  observedAt: isoDateTimeSchema,
});

export const sparkLocalRpcDaemonStopResultSchema = z.object({
  stopping: z.literal(true),
  observedAt: isoDateTimeSchema,
});

export const sparkLocalRpcDaemonRestartResultSchema = z.object({
  accepted: z.literal(true),
  state: z.literal("draining"),
  restartId: z.string().min(1),
  processInstanceId: z.string().min(1),
  processGeneration: z.string().min(1),
  targetInstanceId: z.string().min(1),
  targetGeneration: z.string().min(1),
  targetVersion: z.string().min(1).optional(),
  targetBuildFingerprint: z.string().min(1).optional(),
  requestedAt: isoDateTimeSchema,
});

const channelAdapterConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("feishu"),
    event_mode: z.literal("websocket").optional(),
    app_id: z.string().optional(),
    app_secret: z.string().optional(),
  }),
  z.object({
    type: z.literal("infoflow"),
    endpoint: z.string().optional(),
    app_key: z.string().optional(),
    app_secret: z.string().optional(),
    app_agent_id: z.string().optional(),
    ws_gateway: z.string().optional(),
    connection_mode: z.literal("websocket").optional(),
    allowed_user_ids: z.array(z.string()).optional(),
    group_policy: z.enum(["disabled", "allowlist", "open"]).optional(),
    group_trigger: z.enum(["mention", "command", "all"]).optional(),
    allowed_group_ids: z.array(z.string()).optional(),
    system_prompt: z.string().optional(),
  }),
  z.object({
    type: z.literal("qqbot"),
    app_id: z.string().optional(),
    client_secret: z.string().optional(),
    connection_mode: z.literal("websocket").optional(),
    api_environment: z.enum(["production", "sandbox"]).optional(),
    allowed_user_ids: z.array(z.string()).optional(),
    group_policy: z.enum(["disabled", "allowlist", "open"]).optional(),
    group_trigger: z.enum(["mention", "command", "all"]).optional(),
    allowed_group_ids: z.array(z.string()).optional(),
    system_prompt: z.string().optional(),
  }),
]);

export const sparkLocalRpcChannelsConfigSchema = z.object({
  adapters: z.record(z.string(), channelAdapterConfigSchema),
  routes: z.record(
    z.string(),
    z.object({
      adapter: z.string().min(1),
      recipient: z.string().min(1),
    }),
  ),
  ingress: z
    .object({
      enabled: z.boolean(),
      on_unbound: z.enum(["reject", "create"]).optional(),
    })
    .optional(),
});

export const sparkLocalRpcChannelStatusSchema = z.object({
  plane: z.literal("daemon"),
  resource: z.literal("channel"),
  workspaceId: z.string().min(1),
  configPath: z.string().min(1),
  available: z.literal(true),
  configured: z.boolean(),
  ingressEnabled: z.boolean(),
  state: z.enum(["unconfigured", "running", "stopped", "degraded"]),
  adapters: z.array(
    z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      adapterAccountIdentity: z.string().min(1).optional(),
      running: z.boolean(),
      state: z.enum(["stopped", "connecting", "connected", "reconnecting", "degraded"]),
      error: z.string().optional(),
    }),
  ),
  routes: z.array(
    z.object({
      name: z.string().min(1),
      adapter: z.string().min(1),
      recipient: z.string(),
    }),
  ),
  lastReloadedAt: isoDateTimeSchema.optional(),
  error: z.string().optional(),
  observedAt: isoDateTimeSchema,
  text: z.string(),
});

const channelImageSourceSchema = z.object({
  url: z.string().optional(),
  data: z.string().optional(),
  mediaType: z.string().optional(),
  name: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

export const sparkLocalRpcChannelNotifyInputSchema = z.object({
  workspaceId: z.string().trim().min(1),
  action: z.enum(["send", "list", "test"]),
  adapter: z.string().optional(),
  route: z.string().optional(),
  recipient: z.string().optional(),
  text: z.string().optional(),
  image: channelImageSourceSchema.optional(),
  deliveryId: z.string().min(1).optional(),
});

const channelDeliveryResultSchema = z.object({
  replaySafety: z.enum(["deduplicated", "unsafe"]),
  receipt: z
    .object({
      messageId: z.string().optional(),
      messageSequence: z.string().optional(),
      messageKey: z.string().optional(),
      timestamp: z.string().optional(),
    })
    .optional(),
});

export const sparkLocalRpcChannelNotifyResultSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    adapters: sparkLocalRpcChannelStatusSchema.shape.adapters,
    routes: z.array(
      z.object({
        name: z.string().min(1),
        adapterId: z.string().min(1),
        adapterType: z.string().min(1),
        recipient: z.string(),
      }),
    ),
  }),
  z.object({
    action: z.enum(["send", "test"]),
    adapter: z.string().min(1),
    recipient: z.string(),
    text: z.string(),
    image: z
      .object({
        source: z.enum(["url", "data"]),
        mediaType: z.string().optional(),
        name: z.string().optional(),
      })
      .optional(),
    deliveryId: z.string().min(1).optional(),
    delivery: channelDeliveryResultSchema.optional(),
    deliverySemantics: z.literal("one-shot").optional(),
  }),
]);

export const sparkLocalRpcTurnSubmitRequestSchema = sparkTurnSubmitRequestSchema.extend({
  assignment: sparkAssignmentSchema.optional(),
  messageMetadata: sparkProtocolJsonObjectSchema.optional(),
});

export const sparkLocalRpcWorkspaceProfileSchema = z.object({
  sourceKind: z.enum(["builtin", "git"]),
  ref: z.string().min(1),
  commit: z.string().min(1).optional(),
  importedAt: isoDateTimeSchema,
});

const sparkLocalRpcWorkspaceLifecycleStateSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("merged"),
    mergedIntoWorkspaceId: z.string().min(1),
    previousLocalPath: z.string().min(1),
    changedAt: isoDateTimeSchema,
  }),
  z.object({
    state: z.literal("unregistered"),
    previousLocalPath: z.string().min(1),
    changedAt: isoDateTimeSchema,
  }),
]);

export const sparkLocalRpcWorkspaceSchema = z.object({
  id: z.string().min(1),
  serverWorkspaceId: z.string().min(1).optional(),
  serverBindingId: z.string().min(1).optional(),
  hubBindingState: z.enum(["bound", "unbound"]).optional(),
  workspaceAuthorization: workspaceBrowserAuthorizationSchema.optional(),
  serverUrl: z.string(),
  localWorkspaceKey: z.string(),
  displayName: z.string(),
  localPath: z.string().min(1),
  status: runtimeWorkspaceBindingStatusSchema,
  capabilities: sparkProtocolJsonObjectSchema,
  diagnostics: sparkProtocolJsonObjectSchema,
  profile: sparkLocalRpcWorkspaceProfileSchema.optional(),
  borrowed: workspaceBorrowedStateSchema.optional(),
  workspaceClients: z.array(workspaceClientProjectionSchema).optional(),
  executor: executorClientProjectionSchema.optional(),
  sessionCount: z.number().int().nonnegative().optional(),
  lastSessionAt: isoDateTimeSchema.optional(),
  recentSessions: z
    .array(
      z.object({
        id: z.string().min(1),
        project: z.string(),
        model: z.string(),
        lastActivityAt: isoDateTimeSchema,
        state: z.string(),
      }),
    )
    .optional(),
  lifecycle: sparkLocalRpcWorkspaceLifecycleStateSchema.optional(),
  updatedAt: isoDateTimeSchema,
});

const sparkLocalRpcWorkspaceLifecycleMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("unregister"),
    workspaceId: z.string().min(1),
    dryRun: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("move"),
    workspaceId: z.string().min(1),
    localPath: z.string().min(1),
    dryRun: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("merge"),
    targetWorkspaceId: z.string().min(1),
    sourceWorkspaceIds: z.array(z.string().min(1)).optional(),
    localPath: z.string().min(1),
    allNested: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  }),
]);

const sparkLocalRpcWorkspaceLifecycleMutationResultSchema = z.object({
  action: z.enum(["unregister", "move", "merge"]),
  applied: z.boolean(),
  workspace: sparkLocalRpcWorkspaceSchema,
  sources: z.array(sparkLocalRpcWorkspaceSchema),
  previousLocalPath: z.string().min(1),
  localPath: z.string().min(1),
  changedAt: isoDateTimeSchema.optional(),
});

export const sparkLocalRpcWorkspaceRegisterRequestSchema = z.object({
  serverUrl: z.string(),
  allowInsecureHttp: z.boolean().optional(),
  localPath: z.string().min(1),
  registrationToken: z.string().min(1).optional(),
  localWorkspaceKey: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  workspaceName: z.string().min(1).optional(),
  workspaceSlug: z.string().min(1).optional(),
  profile: sparkLocalRpcWorkspaceProfileSchema.optional(),
});

export const sparkLocalRpcWorkspaceRelocateRequestSchema = z.object({
  fromServerUrl: z.string().min(1).optional(),
  toServerUrl: z.string().min(1),
});

export const sparkLocalRpcWorkspaceRelocateResultSchema = z.object({
  relocated: z.literal(true),
  instanceId: z.string().min(1),
  installationId: z.string().min(1),
  runtimeId: z.string().min(1),
  fromServerUrl: z.string().min(1),
  toServerUrl: z.string().min(1),
  webSocketUrl: z.string().min(1),
  workspaceBindingIds: z.array(z.string().min(1)),
  workspaceCount: z.number().int().nonnegative(),
  relocatedAt: isoDateTimeSchema,
});

export const sparkLocalRpcWorkspaceEnsureLocalRequestSchema = z.object({
  localPath: z.string().min(1),
  displayName: z.string().min(1).optional(),
  localWorkspaceKey: z.string().min(1).optional(),
});

export const sparkLocalRpcWorkspaceResolveSessionCwdRequestSchema = z.object({
  cwd: z.string().trim().min(1),
});

export const sparkLocalRpcWorkspaceResolveSessionCwdResultSchema = z.object({
  workspace: sparkLocalRpcWorkspaceSchema,
  cwd: z.string().min(1),
  cwdArtifactRef: z
    .string()
    .regex(/^artifact:.+/u)
    .optional(),
});

export const sparkLocalRpcWorkspaceClientSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: workspaceClientKindSchema,
  displayName: z.string().min(1).optional(),
  status: workspaceClientStatusSchema,
  attachedAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  leaseExpiresAt: isoDateTimeSchema.optional(),
  releasedAt: isoDateTimeSchema.optional(),
  sessionId: z.string().min(1).optional(),
  leaseFence: z.string().min(1).optional(),
  metadata: sparkProtocolJsonObjectSchema,
});

export const sparkLocalRpcWorkspaceClientAttachRequestSchema = z.object({
  workspaceId: z.string().min(1),
  clientId: z.string().min(1).optional(),
  kind: workspaceClientKindSchema,
  displayName: z.string().min(1).optional(),
  leaseTtlMs: z.number().int().nonnegative().optional(),
  sessionId: z.string().min(1).optional(),
  metadata: sparkProtocolJsonObjectSchema.optional(),
});

export const sparkLocalRpcWorkspaceClientHeartbeatRequestSchema = z.object({
  clientId: z.string().min(1),
  leaseTtlMs: z.number().int().nonnegative().optional(),
  leaseFence: z.string().min(1).optional(),
});

export const sparkLocalRpcWorkspaceExecutorEnsureRequestSchema =
  sparkLocalRpcWorkspaceClientAttachRequestSchema.omit({ kind: true });

export const sparkLocalRpcWorkspaceClientResultSchema = z.object({
  client: sparkLocalRpcWorkspaceClientSchema,
  workspace: sparkLocalRpcWorkspaceSchema,
  observedAt: isoDateTimeSchema,
});

export const sparkLocalRpcLeaseTransferRequestSchema = z.object({
  transferId: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceDisplayName: z.string(),
  previousServerUrl: z.string(),
  targetServerUrl: z.string(),
  humanRequestId: z.string().min(1).optional(),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});

export const sparkLocalRpcLeaseTransferSettlementSchema = z.object({
  transferId: z.string().min(1),
  decision: z.enum(["accept", "reject", "auto-authorize"]),
  source: z.enum(["hub", "tui", "cli", "timeout", "unknown"]),
  settledAt: isoDateTimeSchema,
});

export const sparkLocalRpcWorkspaceTransferPendingResultSchema = z.object({
  pending: z.array(sparkLocalRpcLeaseTransferRequestSchema),
  observedAt: isoDateTimeSchema,
});

export const sparkLocalRpcUplinkMutationResultSchema = z.object({
  serverUrl: z.string().min(1),
  parked: z.boolean(),
});

export const sparkLocalRpcUplinkPreferResultSchema = z.object({
  workspace: sparkLocalRpcWorkspaceSchema,
  previousServerUrl: z.string(),
  serverUrl: z.string().min(1),
  transfer: z
    .object({
      transferId: z.string().min(1),
      decision: z.enum(["accept", "reject", "auto-authorize"]),
      source: z.enum(["hub", "tui", "cli", "timeout", "unknown"]),
    })
    .optional(),
});

export const sparkLocalRpcUplinkStatusResultSchema = z.object({
  observedAt: isoDateTimeSchema,
  origins: z.array(
    z.object({
      serverUrl: z.string().min(1),
      parked: z.boolean(),
      desired: z.boolean(),
      runnable: z.boolean(),
      workspaceCount: z.number().int().nonnegative(),
      runtimeId: z.string().min(1).optional(),
    }),
  ),
});

export const sparkLocalRpcSessionNotificationDeliverResultSchema = z.object({
  deliveries: z.array(
    z.object({
      adapter: z.string().min(1),
      externalKey: z.string().min(1),
      adapterId: z.string().min(1).optional(),
      adapterAccountIdentity: z.string().min(1).optional(),
      status: z.enum(["pending", "delivered", "failed", "uncertain"]),
      attemptCount: z.number().int().nonnegative(),
      receipt: sparkProtocolJsonValueSchema.optional(),
      error: z.string().optional(),
    }),
  ),
});

export const sparkLocalRpcHumanInteractionListRequestSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
});

export const sparkLocalRpcHumanInteractionRespondRequestSchema = z
  .object({
    interactionRequestId: z.string().trim().min(1).optional(),
    humanRequestId: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1).optional(),
    invocationId: z.string().trim().min(1).optional(),
    respondentSessionId: z.string().trim().min(1).optional(),
    humanResponseId: prefixedIdSchema("hres").optional(),
    status: z.enum(["answered", "cancelled"]),
    provenance: sparkDirectAnswerProvenanceSchema.optional(),
    answers: sparkProtocolJsonObjectSchema.default({}),
    responseArtifactRefs: z.array(z.string().trim().min(1)).default([]),
  })
  .superRefine((request, context) => {
    if (!request.interactionRequestId && !request.humanRequestId) {
      context.addIssue({
        code: "custom",
        path: ["interactionRequestId"],
        message: "human.interaction.respond requires interactionRequestId or humanRequestId",
      });
    }
  });

const sparkLocalRpcHumanWaitSchema = z.object({
  humanRequestId: z.string().min(1),
  interactionRequestId: z.string(),
  sessionId: z.string(),
  invocationId: z.string(),
  workspaceBindingId: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  toolCallId: z.string(),
  delivery: z.enum(["blocking", "async"]),
  evidenceRequest: sparkEvidenceRequestBindingSchema.optional(),
  kind: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  questions: z.array(sparkProtocolJsonObjectSchema),
  context: sparkProtocolJsonObjectSchema,
  contextArtifactRefs: z.array(z.string()),
  respondent: sparkHumanWaitRespondentSchema.optional(),
  status: z.enum(["pending", "answered", "cancelled", "archived"]),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const sparkLocalRpcHumanWaitResponseSchema = z.object({
  humanRequestId: z.string().min(1),
  humanResponseId: z.string().min(1),
  status: z.enum(["answered", "cancelled", "archived"]),
  provenance: sparkDirectAnswerProvenanceSchema.optional(),
  answers: sparkProtocolJsonObjectSchema,
  responseArtifactRefs: z.array(z.string()),
  answerEventId: z
    .string()
    .regex(/^answer-event:.+/u)
    .optional(),
  deliveredAt: isoDateTimeSchema,
});

const sparkLocalRpcEvidenceAnswerEventSchema = sparkEvidenceAnswerEventSchema.safeExtend({
  answers: sparkProtocolJsonObjectSchema,
});

export const sparkLocalRpcHumanInteractionListResultSchema = z.object({
  waits: z.array(sparkLocalRpcHumanWaitSchema),
});

export const sparkLocalRpcHumanInteractionRespondResultSchema = z.object({
  outcome: sparkHumanInteractionDeliveryOutcomeSchema,
  retryable: z.boolean(),
  returnedToTool: z.boolean(),
  message: z.string(),
  winnerResponseId: z.string().min(1).optional(),
  wait: sparkLocalRpcHumanWaitSchema.optional(),
  response: sparkLocalRpcHumanWaitResponseSchema.optional(),
  answerEvent: sparkLocalRpcEvidenceAnswerEventSchema.optional(),
});

const workspaceIdInputSchema = z.object({ workspaceId: z.string().trim().min(1) });
const invocationIdInputSchema = sparkTurnStatusRequestSchema;
const sessionIdInputSchema = sparkSessionGetRequestSchema;
const providerNameInputSchema = z.object({ providerName: z.string().trim().min(1) });
const flowIdInputSchema = z.object({ flowId: z.string().trim().min(1) });
const workspaceIdMutationInputSchema = z.object({ id: z.string().min(1) });

const sparkLocalRpcToolExecutionBaseInputSchema = z.object({
  cwd: z.string().trim().min(1),
  toolCallId: z.string().trim().min(1),
  operationId: z.string().trim().min(1),
  params: sparkProtocolJsonObjectSchema,
  hostContext: z
    .object({
      workspaceId: z.string().trim().min(1).optional(),
      sessionSource: z.enum(["tui", "web", "channel", "daemon", "session"]).optional(),
      sessionSurface: z.enum(["local", "channel"]).optional(),
      hasUI: z.boolean().optional(),
    })
    .optional(),
});

export const sparkLocalRpcToolExecutionResultSchema = z.object({
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
  ),
  details: sparkProtocolJsonObjectSchema.optional(),
  isError: z.boolean().optional(),
});

export const sparkLocalRpcProcedureSchemas = {
  "daemon.status": {
    input: sparkLocalRpcEmptyInputSchema,
    output: sparkLocalRpcDaemonStatusResultSchema,
  },
  "daemon.stop": {
    input: sparkLocalRpcEmptyInputSchema,
    output: sparkLocalRpcDaemonStopResultSchema,
  },
  "daemon.restart": {
    input: sparkLocalRpcEmptyInputSchema,
    output: sparkLocalRpcDaemonRestartResultSchema,
  },
  "file.execute": {
    input: sparkLocalRpcToolExecutionBaseInputSchema.extend({
      tool: z.enum(["read", "write", "edit", "grep", "find"]),
    }),
    output: sparkLocalRpcToolExecutionResultSchema,
  },
  "artifact.execute": {
    input: sparkLocalRpcToolExecutionBaseInputSchema,
    output: sparkLocalRpcToolExecutionResultSchema,
  },
  "git.execute": {
    input: sparkLocalRpcToolExecutionBaseInputSchema,
    output: sparkLocalRpcToolExecutionResultSchema,
  },
  "lens.execute": {
    input: sparkLocalRpcToolExecutionBaseInputSchema,
    output: sparkLocalRpcToolExecutionResultSchema,
  },
  "channel.status": { input: workspaceIdInputSchema, output: sparkLocalRpcChannelStatusSchema },
  "channel.configure": {
    input: z.object({
      workspaceId: z.string().trim().min(1),
      config: sparkLocalRpcChannelsConfigSchema,
    }),
    output: sparkLocalRpcChannelStatusSchema,
  },
  "channel.reload": { input: workspaceIdInputSchema, output: sparkLocalRpcChannelStatusSchema },
  "channel.notify": {
    input: sparkLocalRpcChannelNotifyInputSchema,
    output: sparkLocalRpcChannelNotifyResultSchema,
  },
  "turn.submit": {
    input: sparkLocalRpcTurnSubmitRequestSchema,
    output: sparkTurnSubmitResultSchema,
  },
  "turn.status": { input: invocationIdInputSchema, output: sparkTurnStatusResultSchema },
  "turn.result": { input: invocationIdInputSchema, output: sparkTurnResultSchema },
  "turn.stream": { input: sparkTurnStreamRequestSchema, output: sparkTurnStreamPageSchema },
  "turn.cancel": { input: sparkTurnCancelRequestSchema, output: sparkTurnCancelResultSchema },
  "invocation.list": {
    input: sparkInvocationListRequestSchema,
    output: sparkInvocationListResultSchema,
  },
  "invocation.retry": {
    input: sparkInvocationRetryRequestSchema,
    output: sparkInvocationRetryResultSchema,
  },
  "invocation.retention.preview": {
    input: sparkInvocationRetentionPreviewRequestSchema,
    output: sparkInvocationRetentionPreviewResultSchema,
  },
  "invocation.retention.apply": {
    input: sparkInvocationRetentionApplyRequestSchema,
    output: sparkInvocationRetentionApplyResultSchema,
  },
  "usage.summary": {
    input: sparkTokenUsageSummaryRequestSchema,
    output: sparkTokenUsageAggregateSchema,
  },
  "usage.persistence": {
    input: sparkTokenUsagePersistenceRequestSchema,
    output: sparkTokenUsageByPersistenceSchema,
  },
  "usage.backfill": {
    input: sparkLegacyTokenUsageBackfillRequestSchema,
    output: sparkLegacyTokenUsageBackfillResultSchema,
  },
  "repro.start": {
    input: sparkReproStartRequestSchema,
    output: sparkReproMutationResultSchema,
  },
  "repro.status": {
    input: sparkReproStatusRequestSchema,
    output: sparkReproStatusResultSchema,
  },
  "repro.stop": {
    input: sparkReproStopRequestSchema,
    output: sparkReproMutationResultSchema,
  },
  "loop.start": { input: sparkLoopStartRequestSchema, output: sparkLoopMutationResultSchema },
  "loop.status": { input: sparkLoopStatusRequestSchema, output: sparkLoopListResultSchema },
  "loop.stop": {
    input: sparkLoopMutationRequestSchema,
    output: sparkLoopMutationResultSchema,
  },
  "loop.restart": {
    input: sparkLoopMutationRequestSchema,
    output: sparkLoopMutationResultSchema,
  },
  "loop.wake": { input: sparkLoopWakeRequestSchema, output: sparkLoopMutationResultSchema },
  "loop.schedule": {
    input: sparkLoopScheduleRequestSchema,
    output: sparkLoopMutationResultSchema,
  },
  "workspace.list": {
    input: z.object({ includeInactive: z.boolean().optional() }),
    output: z.object({
      workspaces: z.array(sparkLocalRpcWorkspaceSchema),
      observedAt: isoDateTimeSchema,
    }),
  },
  "workspace.register": {
    input: sparkLocalRpcWorkspaceRegisterRequestSchema,
    output: sparkLocalRpcWorkspaceSchema,
  },
  "workspace.relocate": {
    input: sparkLocalRpcWorkspaceRelocateRequestSchema,
    output: sparkLocalRpcWorkspaceRelocateResultSchema,
  },
  // Compatibility wire name: lookup/re-attach only. It must never create a workspace.
  "workspace.ensure-local": {
    input: sparkLocalRpcWorkspaceEnsureLocalRequestSchema,
    output: sparkLocalRpcWorkspaceSchema,
  },
  "workspace.resolve-session-cwd": {
    input: sparkLocalRpcWorkspaceResolveSessionCwdRequestSchema,
    output: sparkLocalRpcWorkspaceResolveSessionCwdResultSchema,
  },
  "workspace.attach": {
    input: workspaceIdMutationInputSchema,
    output: sparkLocalRpcWorkspaceSchema,
  },
  "workspace.stop": { input: workspaceIdMutationInputSchema, output: sparkLocalRpcWorkspaceSchema },
  "workspace.lifecycle": {
    input: sparkLocalRpcWorkspaceLifecycleMutationSchema,
    output: sparkLocalRpcWorkspaceLifecycleMutationResultSchema,
  },
  "workspace.client.attach": {
    input: sparkLocalRpcWorkspaceClientAttachRequestSchema,
    output: sparkLocalRpcWorkspaceClientResultSchema,
  },
  "workspace.client.heartbeat": {
    input: sparkLocalRpcWorkspaceClientHeartbeatRequestSchema,
    output: sparkLocalRpcWorkspaceClientResultSchema,
  },
  "workspace.client.release": {
    input: z.object({ clientId: z.string().min(1), leaseFence: z.string().min(1).optional() }),
    output: sparkLocalRpcWorkspaceClientResultSchema,
  },
  "workspace.executor.ensure": {
    input: sparkLocalRpcWorkspaceExecutorEnsureRequestSchema,
    output: sparkLocalRpcWorkspaceClientResultSchema,
  },
  "delegation.execute": {
    input: workspaceDelegationExecuteRequestSchema,
    output: workspaceDelegationExecuteResultSchema,
  },
  "task.claim.acquire": {
    input: sparkTaskClaimAcquireRequestSchema,
    output: sparkTaskClaimMutationResultSchema,
  },
  "task.claim.release": {
    input: sparkTaskClaimReleaseRequestSchema,
    output: sparkTaskClaimMutationResultSchema,
  },
  "task.claim.recover": {
    input: sparkTaskClaimRecoverRequestSchema,
    output: sparkTaskClaimMutationResultSchema,
  },
  "workspace.transfer.pending": {
    input: z.object({ workspaceId: z.string().min(1).optional() }).default({}),
    output: sparkLocalRpcWorkspaceTransferPendingResultSchema,
  },
  "workspace.transfer.respond": {
    input: z.object({
      transferId: z.string().min(1),
      decision: z.enum(["accept", "reject"]),
      source: z.enum(["tui", "cli"]).optional(),
    }),
    output: sparkLocalRpcLeaseTransferSettlementSchema,
  },
  "uplink.park": {
    input: z.object({ serverUrl: z.string().trim().min(1) }),
    output: sparkLocalRpcUplinkMutationResultSchema,
  },
  "uplink.unpark": {
    input: z.object({ serverUrl: z.string().trim().min(1) }),
    output: sparkLocalRpcUplinkMutationResultSchema,
  },
  "uplink.prefer": {
    input: z.object({
      workspace: z.string().trim().min(1),
      serverUrl: z.string().trim().min(1),
      force: z.boolean().optional(),
    }),
    output: sparkLocalRpcUplinkPreferResultSchema,
  },
  "uplink.status": {
    input: sparkLocalRpcEmptyInputSchema,
    output: sparkLocalRpcUplinkStatusResultSchema,
  },
  "session.list": {
    input: sparkSessionListRequestSchema,
    output: z.array(sparkSessionProjectionSchema),
  },
  "session.get": { input: sessionIdInputSchema, output: sparkSessionProjectionSchema },
  "session.lookup": { input: sessionIdInputSchema, output: sparkSessionPeerProjectionSchema },
  "session.snapshot": {
    input: sparkSessionSnapshotRequestSchema,
    output: z.lazy(() => sparkSessionViewSchema),
  },
  "session.prompt-history": {
    input: sparkSessionPromptHistoryRequestSchema,
    output: z.lazy(() => sparkSessionPromptHistorySchema),
  },
  "session.retry-target": {
    input: sparkSessionRetryTargetRequestSchema,
    output: sparkSessionRetryTargetSchema,
  },
  "session.create": {
    input: sparkSessionCreateRequestSchema,
    output: sparkSessionProjectionSchema,
  },
  "session.spawn": {
    input: sparkSessionSpawnRequestSchema,
    output: sparkSessionProjectionSchema,
  },
  "session.fork": {
    input: sparkSessionForkRequestSchema,
    output: sparkSessionProjectionSchema,
  },
  "session.bind": {
    input: sparkSessionBindRequestSchema,
    output: sparkSessionProjectionSchema,
  },
  "session.unbind": {
    input: sparkSessionUnbindRequestSchema,
    output: sparkSessionProjectionSchema,
  },
  "session.archive": {
    input: sparkSessionArchiveRequestSchema,
    output: sparkSessionProjectionSchema,
  },
  "session.restore": { input: sessionIdInputSchema, output: sparkSessionProjectionSchema },
  "session.close": {
    input: sparkSessionCloseRequestSchema,
    output: sparkSessionProjectionSchema,
  },
  "session.compact": {
    input: sparkSessionCompactRequestSchema,
    output: sparkTurnSubmitResultSchema,
  },
  "session.send": { input: sparkSessionSendRequestSchema, output: sparkSessionSendResultSchema },
  "session.inbox": { input: sparkSessionInboxRequestSchema, output: sparkSessionInboxResultSchema },
  "session.mail.read": {
    input: sparkSessionMailMutationRequestSchema,
    output: sparkSessionMailMutationResultSchema,
  },
  "session.mail.ack": {
    input: sparkSessionMailMutationRequestSchema,
    output: sparkSessionMailMutationResultSchema,
  },
  "session.notification.deliver": {
    input: z.object({
      sessionId: z.string().min(1),
      messageId: z.string().min(1),
    }),
    output: sparkLocalRpcSessionNotificationDeliverResultSchema,
  },
  "session.model.set": {
    input: sparkSessionSetModelRequestSchema,
    output: sparkSessionProjectionSchema,
  },
  "session.mode.set": {
    input: sparkSessionSetModeRequestSchema,
    output: sparkSessionModeResultSchema,
  },
  "session.thinking.set": {
    input: sparkSessionSetThinkingRequestSchema,
    output: sparkSessionProjectionSchema,
  },
  "side-thread.ensure": {
    input: sparkSideThreadEnsureRequestSchema,
    output: sparkSideThreadSnapshotSchema,
  },
  "side-thread.snapshot": {
    input: sparkSideThreadSnapshotRequestSchema,
    output: sparkSideThreadSnapshotSchema,
  },
  "side-thread.submit": {
    input: sparkSideThreadSubmitRequestSchema,
    output: sparkSideThreadSubmitResultSchema,
  },
  "side-thread.reset": {
    input: sparkSideThreadResetRequestSchema,
    output: sparkSideThreadSnapshotSchema,
  },
  "side-thread.configure": {
    input: sparkSideThreadConfigureRequestSchema,
    output: sparkSideThreadSnapshotSchema,
  },
  "side-thread.handoff": {
    input: sparkSideThreadHandoffRequestSchema,
    output: sparkSideThreadHandoffResultSchema,
  },
  "model.catalog": {
    input: z.object({ sessionId: z.string().min(1).optional() }).default({}),
    output: sparkModelControlSnapshotSchema,
  },
  "model.default.set": {
    input: sparkDefaultModelSetRequestSchema,
    output: sparkModelControlSnapshotSchema,
  },
  "model.enabled.set": {
    input: sparkEnabledModelsSetRequestSchema,
    output: sparkModelControlSnapshotSchema,
  },
  "provider.auth.api-key.set": {
    input: z.object({
      providerName: z.string().trim().min(1),
      apiKey: z.string().min(1),
    }),
    output: sparkModelControlSnapshotSchema,
  },
  "provider.auth.import.pi": {
    input: sparkPiAuthImportRequestSchema,
    output: sparkAuthImportReportSchema,
  },
  "provider.auth.logout": {
    input: providerNameInputSchema,
    output: z.object({
      removed: z.boolean(),
      snapshot: sparkModelControlSnapshotSchema,
    }),
  },
  "provider.auth.login.start": { input: providerNameInputSchema, output: sparkAuthFlowSchema },
  "provider.auth.login.status": { input: flowIdInputSchema, output: sparkAuthFlowSchema },
  "provider.auth.login.respond": {
    input: z.object({
      flowId: z.string().trim().min(1),
      promptId: z.string().trim().min(1),
      value: z.string(),
    }),
    output: sparkAuthFlowSchema,
  },
  "provider.auth.login.cancel": { input: flowIdInputSchema, output: sparkAuthFlowSchema },
  "human.interaction.list": {
    input: sparkLocalRpcHumanInteractionListRequestSchema,
    output: sparkLocalRpcHumanInteractionListResultSchema,
  },
  "human.interaction.respond": {
    input: sparkLocalRpcHumanInteractionRespondRequestSchema,
    output: sparkLocalRpcHumanInteractionRespondResultSchema,
  },
} as const satisfies Record<SparkLocalRpcMethod, { input: z.ZodType; output: z.ZodType }>;

function camelCaseRpcPathSegment(segment: string): string {
  return segment.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

export const sparkLocalRpcOrpcMethodPaths = Object.fromEntries(
  (Object.keys(sparkLocalRpcProcedureSchemas) as SparkLocalRpcMethod[]).map((method) => [
    method,
    method.split(".").map(camelCaseRpcPathSegment),
  ]),
) as unknown as Record<SparkLocalRpcMethod, readonly string[]>;

export const sparkLocalRpcOrpcLiveMethods = Object.keys(
  sparkLocalRpcProcedureSchemas,
) as SparkLocalRpcMethod[];

/** New procedures intentionally excluded from the frozen 0.1.x NDJSON surface. */
export const sparkLocalRpcOrpcOnlyMethods = [
  "session.prompt-history",
  "session.retry-target",
] as const satisfies readonly SparkLocalRpcMethod[];

export type SparkLocalRpcInput<M extends SparkLocalRpcMethod> = z.input<
  (typeof sparkLocalRpcProcedureSchemas)[M]["input"]
>;
export type SparkLocalRpcParsedInput<M extends SparkLocalRpcMethod> = z.output<
  (typeof sparkLocalRpcProcedureSchemas)[M]["input"]
>;
export type SparkLocalRpcOutput<M extends SparkLocalRpcMethod> = z.output<
  (typeof sparkLocalRpcProcedureSchemas)[M]["output"]
>;

function procedure<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TErrors extends ErrorMap = typeof sparkLocalRpcReadinessOrpcErrors,
>(
  method: "GET" | "POST",
  path: `/${string}`,
  schemas: { input: TInput; output: TOutput },
  errors: TErrors = sparkLocalRpcReadinessOrpcErrors as unknown as TErrors,
) {
  return oc.route({ method, path }).input(schemas.input).output(schemas.output).errors(errors);
}

function sideThreadProcedure<TInput extends z.ZodType, TOutput extends z.ZodType>(
  method: "GET" | "POST",
  path: `/${string}`,
  schemas: { input: TInput; output: TOutput },
) {
  return procedure(method, path, schemas, sparkLocalRpcReadinessSideThreadOrpcErrors);
}

const p = sparkLocalRpcProcedureSchemas;

export const sparkLocalRpcOrpcContract = {
  daemon: {
    status: procedure("GET", "/daemon/status", p["daemon.status"], sparkLocalRpcNoOrpcErrors),
    stop: procedure("POST", "/daemon/stop", p["daemon.stop"], sparkLocalRpcNoOrpcErrors),
    restart: procedure(
      "POST",
      "/daemon/restart",
      p["daemon.restart"],
      sparkLocalRpcReadinessDaemonOrpcErrors,
    ),
  },
  file: {
    execute: procedure("POST", "/file/execute", p["file.execute"]),
  },
  artifact: {
    execute: procedure("POST", "/artifact/execute", p["artifact.execute"]),
  },
  git: {
    execute: procedure("POST", "/git/execute", p["git.execute"]),
  },
  lens: {
    execute: procedure("POST", "/lens/execute", p["lens.execute"]),
  },
  channel: {
    status: procedure(
      "GET",
      "/channel/status",
      p["channel.status"],
      sparkLocalRpcChannelStatusOrpcErrors,
    ),
    configure: procedure(
      "POST",
      "/channel/configure",
      p["channel.configure"],
      sparkLocalRpcReadinessChannelOrpcErrors,
    ),
    reload: procedure(
      "POST",
      "/channel/reload",
      p["channel.reload"],
      sparkLocalRpcReadinessChannelOrpcErrors,
    ),
    notify: procedure(
      "POST",
      "/channel/notify",
      p["channel.notify"],
      sparkLocalRpcChannelNotifyOrpcErrors,
    ),
  },
  turn: {
    submit: procedure("POST", "/turn/submit", p["turn.submit"], sparkLocalRpcTurnSubmitOrpcErrors),
    status: procedure(
      "GET",
      "/turn/status",
      p["turn.status"],
      sparkLocalRpcSessionInvocationNotFoundOrpcErrors,
    ),
    result: procedure("GET", "/turn/result", p["turn.result"], sparkLocalRpcTurnResultOrpcErrors),
    stream: procedure("GET", "/turn/stream", p["turn.stream"], sparkLocalRpcTurnStreamOrpcErrors),
    cancel: procedure(
      "POST",
      "/turn/cancel",
      p["turn.cancel"],
      sparkLocalRpcSessionInvocationNotFoundOrpcErrors,
    ),
  },
  invocation: {
    list: procedure("GET", "/invocation/list", p["invocation.list"], sparkLocalRpcNoOrpcErrors),
    retry: procedure(
      "POST",
      "/invocation/retry",
      p["invocation.retry"],
      sparkLocalRpcReadinessSessionInvocationRetryOrpcErrors,
    ),
    retention: {
      preview: procedure("GET", "/invocation/retention/preview", p["invocation.retention.preview"]),
      apply: procedure(
        "POST",
        "/invocation/retention/apply",
        p["invocation.retention.apply"],
        sparkLocalRpcNoOrpcErrors,
      ),
    },
  },
  usage: {
    summary: procedure("GET", "/usage/summary", p["usage.summary"], sparkLocalRpcNoOrpcErrors),
    persistence: procedure(
      "GET",
      "/usage/persistence",
      p["usage.persistence"],
      sparkLocalRpcNoOrpcErrors,
    ),
    backfill: procedure("POST", "/usage/backfill", p["usage.backfill"], sparkLocalRpcNoOrpcErrors),
  },
  repro: {
    start: procedure("POST", "/repro/start", p["repro.start"], sparkLocalRpcReadinessOrpcErrors),
    status: procedure("GET", "/repro/status", p["repro.status"], sparkLocalRpcReadinessOrpcErrors),
    stop: procedure("POST", "/repro/stop", p["repro.stop"], sparkLocalRpcReadinessOrpcErrors),
  },
  loop: {
    start: procedure(
      "POST",
      "/loop/start",
      p["loop.start"],
      sparkLocalRpcReadinessLoopStartOrpcErrors,
    ),
    status: procedure("GET", "/loop/status", p["loop.status"], sparkLocalRpcReadinessOrpcErrors),
    stop: procedure(
      "POST",
      "/loop/stop",
      p["loop.stop"],
      sparkLocalRpcReadinessLoopMutationOrpcErrors,
    ),
    restart: procedure(
      "POST",
      "/loop/restart",
      p["loop.restart"],
      sparkLocalRpcReadinessLoopRestartOrpcErrors,
    ),
    wake: procedure(
      "POST",
      "/loop/wake",
      p["loop.wake"],
      sparkLocalRpcReadinessLoopMutationOrpcErrors,
    ),
    schedule: procedure(
      "POST",
      "/loop/schedule",
      p["loop.schedule"],
      sparkLocalRpcReadinessLoopScheduleOrpcErrors,
    ),
  },
  workspace: {
    list: procedure(
      "GET",
      "/workspace/list",
      p["workspace.list"],
      sparkLocalRpcReadinessOrpcErrors,
    ),
    register: procedure(
      "POST",
      "/workspace/register",
      p["workspace.register"],
      sparkLocalRpcWorkspaceRegisterOrpcErrors,
    ),
    relocate: procedure(
      "POST",
      "/workspace/relocate",
      p["workspace.relocate"],
      sparkLocalRpcWorkspaceRelocateOrpcErrors,
    ),
    ensureLocal: procedure(
      "POST",
      "/workspace/ensure-local",
      p["workspace.ensure-local"],
      sparkLocalRpcWorkspaceEnsureOrpcErrors,
    ),
    resolveSessionCwd: procedure(
      "POST",
      "/workspace/resolve-session-cwd",
      p["workspace.resolve-session-cwd"],
      sparkLocalRpcWorkspaceEnsureOrpcErrors,
    ),
    attach: procedure(
      "POST",
      "/workspace/attach",
      p["workspace.attach"],
      sparkLocalRpcWorkspaceMutationOrpcErrors,
    ),
    stop: procedure(
      "POST",
      "/workspace/stop",
      p["workspace.stop"],
      sparkLocalRpcWorkspaceMutationOrpcErrors,
    ),
    lifecycle: procedure(
      "POST",
      "/workspace/lifecycle",
      p["workspace.lifecycle"],
      sparkLocalRpcWorkspaceLifecycleOrpcErrors,
    ),
    client: {
      attach: procedure(
        "POST",
        "/workspace/client/attach",
        p["workspace.client.attach"],
        sparkLocalRpcWorkspaceClientAttachOrpcErrors,
      ),
      heartbeat: procedure(
        "POST",
        "/workspace/client/heartbeat",
        p["workspace.client.heartbeat"],
        sparkLocalRpcWorkspaceClientMutationOrpcErrors,
      ),
      release: procedure(
        "POST",
        "/workspace/client/release",
        p["workspace.client.release"],
        sparkLocalRpcWorkspaceClientMutationOrpcErrors,
      ),
    },
    executor: {
      ensure: procedure(
        "POST",
        "/workspace/executor/ensure",
        p["workspace.executor.ensure"],
        sparkLocalRpcWorkspaceClientAttachOrpcErrors,
      ),
    },
    transfer: {
      pending: procedure(
        "GET",
        "/workspace/transfer/pending",
        p["workspace.transfer.pending"],
        sparkLocalRpcWorkspaceTransferOrpcErrors,
      ),
      respond: procedure(
        "POST",
        "/workspace/transfer/respond",
        p["workspace.transfer.respond"],
        sparkLocalRpcWorkspaceTransferOrpcErrors,
      ),
    },
  },
  delegation: {
    execute: procedure(
      "POST",
      "/delegation/execute",
      p["delegation.execute"],
      sparkLocalRpcDelegationOrpcErrors,
    ),
  },
  task: {
    claim: {
      acquire: procedure(
        "POST",
        "/task/claim/acquire",
        p["task.claim.acquire"],
        sparkLocalRpcReadinessTaskClaimOrpcErrors,
      ),
      release: procedure(
        "POST",
        "/task/claim/release",
        p["task.claim.release"],
        sparkLocalRpcReadinessTaskClaimOrpcErrors,
      ),
      recover: procedure(
        "POST",
        "/task/claim/recover",
        p["task.claim.recover"],
        sparkLocalRpcReadinessTaskClaimOrpcErrors,
      ),
    },
  },
  uplink: {
    park: procedure("POST", "/uplink/park", p["uplink.park"], sparkLocalRpcUplinkProfileOrpcErrors),
    unpark: procedure(
      "POST",
      "/uplink/unpark",
      p["uplink.unpark"],
      sparkLocalRpcUplinkProfileOrpcErrors,
    ),
    prefer: procedure(
      "POST",
      "/uplink/prefer",
      p["uplink.prefer"],
      sparkLocalRpcUplinkPreferOrpcErrors,
    ),
    status: procedure(
      "GET",
      "/uplink/status",
      p["uplink.status"],
      sparkLocalRpcReadinessOrpcErrors,
    ),
  },
  session: {
    list: procedure("GET", "/session/list", p["session.list"], sparkLocalRpcSessionListOrpcErrors),
    get: procedure("GET", "/session/get", p["session.get"], sparkLocalRpcSessionGetOrpcErrors),
    lookup: procedure(
      "GET",
      "/session/lookup",
      p["session.lookup"],
      sparkLocalRpcSessionGetOrpcErrors,
    ),
    snapshot: procedure(
      "GET",
      "/session/snapshot",
      p["session.snapshot"],
      sparkLocalRpcSessionSnapshotOrpcErrors,
    ),
    promptHistory: procedure(
      "GET",
      "/session/prompt-history",
      p["session.prompt-history"],
      sparkLocalRpcSessionPromptHistoryOrpcErrors,
    ),
    retryTarget: procedure(
      "GET",
      "/session/retry-target",
      p["session.retry-target"],
      sparkLocalRpcSessionGetOrpcErrors,
    ),
    create: procedure(
      "POST",
      "/session/create",
      p["session.create"],
      sparkLocalRpcSessionCreateOrpcErrors,
    ),
    spawn: procedure(
      "POST",
      "/session/spawn",
      p["session.spawn"],
      sparkLocalRpcManagedChildSessionOrpcErrors,
    ),
    fork: procedure(
      "POST",
      "/session/fork",
      p["session.fork"],
      sparkLocalRpcManagedChildSessionOrpcErrors,
    ),
    bind: procedure("POST", "/session/bind", p["session.bind"], sparkLocalRpcSessionBindOrpcErrors),
    unbind: procedure(
      "POST",
      "/session/unbind",
      p["session.unbind"],
      sparkLocalRpcSessionUnbindOrpcErrors,
    ),
    archive: procedure(
      "POST",
      "/session/archive",
      p["session.archive"],
      sparkLocalRpcSessionArchiveOrpcErrors,
    ),
    restore: procedure(
      "POST",
      "/session/restore",
      p["session.restore"],
      sparkLocalRpcSessionArchiveOrpcErrors,
    ),
    close: procedure(
      "POST",
      "/session/close",
      p["session.close"],
      sparkLocalRpcSessionArchiveOrpcErrors,
    ),
    compact: procedure(
      "POST",
      "/session/compact",
      p["session.compact"],
      sparkLocalRpcSessionCompactOrpcErrors,
    ),
    send: procedure("POST", "/session/send", p["session.send"], sparkLocalRpcSessionSendOrpcErrors),
    inbox: procedure(
      "GET",
      "/session/inbox",
      p["session.inbox"],
      sparkLocalRpcSessionInboxOrpcErrors,
    ),
    mail: {
      read: procedure(
        "POST",
        "/session/mail/read",
        p["session.mail.read"],
        sparkLocalRpcSessionMailMutationOrpcErrors,
      ),
      ack: procedure(
        "POST",
        "/session/mail/ack",
        p["session.mail.ack"],
        sparkLocalRpcSessionMailMutationOrpcErrors,
      ),
    },
    notification: {
      deliver: procedure(
        "POST",
        "/session/notification/deliver",
        p["session.notification.deliver"],
        sparkLocalRpcReadinessSessionChannelOrpcErrors,
      ),
    },
    model: {
      set: procedure(
        "POST",
        "/session/model/set",
        p["session.model.set"],
        sparkLocalRpcReadinessSessionModelOrpcErrors,
      ),
    },
    mode: {
      set: procedure(
        "POST",
        "/session/mode/set",
        p["session.mode.set"],
        sparkLocalRpcReadinessSessionModelOrpcErrors,
      ),
    },
    thinking: {
      set: procedure(
        "POST",
        "/session/thinking/set",
        p["session.thinking.set"],
        sparkLocalRpcReadinessSessionModelOrpcErrors,
      ),
    },
  },
  sideThread: {
    ensure: sideThreadProcedure("POST", "/side-thread/ensure", p["side-thread.ensure"]),
    snapshot: sideThreadProcedure("GET", "/side-thread/snapshot", p["side-thread.snapshot"]),
    submit: sideThreadProcedure("POST", "/side-thread/submit", p["side-thread.submit"]),
    reset: sideThreadProcedure("POST", "/side-thread/reset", p["side-thread.reset"]),
    configure: sideThreadProcedure("POST", "/side-thread/configure", p["side-thread.configure"]),
    handoff: sideThreadProcedure("POST", "/side-thread/handoff", p["side-thread.handoff"]),
  },
  model: {
    catalog: procedure(
      "GET",
      "/model/catalog",
      p["model.catalog"],
      sparkLocalRpcModelCatalogOrpcErrors,
    ),
    default: {
      set: procedure(
        "POST",
        "/model/default/set",
        p["model.default.set"],
        sparkLocalRpcModelSelectionOrpcErrors,
      ),
    },
    enabled: {
      set: procedure(
        "POST",
        "/model/enabled/set",
        p["model.enabled.set"],
        sparkLocalRpcEnabledModelsSetOrpcErrors,
      ),
    },
  },
  provider: {
    auth: {
      apiKey: {
        set: procedure(
          "POST",
          "/provider/auth/api-key/set",
          p["provider.auth.api-key.set"],
          sparkLocalRpcProviderApiKeyOrpcErrors,
        ),
      },
      import: {
        pi: procedure(
          "POST",
          "/provider/auth/import/pi",
          p["provider.auth.import.pi"],
          sparkLocalRpcReadinessModelOrpcErrors,
        ),
      },
      logout: procedure(
        "POST",
        "/provider/auth/logout",
        p["provider.auth.logout"],
        sparkLocalRpcReadinessModelOrpcErrors,
      ),
      login: {
        start: procedure(
          "POST",
          "/provider/auth/login/start",
          p["provider.auth.login.start"],
          sparkLocalRpcProviderOAuthStartOrpcErrors,
        ),
        status: procedure(
          "GET",
          "/provider/auth/login/status",
          p["provider.auth.login.status"],
          sparkLocalRpcProviderOAuthStatusOrpcErrors,
        ),
        respond: procedure(
          "POST",
          "/provider/auth/login/respond",
          p["provider.auth.login.respond"],
          sparkLocalRpcProviderOAuthRespondOrpcErrors,
        ),
        cancel: procedure(
          "POST",
          "/provider/auth/login/cancel",
          p["provider.auth.login.cancel"],
          sparkLocalRpcProviderOAuthStatusOrpcErrors,
        ),
      },
    },
  },
  human: {
    interaction: {
      list: procedure(
        "GET",
        "/human/interaction/list",
        p["human.interaction.list"],
        sparkLocalRpcHumanOrpcErrors,
      ),
      respond: procedure(
        "POST",
        "/human/interaction/respond",
        p["human.interaction.respond"],
        sparkLocalRpcHumanOrpcErrors,
      ),
    },
  },
} as const;

export type SparkLocalRpcOrpcContract = typeof sparkLocalRpcOrpcContract;
export type SparkLocalRpcOrpcClient = ContractRouterClient<SparkLocalRpcOrpcContract>;

export function isSparkLocalRpcOrpcErrorCodeForMethod(
  method: SparkLocalRpcMethod,
  value: unknown,
): value is SparkLocalRpcOrpcErrorCode {
  if (!isSparkLocalRpcOrpcErrorCode(value)) return false;
  let cursor: unknown = sparkLocalRpcOrpcContract;
  for (const segment of sparkLocalRpcOrpcMethodPaths[method]) {
    if (!cursor || typeof cursor !== "object") return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (!cursor || typeof cursor !== "object" || !("~orpc" in cursor)) return false;
  const definition = (cursor as { "~orpc"?: { errorMap?: Record<string, unknown> } })["~orpc"];
  return Boolean(definition?.errorMap && value in definition.errorMap);
}
