/** Daemon-owned policy for persistent main task claims. */
export const MAIN_TASK_CLAIM_LEASE_MS = 3 * 60 * 1_000;
export const MAIN_TASK_CLAIM_RENEW_THRESHOLD_MS = 2 * 60 * 1_000;
export const MAIN_TASK_CLAIM_EXPIRY_GRACE_MS = 90 * 1_000;
export const MAIN_TASK_CLAIM_RECONCILE_INTERVAL_MS = 15 * 1_000;
export const MAIN_TASK_CLAIM_STARTUP_RECOVERY_WINDOW_MS = 90 * 1_000;
export const MAIN_TASK_CLAIM_STORE_LOCK_TIMEOUT_MS = 1_000;
export const MAIN_TASK_CLAIM_STORE_LOCK_RETRY_DELAYS_MS = [25, 100, 250] as const;

export interface MainTaskClaimLeasePolicy {
  leaseMs: number;
  renewThresholdMs: number;
  expiryGraceMs: number;
  reconcileIntervalMs: number;
  startupRecoveryWindowMs: number;
  storeLockTimeoutMs: number;
  storeLockRetryDelaysMs: readonly number[];
}

export const mainTaskClaimLeasePolicy: MainTaskClaimLeasePolicy = {
  leaseMs: MAIN_TASK_CLAIM_LEASE_MS,
  renewThresholdMs: MAIN_TASK_CLAIM_RENEW_THRESHOLD_MS,
  expiryGraceMs: MAIN_TASK_CLAIM_EXPIRY_GRACE_MS,
  reconcileIntervalMs: MAIN_TASK_CLAIM_RECONCILE_INTERVAL_MS,
  startupRecoveryWindowMs: MAIN_TASK_CLAIM_STARTUP_RECOVERY_WINDOW_MS,
  storeLockTimeoutMs: MAIN_TASK_CLAIM_STORE_LOCK_TIMEOUT_MS,
  storeLockRetryDelaysMs: MAIN_TASK_CLAIM_STORE_LOCK_RETRY_DELAYS_MS,
};

export function shouldRenewMainTaskClaim(expiresAt: string, now: string): boolean {
  return Date.parse(expiresAt) - Date.parse(now) <= MAIN_TASK_CLAIM_RENEW_THRESHOLD_MS;
}

export function mainTaskClaimExpiryBoundary(expiresAt: string): string {
  return new Date(Date.parse(expiresAt) + MAIN_TASK_CLAIM_EXPIRY_GRACE_MS).toISOString();
}
