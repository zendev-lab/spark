/**
 * Cue execution client and host-neutral operation runtime.
 *
 * Atomic execution tools organized by the three category objects:
 *
 *   Execution:
 *     cue_exec / cue_run / cue_script / script_run / script_eval
 *   Executions:
 *     cue_jobs
 *   Schedules:
 *     cue_schedule
 *   System:
 *     cue_scope / cue_history
 */

export {
  inspectCueCommandContract,
  requireCueCommandContract,
  renderCueCommandFailure,
  runCueCommand,
} from "./command-contract.ts";
export type {
  CueCommandContract,
  CueCommandInspection,
  CueCommandInspectionOptions,
  CueCommandInstallationStatus,
  CueCommandRunner,
  CueCommandSpec,
  CueProcessResult,
} from "./command-contract.ts";

export {
  CueClient,
  CueError,
  CueTransportError,
  cueOperationId,
  cueOperationStep,
  defaultSocketPath,
  isRetryableCueTransportError,
  resolveCueTransport,
} from "./client/cue-client.ts";
export type {
  CueOperationKey,
  CueResolvedTransport,
  CueSessionOptions,
  ExecutionSummary,
  ExecutionTextOutput,
  ExecutionResult,
  OutputEncoding,
  ResourceNeeds,
  SpawnAdapterHandle,
  ScriptResult,
  StartExecutionResult,
} from "./client/cue-client.ts";

export {
  __resetForTests as __resetVersionCheckForTests,
  checkAndWarn as checkCuedVersionAndWarn,
  classifyDaemonVersion,
  compareSemver,
  defaultCuedVersionCachePath,
  fetchLatestRelease,
  renderWarning as renderCuedVersionWarning,
} from "./version-check.ts";
export type { DaemonVersion, VersionCheckOptions, VersionVerdict } from "./version-check.ts";
