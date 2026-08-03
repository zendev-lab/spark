import type {
  LensVerdict,
  Observation,
  ProviderId,
  ProviderResult,
  WorkspaceRevision,
} from "./types.ts";

export interface EvaluateLensVerdictOptions {
  revision: WorkspaceRevision;
  results: readonly ProviderResult[];
  observations: readonly Observation[];
  requiredProviderIds: readonly ProviderId[];
}

export function evaluateLensVerdict(options: EvaluateLensVerdictOptions): LensVerdict {
  const { revision, results, observations, requiredProviderIds } = options;
  if (
    results.some((result) => result.revisionDigest !== revision.digest) ||
    observations.some((observation) => observation.revisionDigest !== revision.digest)
  ) {
    return "stale";
  }

  const byProvider = new Map(results.map((result) => [result.providerId, result]));
  if (
    requiredProviderIds.length === 0 ||
    requiredProviderIds.some((providerId) => byProvider.get(providerId)?.status !== "ok")
  ) {
    return "inconclusive";
  }

  if (
    observations.some(
      (observation) =>
        observation.disposition === "open" &&
        (observation.severity === "blocker" || observation.severity === "error"),
    )
  ) {
    return "fail";
  }

  if (observations.some((observation) => observation.agreement === "conflicting")) {
    return "inconclusive";
  }

  return "pass";
}
