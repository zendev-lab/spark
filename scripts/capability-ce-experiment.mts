import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";

import {
  summarizeSparkBehaviorCe,
  type SparkBehaviorCeSample,
} from "../apps/spark-daemon/src/product/host/agent-runtime/behavior-ce.ts";

export interface CapabilityCeSnapshot {
  commitSha: string;
  clean: boolean;
  evaluatorDigest: string;
  dependencyDigest: string;
  environment: { node: string; platform: string; release: string; arch: string; cpu: string };
}

export interface CapabilityCeExperiment {
  schema: "spark.capability-ce-experiment/v1";
  before: CapabilityCeSnapshot;
  after: CapabilityCeSnapshot;
  configuration: {
    runs: number;
    maxFailureRate: number;
    maxDurationP95Ms: number;
    runTimeoutMs: number;
    providerTokenPolicy: "zero";
  };
  invalidRunIds: string[];
  samples: SparkBehaviorCeSample[];
}

const textSchema = { type: "string", minLength: 1 };
const digestSchema = { type: "string", pattern: "^[a-f0-9]{64}$" };
const snapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["commitSha", "clean", "evaluatorDigest", "dependencyDigest", "environment"],
  properties: {
    commitSha: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
    clean: { type: "boolean" },
    evaluatorDigest: digestSchema,
    dependencyDigest: digestSchema,
    environment: {
      type: "object",
      additionalProperties: false,
      required: ["node", "platform", "release", "arch", "cpu"],
      properties: Object.fromEntries(
        ["node", "platform", "release", "arch", "cpu"].map((key) => [key, textSchema]),
      ),
    },
  },
};
const validateExperiment = new Ajv({ allErrors: true }).compile<CapabilityCeExperiment>({
  type: "object",
  additionalProperties: false,
  required: ["schema", "before", "after", "configuration", "invalidRunIds", "samples"],
  properties: {
    schema: { const: "spark.capability-ce-experiment/v1" },
    before: snapshotSchema,
    after: snapshotSchema,
    configuration: {
      type: "object",
      additionalProperties: false,
      required: [
        "runs",
        "maxFailureRate",
        "maxDurationP95Ms",
        "runTimeoutMs",
        "providerTokenPolicy",
      ],
      properties: {
        runs: { type: "integer", minimum: 1, maximum: 50 },
        maxFailureRate: { type: "number", minimum: 0, maximum: 1 },
        maxDurationP95Ms: { type: "integer", minimum: 1, maximum: 600000 },
        runTimeoutMs: { type: "integer", minimum: 1000, maximum: 900000 },
        providerTokenPolicy: { const: "zero" },
      },
    },
    invalidRunIds: { type: "array", uniqueItems: true, items: textSchema },
    samples: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["runId", "caseId", "passed", "durationMs"],
        properties: {
          runId: textSchema,
          caseId: textSchema,
          passed: { type: "boolean" },
          durationMs: { type: "number", minimum: 0 },
          metrics: { type: "object", additionalProperties: { type: "number" } },
          failure: { type: "string" },
        },
      },
    },
  },
});

function parseCapabilityCeExperiment(value: unknown): CapabilityCeExperiment {
  if (!validateExperiment(value)) {
    throw new Error(
      `Invalid capability CE experiment: ${JSON.stringify(validateExperiment.errors)}`,
    );
  }
  return value;
}

export async function captureCapabilityCeSnapshot(
  repositoryRoot: string,
  requiredEvaluatorFiles: readonly string[],
): Promise<CapabilityCeSnapshot> {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      maxBuffer: 16 * 1024 * 1024,
    }).trimEnd();
  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
  const evaluatorFiles = [
    ...new Set([
      ...requiredEvaluatorFiles,
      "apps/spark-daemon/src/product/host/agent-runtime/behavior-ce.ts",
      "pnpm-workspace.yaml",
      ".node-version",
      ...tracked.filter(
        (path) =>
          /(?:^|\/)(?:test|test-support|testing|fixtures|scripts)\//u.test(path) ||
          /(?:\.test|\.config)\.[cm]?[jt]s$/u.test(path) ||
          /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|\.npmrc)$/u.test(path),
      ),
    ]),
  ].sort();
  const evaluatorEntries = await Promise.all(
    evaluatorFiles.map(
      async (path) => [path, digest(await readFile(join(repositoryRoot, path)))] as const,
    ),
  );
  return {
    commitSha: git("rev-parse", "HEAD"),
    clean: git("status", "--porcelain", "--untracked-files=all") === "",
    evaluatorDigest: digest(JSON.stringify(evaluatorEntries)),
    dependencyDigest: digest(await readFile(join(repositoryRoot, "pnpm-lock.yaml"))),
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu:
        cpus()
          .map((cpu) => cpu.model)
          .join(";") || "unknown",
    },
  };
}

export function compareCapabilityCeExperiments(baselineValue: unknown, candidateValue: unknown) {
  const baseline = parseCapabilityCeExperiment(baselineValue);
  const candidate = parseCapabilityCeExperiment(candidateValue);
  const reasons: string[] = [];
  for (const [label, experiment] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    if (!experiment.before.clean || !experiment.after.clean)
      reasons.push(`${label}: source is dirty`);
    if (!isDeepStrictEqual(experiment.before, experiment.after))
      reasons.push(`${label}: snapshot changed during evaluation`);
    if (experiment.invalidRunIds.length > 0)
      reasons.push(`${label}: invalid runs: ${experiment.invalidRunIds.join(", ")}`);
  }
  for (const field of ["evaluatorDigest", "dependencyDigest", "environment"] as const) {
    if (!isDeepStrictEqual(baseline.before[field], candidate.before[field]))
      reasons.push(`mismatched ${field}`);
  }
  if (!isDeepStrictEqual(baseline.configuration, candidate.configuration))
    reasons.push("mismatched configuration");
  const summarize = (experiment: CapabilityCeExperiment) =>
    summarizeSparkBehaviorCe(experiment.samples, {
      expectedRunIds: Array.from(
        { length: experiment.configuration.runs },
        (_, i) => `run-${String(i + 1).padStart(2, "0")}`,
      ),
      maxFailureRate: experiment.configuration.maxFailureRate,
      maxDurationP95Ms: experiment.configuration.maxDurationP95Ms,
    });
  const baselineSummary = summarize(baseline);
  const candidateSummary = summarize(candidate);
  for (const [label, summary] of [
    ["baseline", baselineSummary],
    ["candidate", candidateSummary],
  ] as const) {
    if (!summary.inventoryStable)
      reasons.push(`${label}: incomplete or duplicate sample inventory`);
    if (!summary.canonicalCaseIds.includes("@runner") || summary.canonicalCaseIds.length < 2) {
      reasons.push(`${label}: missing runner or assertion samples`);
    }
  }
  if (!isDeepStrictEqual(baselineSummary.canonicalCaseIds, candidateSummary.canonicalCaseIds))
    reasons.push("mismatched case inventory");
  const identity = {
    schema: "spark.capability-ce-comparison/v1" as const,
    baselineCommit: baseline.before.commitSha,
    candidateCommit: candidate.before.commitSha,
    baselineExperimentDigest: digest(JSON.stringify(baseline)),
    candidateExperimentDigest: digest(JSON.stringify(candidate)),
    scope: "observed deterministic sentinel behavior; no model capability or promotion claim",
  };
  if (reasons.length > 0)
    return { ...identity, status: "incomparable" as const, reasons, cases: [] };
  const cases = baselineSummary.cases.map((before, index) => {
    const after = candidateSummary.cases[index]!;
    return {
      caseId: before.caseId,
      baselinePassRate: before.passRate,
      candidatePassRate: after.passRate,
      additionalFailures: after.failedSamples - before.failedSamples,
      baselineDurationP95Ms: before.durationMs!.p95,
      candidateDurationP95Ms: after.durationMs!.p95,
    };
  });
  const regressions = cases.filter((entry) => entry.additionalFailures > 0);
  const improvements = cases.filter((entry) => entry.additionalFailures < 0);
  const status = !candidateSummary.passed
    ? ("candidate_failed" as const)
    : regressions.length > 0
      ? ("regressed" as const)
      : improvements.length > 0
        ? ("improved" as const)
        : ("unchanged" as const);
  return {
    ...identity,
    status,
    reasons: !candidateSummary.passed
      ? ["candidate exceeds the fixed CE acceptance budgets"]
      : regressions.map((entry) => `additional failures: ${entry.caseId}`),
    cases,
  };
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
