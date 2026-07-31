export const LENS_REQUIRED_CAPABILITIES = [
  "diagnostics",
  "navigation",
  "format",
  "structural_search",
  "impact",
  "triage",
  "patch_proposal",
  "project_verification",
] as const;

export type LensScorecardStatus = "pass" | "fail" | "pending";
export type LensScorecardLanguage = "typescript" | "python" | "rust";

export interface LensScorecardMeasurements {
  schemaVersion: 1;
  generatedAt: string;
  baseline: {
    package: "pi-lens";
    version: "3.8.73";
    commit: "dc4d6f4d5dfd0d5ddbc6a473efac9e9d1ea84d57";
  };
  protocol: {
    sameMachine: boolean | null;
    fixedModel: boolean | null;
    fixedPrompt: boolean | null;
    repetitions: number | null;
  };
  correctness: {
    acceptedStaleResults: number | null;
    passesWithoutAffirmativeClean: number | null;
    staleReceiptBypasses: number | null;
  };
  capabilities: Record<
    LensScorecardLanguage,
    {
      covered: string[];
      independentDiagnosticProviders: number | null;
    }
  >;
  concurrency: {
    maxProcessesPerProviderWorktree: number | null;
    fourSessionRssRatio: number | null;
    orphanProvidersAfterRestart: number | null;
    acceptedPreRestartResults: number | null;
  };
  performance: {
    warmP95Ratio: Record<LensScorecardLanguage, number | null>;
    warmGeomeanSpeedup: number | null;
    coldP95Ratio: number | null;
    discoveryHitRate: number | null;
    visibleTokenRatio: number | null;
  };
  agentEffect: {
    sparkCompletionRate: number | null;
    baselineCompletionRate: number | null;
    sparkDefectRecall: number | null;
    baselineDefectRecall: number | null;
    sparkFalsePositiveRate: number | null;
    baselineFalsePositiveRate: number | null;
    invalidWorkReduction: number | null;
  };
  evidenceRefs: string[];
}

export interface LensScorecardCheck {
  id: string;
  status: LensScorecardStatus;
  threshold: string;
  value: unknown;
}

export interface LensScorecardGate {
  status: LensScorecardStatus;
  checks: LensScorecardCheck[];
}

export interface LensReleaseScorecard {
  schemaVersion: 1;
  generator: "scripts/run-lens-scorecard.mts";
  generatedAt: string;
  fixtureDigest: string;
  measurements: LensScorecardMeasurements;
  gates: {
    correctness: LensScorecardGate;
    capabilities: LensScorecardGate;
    concurrency: LensScorecardGate;
    performance: LensScorecardGate;
    agentEffect: LensScorecardGate;
  };
  overall: LensScorecardStatus;
}

export function evaluateLensScorecard(
  measurements: LensScorecardMeasurements,
  fixtureDigest: string,
): LensReleaseScorecard {
  const gates = {
    correctness: gate([
      maximum(
        "correctness.accepted_stale_results",
        measurements.correctness.acceptedStaleResults,
        0,
      ),
      maximum(
        "correctness.pass_without_affirmative_clean",
        measurements.correctness.passesWithoutAffirmativeClean,
        0,
      ),
      maximum(
        "correctness.stale_receipt_bypasses",
        measurements.correctness.staleReceiptBypasses,
        0,
      ),
    ]),
    capabilities: gate(
      (["typescript", "python", "rust"] as const).flatMap((language) => {
        const value = measurements.capabilities[language];
        return [
          check(
            `capabilities.${language}.surface`,
            value.covered.length === 0
              ? null
              : LENS_REQUIRED_CAPABILITIES.every((capability) =>
                  value.covered.includes(capability),
                ),
            `includes ${LENS_REQUIRED_CAPABILITIES.join(", ")}`,
            value.covered,
          ),
          minimum(
            `capabilities.${language}.diagnostic_providers`,
            value.independentDiagnosticProviders,
            2,
          ),
        ];
      }),
    ),
    concurrency: gate([
      maximum(
        "concurrency.processes_per_provider_worktree",
        measurements.concurrency.maxProcessesPerProviderWorktree,
        1,
      ),
      maximum(
        "concurrency.four_session_rss_ratio",
        measurements.concurrency.fourSessionRssRatio,
        0.6,
      ),
      maximum(
        "concurrency.orphan_providers_after_restart",
        measurements.concurrency.orphanProvidersAfterRestart,
        0,
      ),
      maximum(
        "concurrency.accepted_pre_restart_results",
        measurements.concurrency.acceptedPreRestartResults,
        0,
      ),
    ]),
    performance: gate([
      ...(["typescript", "python", "rust"] as const).map((language) =>
        maximum(
          `performance.${language}.warm_p95_ratio`,
          measurements.performance.warmP95Ratio[language],
          1,
        ),
      ),
      minimum("performance.warm_geomean_speedup", measurements.performance.warmGeomeanSpeedup, 0.2),
      maximum("performance.cold_p95_ratio", measurements.performance.coldP95Ratio, 1.1),
      minimum("performance.discovery_hit_rate", measurements.performance.discoveryHitRate, 0.95),
      maximum("performance.visible_token_ratio", measurements.performance.visibleTokenRatio, 0.7),
    ]),
    agentEffect: gate([
      check(
        "agent.protocol_same_machine",
        measurements.protocol.sameMachine,
        "true",
        measurements.protocol.sameMachine,
      ),
      check(
        "agent.protocol_fixed_model",
        measurements.protocol.fixedModel,
        "true",
        measurements.protocol.fixedModel,
      ),
      check(
        "agent.protocol_fixed_prompt",
        measurements.protocol.fixedPrompt,
        "true",
        measurements.protocol.fixedPrompt,
      ),
      minimum("agent.protocol_repetitions", measurements.protocol.repetitions, 3),
      compare(
        "agent.completion_rate",
        measurements.agentEffect.sparkCompletionRate,
        measurements.agentEffect.baselineCompletionRate,
        ">=",
      ),
      compare(
        "agent.defect_recall",
        measurements.agentEffect.sparkDefectRecall,
        measurements.agentEffect.baselineDefectRecall,
        ">=",
      ),
      compare(
        "agent.false_positive_rate",
        measurements.agentEffect.sparkFalsePositiveRate,
        measurements.agentEffect.baselineFalsePositiveRate,
        "<=",
      ),
      minimum("agent.invalid_work_reduction", measurements.agentEffect.invalidWorkReduction, 0.2),
    ]),
  };
  const statuses = Object.values(gates).map((value) => value.status);
  return {
    schemaVersion: 1,
    generator: "scripts/run-lens-scorecard.mts",
    generatedAt: new Date().toISOString(),
    fixtureDigest,
    measurements,
    gates,
    overall: statuses.includes("fail") ? "fail" : statuses.includes("pending") ? "pending" : "pass",
  };
}

function maximum(id: string, value: number | null, limit: number): LensScorecardCheck {
  return check(id, value === null ? null : value <= limit, `<= ${String(limit)}`, value);
}

function minimum(id: string, value: number | null, limit: number): LensScorecardCheck {
  return check(id, value === null ? null : value >= limit, `>= ${String(limit)}`, value);
}

function compare(
  id: string,
  left: number | null,
  right: number | null,
  operator: ">=" | "<=",
): LensScorecardCheck {
  const passed =
    left === null || right === null ? null : operator === ">=" ? left >= right : left <= right;
  return check(id, passed, `Spark ${operator} pi-lens`, { spark: left, piLens: right });
}

function check(
  id: string,
  passed: boolean | null,
  threshold: string,
  value: unknown,
): LensScorecardCheck {
  return {
    id,
    status: passed === null ? "pending" : passed ? "pass" : "fail",
    threshold,
    value,
  };
}

function gate(checks: LensScorecardCheck[]): LensScorecardGate {
  return {
    status: checks.some((item) => item.status === "fail")
      ? "fail"
      : checks.some((item) => item.status === "pending")
        ? "pending"
        : "pass",
    checks,
  };
}
