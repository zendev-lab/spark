import { describe, expect, it } from "vitest";
import {
  MAIN_TASK_CLAIM_EXPIRY_GRACE_MS,
  MAIN_TASK_CLAIM_LEASE_MS,
  MAIN_TASK_CLAIM_RENEW_THRESHOLD_MS,
  MAIN_TASK_CLAIM_STARTUP_RECOVERY_WINDOW_MS,
  mainTaskClaimExpiryBoundary,
  mainTaskClaimLeasePolicy,
  shouldRenewMainTaskClaim,
} from "./policy.ts";

const now = "2026-07-29T00:00:00.000Z";

function after(ms: number): string {
  return new Date(Date.parse(now) + ms).toISOString();
}

describe("daemon main task claim policy", () => {
  it("keeps claim and session timings explicit and ordered", () => {
    expect(MAIN_TASK_CLAIM_LEASE_MS).toBeGreaterThan(MAIN_TASK_CLAIM_RENEW_THRESHOLD_MS);
    expect(MAIN_TASK_CLAIM_RENEW_THRESHOLD_MS).toBeGreaterThan(
      MAIN_TASK_CLAIM_STARTUP_RECOVERY_WINDOW_MS,
    );
    expect(MAIN_TASK_CLAIM_STARTUP_RECOVERY_WINDOW_MS).toBeGreaterThanOrEqual(
      MAIN_TASK_CLAIM_EXPIRY_GRACE_MS,
    );
    expect(mainTaskClaimLeasePolicy.storeLockRetryDelaysMs).toEqual([25, 100, 250]);
  });

  it("renews only when the remaining lease reaches the threshold", () => {
    expect(shouldRenewMainTaskClaim(after(MAIN_TASK_CLAIM_RENEW_THRESHOLD_MS + 1), now)).toBe(
      false,
    );
    expect(shouldRenewMainTaskClaim(after(MAIN_TASK_CLAIM_RENEW_THRESHOLD_MS), now)).toBe(true);
  });

  it("expires only after the explicit grace boundary", () => {
    expect(mainTaskClaimExpiryBoundary(now)).toBe(after(MAIN_TASK_CLAIM_EXPIRY_GRACE_MS));
  });
});
