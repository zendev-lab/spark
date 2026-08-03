import type { ProviderId } from "./types.ts";

export type ProviderExecutableSource = "spark_managed" | "project_local" | "system";

export interface ProviderLaunchSpec {
  providerId: ProviderId;
  executable: string;
  args: readonly string[];
  cwd: string;
  source: ProviderExecutableSource;
  executableDigest: string;
  configDigest: string;
}

export interface ProviderTrustGrant {
  providerId: ProviderId;
  source: ProviderExecutableSource;
  executableDigest: string;
  configDigest: string;
}

export type ProviderTrustDecision =
  | { trusted: true; grant: ProviderTrustGrant }
  | {
      trusted: false;
      reason:
        | "grant_missing"
        | "provider_mismatch"
        | "source_mismatch"
        | "executable_changed"
        | "config_changed";
    };

export function decideProviderTrust(
  launch: ProviderLaunchSpec,
  grant: ProviderTrustGrant | undefined,
): ProviderTrustDecision {
  if (launch.source === "spark_managed") {
    return {
      trusted: true,
      grant: {
        providerId: launch.providerId,
        source: launch.source,
        executableDigest: launch.executableDigest,
        configDigest: launch.configDigest,
      },
    };
  }
  if (!grant) return { trusted: false, reason: "grant_missing" };
  if (grant.providerId !== launch.providerId) {
    return { trusted: false, reason: "provider_mismatch" };
  }
  if (grant.source !== launch.source) return { trusted: false, reason: "source_mismatch" };
  if (grant.executableDigest !== launch.executableDigest) {
    return { trusted: false, reason: "executable_changed" };
  }
  if (grant.configDigest !== launch.configDigest) {
    return { trusted: false, reason: "config_changed" };
  }
  return { trusted: true, grant };
}
