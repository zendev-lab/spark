import {
  SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
  SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
  type SparkInvocationStore,
} from "../store/invocations.ts";
import { ExecutionAttemptStore, type ExecutionAttemptRecord } from "../execution/state.ts";
import { validateSparkDaemonTask } from "./types.ts";

/** Triggers that share one durable execution recovery path. */
export type ExecutionReconcileTrigger =
  | "planned_shutdown"
  | "daemon_crash"
  | "launchagent_handoff"
  | "machine_restart"
  | "transport_detach"
  | "periodic_tick"
  | "startup";

export type ExecutionReconcileTransition =
  | "pause_and_requeue"
  | "crash_and_replace"
  | "requeue_invocation"
  | "fail_interrupted"
  | "skip_terminal"
  | "skip_stale_generation"
  | "noop";

export interface ExecutionReconcileAttemptResult {
  invocationId: string;
  attemptEpoch: number;
  previousStatus: ExecutionAttemptRecord["status"];
  transition: ExecutionReconcileTransition;
  nextStatus?: ExecutionAttemptRecord["status"];
  nextAttemptEpoch?: number;
  reason: string;
}

export interface ExecutionReconcileResult {
  trigger: ExecutionReconcileTrigger;
  daemonGeneration: number;
  observedAt: string;
  attemptCount: number;
  transitionCount: number;
  leaseCount: number;
  attempts: ExecutionReconcileAttemptResult[];
  invocationRequeues: number;
  invocationFailures: number;
}

export interface ReconcileExecutionStateInput {
  invocationStore: SparkInvocationStore;
  attemptStore: ExecutionAttemptStore;
  /** Current successor daemon generation; must own all writes. */
  daemonGeneration: number;
  trigger: ExecutionReconcileTrigger;
  now?: string;
}

/**
 * Single durable reconciler for non-terminal execution after shutdown, crash,
 * LaunchAgent handoff, machine restart, or periodic ticks.
 *
 * Contract:
 * - planned stop / transport detach → pause semantics (requeue for resume)
 * - crash / handoff / machine restart / startup → recover interrupted work
 * - only the current daemon generation may write (generation fencing)
 * - idempotent: second call with the same generation is a no-op when clean
 */
export function reconcileExecutionState(
  input: ReconcileExecutionStateInput,
): ExecutionReconcileResult {
  const now = input.now ?? new Date().toISOString();
  const pauseSemantics =
    input.trigger === "planned_shutdown" || input.trigger === "transport_detach";
  // Periodic ticks only reclaim work left by an older generation. Live same-
  // generation accepted/running attempts are owned by the active process.
  const recoverLiveOwnedAttempts = input.trigger !== "periodic_tick";
  const recoverRunningInvocations = input.trigger !== "periodic_tick";
  const reason = reconcileReason(input.trigger);

  const liveAttempts = input.attemptStore.listNonTerminalAttempts();
  const attempts: ExecutionReconcileAttemptResult[] = [];
  let transitionCount = 0;
  let leaseCount = 0;

  for (const attempt of liveAttempts) {
    if (attempt.daemonGeneration > input.daemonGeneration) {
      attempts.push({
        invocationId: attempt.invocationId,
        attemptEpoch: attempt.attemptEpoch,
        previousStatus: attempt.status,
        transition: "skip_stale_generation",
        reason: "newer_generation_owns_attempt",
      });
      continue;
    }

    if (attempt.status === "queued") {
      // Transfer ownership of pre-accepted work to the successor generation.
      if (attempt.daemonGeneration !== input.daemonGeneration) {
        const transferred = input.attemptStore.begin(
          attempt.invocationId,
          input.daemonGeneration,
          attempt.correlationId,
          now,
        );
        attempts.push({
          invocationId: attempt.invocationId,
          attemptEpoch: attempt.attemptEpoch,
          previousStatus: attempt.status,
          transition: "crash_and_replace",
          nextStatus: transferred.status,
          nextAttemptEpoch: transferred.attemptEpoch,
          reason,
        });
        transitionCount += 1;
        leaseCount += 1;
      } else {
        attempts.push({
          invocationId: attempt.invocationId,
          attemptEpoch: attempt.attemptEpoch,
          previousStatus: attempt.status,
          transition: "noop",
          nextStatus: attempt.status,
          reason: "already_owned",
        });
      }
      continue;
    }

    // accepted | running
    if (attempt.daemonGeneration === input.daemonGeneration && !recoverLiveOwnedAttempts) {
      attempts.push({
        invocationId: attempt.invocationId,
        attemptEpoch: attempt.attemptEpoch,
        previousStatus: attempt.status,
        transition: "noop",
        nextStatus: attempt.status,
        reason: "live_same_generation",
      });
      continue;
    }

    // Crash and replace under the successor generation (or pause on planned stop).
    const crashed = input.attemptStore.crash(
      attempt,
      pauseSemantics ? "planned_shutdown_pause" : "daemon_generation_replaced",
      now,
      input.daemonGeneration,
    );
    attempts.push({
      invocationId: attempt.invocationId,
      attemptEpoch: attempt.attemptEpoch,
      previousStatus: attempt.status,
      transition: pauseSemantics ? "pause_and_requeue" : "crash_and_replace",
      nextStatus: crashed.replacement?.status ?? crashed.crashed.status,
      nextAttemptEpoch: crashed.replacement?.attemptEpoch,
      reason,
    });
    transitionCount += 1;
    if (crashed.replacement) leaseCount += 1;
  }

  // Invocation-level recovery is independent of the in-memory active-process
  // registry. Skip it on periodic ticks so live same-generation work remains
  // owned by the current process.
  const invocationRecovery = recoverRunningInvocations
    ? recoverInterruptedInvocations({
        invocationStore: input.invocationStore,
        now,
        reason,
      })
    : { attempts: [], invocationRequeues: 0, invocationFailures: 0 };
  attempts.push(...invocationRecovery.attempts);
  transitionCount += invocationRecovery.invocationRequeues + invocationRecovery.invocationFailures;

  return {
    trigger: input.trigger,
    daemonGeneration: input.daemonGeneration,
    observedAt: now,
    attemptCount: liveAttempts.length,
    transitionCount,
    leaseCount,
    attempts,
    invocationRequeues: invocationRecovery.invocationRequeues,
    invocationFailures: invocationRecovery.invocationFailures,
  };
}

export interface RecoverInterruptedInvocationsInput {
  invocationStore: SparkInvocationStore;
  now?: string;
  reason?: string;
}

/** One invocation-level recovery implementation for every compatibility caller. */
export function recoverInterruptedInvocations(
  input: RecoverInterruptedInvocationsInput,
): Pick<ExecutionReconcileResult, "attempts" | "invocationRequeues" | "invocationFailures"> {
  const now = input.now ?? new Date().toISOString();
  const reason = input.reason ?? "startup_reconcile";
  const attempts: ExecutionReconcileAttemptResult[] = [];
  let invocationRequeues = 0;
  let invocationFailures = 0;

  while (true) {
    const running = input.invocationStore.listPage({ status: "running", limit: 100 }).invocations;
    if (running.length === 0) break;
    for (const invocation of running) {
      try {
        let taskType: string | undefined;
        try {
          taskType = validateSparkDaemonTask(invocation.task).type;
        } catch {
          input.invocationStore.complete(invocation.invocationId, {
            status: "failed",
            errorCode: SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
            errorMessage: SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
            now,
          });
          invocationFailures += 1;
          attempts.push({
            invocationId: invocation.invocationId,
            attemptEpoch: 0,
            previousStatus: "running",
            transition: "fail_interrupted",
            reason: "invalid_task_payload",
          });
          continue;
        }
        if (
          input.invocationStore.hasDurableCommitStarted(invocation.invocationId) &&
          taskType !== "session.compact"
        ) {
          input.invocationStore.complete(invocation.invocationId, {
            status: "failed",
            errorCode: "DURABLE_COMMIT_OUTCOME_UNKNOWN",
            errorMessage:
              "The daemon exited after this invocation entered its durable commit phase; inspect the operation result before retrying.",
            now,
          });
          invocationFailures += 1;
          attempts.push({
            invocationId: invocation.invocationId,
            attemptEpoch: 0,
            previousStatus: "running",
            transition: "fail_interrupted",
            reason: "durable_commit_unknown",
          });
          continue;
        }
        input.invocationStore.requeueForResume(invocation.invocationId, now);
        invocationRequeues += 1;
        attempts.push({
          invocationId: invocation.invocationId,
          attemptEpoch: 0,
          previousStatus: "running",
          transition: "requeue_invocation",
          nextStatus: "queued",
          reason,
        });
      } catch (error) {
        const current = input.invocationStore.getSummary(invocation.invocationId);
        if (current?.status === "running") throw error;
        attempts.push({
          invocationId: invocation.invocationId,
          attemptEpoch: 0,
          previousStatus: "running",
          transition: "skip_terminal",
          reason: "concurrent_terminal",
        });
      }
    }
  }

  return { attempts, invocationRequeues, invocationFailures };
}

function reconcileReason(trigger: ExecutionReconcileTrigger): string {
  switch (trigger) {
    case "planned_shutdown":
      return "planned_shutdown";
    case "transport_detach":
      return "transport_detach";
    case "launchagent_handoff":
      return "launchagent_handoff";
    case "machine_restart":
      return "machine_restart";
    case "periodic_tick":
      return "periodic_tick";
    case "startup":
      return "startup_reconcile";
    case "daemon_crash":
    default:
      return "daemon_crash";
  }
}
