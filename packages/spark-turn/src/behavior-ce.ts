export interface SparkBehaviorCeSample {
  runId: string;
  caseId: string;
  passed: boolean;
  durationMs?: number;
  metrics?: Readonly<Record<string, number>>;
  failure?: string;
}

export interface SparkBehaviorCeOptions {
  expectedRunIds: readonly string[];
  expectedCaseIds?: readonly string[];
  maxFailureRate?: number;
  maxDurationP95Ms?: number;
  failureSampleLimit?: number;
}

export interface SparkBehaviorCeNumericSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  coefficientOfVariation: number | null;
}

export interface SparkBehaviorCeCaseSummary {
  caseId: string;
  expectedRuns: number;
  observedRuns: number;
  passes: number;
  failedSamples: number;
  missingRunIds: string[];
  passRate: number;
  failureRate: number;
  flaky: boolean;
  passed: boolean;
  violations: string[];
  durationMs?: SparkBehaviorCeNumericSummary;
  metrics: Record<string, SparkBehaviorCeNumericSummary>;
  failureSamples: string[];
}

export interface SparkBehaviorCeRunInventory {
  runId: string;
  caseIds: string[];
  missingCaseIds: string[];
  unexpectedCaseIds: string[];
}

export interface SparkBehaviorCeDuplicateSample {
  runId: string;
  caseId: string;
}

export interface SparkBehaviorCeSummary {
  schemaVersion: 1;
  passed: boolean;
  inventoryStable: boolean;
  expectedRunIds: string[];
  observedRunIds: string[];
  missingRunIds: string[];
  unexpectedRunIds: string[];
  canonicalCaseIds: string[];
  duplicateSamples: SparkBehaviorCeDuplicateSample[];
  runInventories: SparkBehaviorCeRunInventory[];
  cases: SparkBehaviorCeCaseSummary[];
  totals: {
    expectedRuns: number;
    observedRuns: number;
    cases: number;
    samples: number;
    passes: number;
    failedSamples: number;
    missingSamples: number;
    flakyCases: number;
  };
}

/**
 * Summarize repeated behavior evaluations without averaging away failures.
 * Missing runs, inventory drift, duplicate samples, and budget violations are
 * first-class failures even when the aggregate pass rate looks healthy.
 */
export function summarizeSparkBehaviorCe(
  samples: readonly SparkBehaviorCeSample[],
  options: SparkBehaviorCeOptions,
): SparkBehaviorCeSummary {
  const expectedRunIds = uniqueNonEmpty(options.expectedRunIds, "expectedRunIds");
  const expectedCaseIds = options.expectedCaseIds
    ? uniqueNonEmpty(options.expectedCaseIds, "expectedCaseIds")
    : undefined;
  const maxFailureRate = normalizeRate(options.maxFailureRate ?? 0, "maxFailureRate");
  const maxDurationP95Ms = normalizeOptionalNonNegative(
    options.maxDurationP95Ms,
    "maxDurationP95Ms",
  );
  const failureSampleLimit = normalizePositiveInteger(
    options.failureSampleLimit ?? 3,
    "failureSampleLimit",
  );
  const expectedRunSet = new Set(expectedRunIds);
  const samplesByRun = new Map<string, Map<string, SparkBehaviorCeSample>>();
  const duplicateSamples: SparkBehaviorCeDuplicateSample[] = [];

  for (const rawSample of samples) {
    const sample = normalizeSample(rawSample);
    const run = samplesByRun.get(sample.runId) ?? new Map<string, SparkBehaviorCeSample>();
    if (run.has(sample.caseId)) {
      duplicateSamples.push({ runId: sample.runId, caseId: sample.caseId });
      continue;
    }
    run.set(sample.caseId, sample);
    samplesByRun.set(sample.runId, run);
  }

  const observedRunIds = [...samplesByRun.keys()].sort();
  const missingRunIds = expectedRunIds.filter((runId) => !samplesByRun.has(runId));
  const unexpectedRunIds = observedRunIds.filter((runId) => !expectedRunSet.has(runId));
  const canonicalCaseIds = expectedCaseIds ?? inferCanonicalCaseIds(expectedRunIds, samplesByRun);
  const canonicalCaseSet = new Set(canonicalCaseIds);
  const observedExpectedCaseIds = uniqueSorted(
    expectedRunIds.flatMap((runId) => [...(samplesByRun.get(runId)?.keys() ?? [])]),
  );
  const allCaseIds = uniqueSorted([...canonicalCaseIds, ...observedExpectedCaseIds]);
  const runInventories = expectedRunIds.map((runId) => {
    const caseIds = [...(samplesByRun.get(runId)?.keys() ?? [])].sort();
    const caseSet = new Set(caseIds);
    return {
      runId,
      caseIds,
      missingCaseIds: canonicalCaseIds.filter((caseId) => !caseSet.has(caseId)),
      unexpectedCaseIds: caseIds.filter((caseId) => !canonicalCaseSet.has(caseId)),
    } satisfies SparkBehaviorCeRunInventory;
  });
  const inventoryStable =
    canonicalCaseIds.length > 0 &&
    missingRunIds.length === 0 &&
    unexpectedRunIds.length === 0 &&
    duplicateSamples.length === 0 &&
    runInventories.every(
      (inventory) =>
        inventory.missingCaseIds.length === 0 && inventory.unexpectedCaseIds.length === 0,
    );

  const cases = allCaseIds.map((caseId) =>
    summarizeCase({
      caseId,
      expectedRunIds,
      samplesByRun,
      maxFailureRate,
      maxDurationP95Ms,
      failureSampleLimit,
    }),
  );
  const totals = {
    expectedRuns: expectedRunIds.length,
    observedRuns: expectedRunIds.length - missingRunIds.length,
    cases: cases.length,
    samples: cases.reduce((total, entry) => total + entry.observedRuns, 0),
    passes: cases.reduce((total, entry) => total + entry.passes, 0),
    failedSamples: cases.reduce((total, entry) => total + entry.failedSamples, 0),
    missingSamples: cases.reduce((total, entry) => total + entry.missingRunIds.length, 0),
    flakyCases: cases.filter((entry) => entry.flaky).length,
  };

  return {
    schemaVersion: 1,
    passed: inventoryStable && cases.length > 0 && cases.every((entry) => entry.passed),
    inventoryStable,
    expectedRunIds,
    observedRunIds,
    missingRunIds,
    unexpectedRunIds,
    canonicalCaseIds,
    duplicateSamples,
    runInventories,
    cases,
    totals,
  };
}

export function summarizeSparkBehaviorCeNumbers(
  values: readonly number[],
): SparkBehaviorCeNumericSummary | undefined {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return undefined;
  const mean = finite.reduce((total, value) => total + value, 0) / finite.length;
  const variance = finite.reduce((total, value) => total + (value - mean) ** 2, 0) / finite.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    count: finite.length,
    min: finite[0]!,
    max: finite.at(-1)!,
    mean: roundMetric(mean),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    coefficientOfVariation:
      mean === 0
        ? standardDeviation === 0
          ? 0
          : null
        : roundMetric(standardDeviation / Math.abs(mean)),
  };
}

function summarizeCase(input: {
  caseId: string;
  expectedRunIds: readonly string[];
  samplesByRun: ReadonlyMap<string, ReadonlyMap<string, SparkBehaviorCeSample>>;
  maxFailureRate: number;
  maxDurationP95Ms?: number;
  failureSampleLimit: number;
}): SparkBehaviorCeCaseSummary {
  const observed: SparkBehaviorCeSample[] = [];
  const missingRunIds: string[] = [];
  for (const runId of input.expectedRunIds) {
    const sample = input.samplesByRun.get(runId)?.get(input.caseId);
    if (sample) observed.push(sample);
    else missingRunIds.push(runId);
  }
  const passes = observed.filter((sample) => sample.passed).length;
  const failedSamples = observed.length - passes;
  const failureRate = (failedSamples + missingRunIds.length) / input.expectedRunIds.length;
  const durationMs = summarizeSparkBehaviorCeNumbers(
    observed.flatMap((sample) => (sample.durationMs === undefined ? [] : [sample.durationMs])),
  );
  const metricNames = uniqueSorted(observed.flatMap((sample) => Object.keys(sample.metrics ?? {})));
  const metrics = Object.fromEntries(
    metricNames.flatMap((metricName) => {
      const summary = summarizeSparkBehaviorCeNumbers(
        observed.flatMap((sample) => {
          const value = sample.metrics?.[metricName];
          return value === undefined ? [] : [value];
        }),
      );
      return summary ? [[metricName, summary]] : [];
    }),
  );
  const violations: string[] = [];
  if (failureRate > input.maxFailureRate) {
    violations.push(
      `failure_rate observed=${roundMetric(failureRate)} maximum=${roundMetric(input.maxFailureRate)}`,
    );
  }
  if (
    input.maxDurationP95Ms !== undefined &&
    durationMs !== undefined &&
    durationMs.p95 > input.maxDurationP95Ms
  ) {
    violations.push(`duration_p95_ms observed=${durationMs.p95} maximum=${input.maxDurationP95Ms}`);
  }
  const failureSamples = uniqueSorted(
    observed.flatMap((sample) => {
      const failure = sample.failure?.trim();
      return !sample.passed && failure ? [failure] : [];
    }),
  ).slice(0, input.failureSampleLimit);

  return {
    caseId: input.caseId,
    expectedRuns: input.expectedRunIds.length,
    observedRuns: observed.length,
    passes,
    failedSamples,
    missingRunIds,
    passRate: roundMetric(passes / input.expectedRunIds.length),
    failureRate: roundMetric(failureRate),
    flaky: passes > 0 && (failedSamples > 0 || missingRunIds.length > 0),
    passed: violations.length === 0,
    violations,
    ...(durationMs ? { durationMs } : {}),
    metrics,
    failureSamples,
  };
}

function inferCanonicalCaseIds(
  expectedRunIds: readonly string[],
  samplesByRun: ReadonlyMap<string, ReadonlyMap<string, SparkBehaviorCeSample>>,
): string[] {
  let canonical: string[] = [];
  for (const runId of expectedRunIds) {
    const candidate = [...(samplesByRun.get(runId)?.keys() ?? [])].sort();
    if (candidate.length > canonical.length) canonical = candidate;
  }
  return canonical;
}

function normalizeSample(sample: SparkBehaviorCeSample): SparkBehaviorCeSample {
  const runId = normalizeIdentifier(sample.runId, "sample.runId");
  const caseId = normalizeIdentifier(sample.caseId, "sample.caseId");
  const durationMs = normalizeOptionalNonNegative(sample.durationMs, "sample.durationMs");
  const metrics = Object.fromEntries(
    Object.entries(sample.metrics ?? {}).map(([name, value]) => {
      const normalizedName = normalizeIdentifier(name, "sample.metrics key");
      if (!Number.isFinite(value))
        throw new Error(`sample metric ${normalizedName} must be finite`);
      return [normalizedName, value];
    }),
  );
  return {
    runId,
    caseId,
    passed: sample.passed === true,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(Object.keys(metrics).length === 0 ? {} : { metrics }),
    ...(sample.failure?.trim() ? { failure: sample.failure.trim() } : {}),
  };
}

function uniqueNonEmpty(values: readonly string[], field: string): string[] {
  if (values.length === 0) throw new Error(`${field} must contain at least one value`);
  const normalized = values.map((value) => normalizeIdentifier(value, field));
  const unique = uniqueSorted(normalized);
  if (unique.length !== normalized.length) throw new Error(`${field} must not contain duplicates`);
  return unique;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizeRate(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return value;
}

function normalizeOptionalNonNegative(
  value: number | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
