import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import type { AskRef, EvidenceRef } from "@zendev-lab/spark-core";
import {
  buildSparkReproWorkSummary,
  SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
  type SparkReproDecisionRequest,
  type SparkReproEvidenceGate,
  type SparkReproProfile,
  type SparkReproWorkSummaryInput,
  type SparkReproWorkStage,
} from "@zendev-lab/spark-repro/work-summary";
import { afterEach, describe, expect, it } from "vitest";
import type { SparkLoopEvaluationContext } from "../store/loop-evaluators.ts";
import { reproCompletionEvaluator, reproPendingDecisionEvaluator } from "./repro-loop-evaluator.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("trusted Repro Loop evaluators", () => {
  it("blocks before_tick on a canonical pending Ask without invoking a model", async () => {
    const cwd = await workspace();
    const input = summaryInput(false);
    input.pendingDecisions = [pendingDecision()];
    await writeSummary(cwd, input);

    const result = await reproPendingDecisionEvaluator(context(cwd));

    expect(result).toMatchObject({
      verdict: "matched",
      blockers: [expect.stringContaining("ask:publish")],
      inputSummary: { pendingDecisionCount: 1 },
    });
  });

  it("completes only from re-derived formal gates and records trusted Evidence", async () => {
    const cwd = await workspace();
    const input = summaryInput(true);
    await persistAcceptedFormalEvidence(cwd, input);
    await writeSummary(cwd, input);

    const result = await reproCompletionEvaluator(context(cwd));

    expect(result).toMatchObject({ verdict: "achieved" });
    expect(result.evidenceRefs).toHaveLength(1);
    expect(result.evidenceRefs?.[0]).toMatch(/^evidence:/u);
  });

  it("rejects accepted formal gates whose Evidence refs are not durable", async () => {
    const cwd = await workspace();
    await writeSummary(cwd, summaryInput(true));

    await expect(reproCompletionEvaluator(context(cwd))).rejects.toThrow(
      /Repro completion evidence not found: evidence:contract-frozen/u,
    );
  });

  it("rejects a persisted status that does not match canonical typed facts", async () => {
    const cwd = await workspace();
    const work = buildSparkReproWorkSummary(summaryInput(false));
    await mkdir(join(cwd, "outputs"), { recursive: true });
    await writeFile(
      join(cwd, "outputs", "spark-summary.json"),
      JSON.stringify({ format: "spark-repro-summary/v1", work: { ...work, status: "complete" } }),
    );

    await expect(reproCompletionEvaluator(context(cwd))).rejects.toThrow(
      /work.status does not match canonical facts/u,
    );
  });
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "spark-repro-evaluator-"));
  dirs.push(cwd);
  return cwd;
}

async function writeSummary(cwd: string, input: SparkReproWorkSummaryInput): Promise<void> {
  const work = buildSparkReproWorkSummary(input);
  await mkdir(join(cwd, "outputs"), { recursive: true });
  await writeFile(
    join(cwd, "outputs", "spark-summary.json"),
    `${JSON.stringify({ format: "spark-repro-summary/v1", work }, null, 2)}\n`,
  );
}

async function persistAcceptedFormalEvidence(
  cwd: string,
  input: SparkReproWorkSummaryInput,
): Promise<void> {
  const store = defaultEvidenceStore(cwd);
  const refs = [
    ...new Set(
      input.gates
        .filter((gate) => gate.evidenceClass === "formal" && gate.status === "accepted")
        .flatMap((gate) => gate.evidenceRefs),
    ),
  ];
  for (const ref of refs) {
    await store.put({
      ref,
      kind: "record",
      title: `Formal proof ${ref}`,
      format: "json",
      body: { passed: true },
      provenance: { producer: "spark" },
    });
  }
}

function context(cwd: string): SparkLoopEvaluationContext {
  return {
    loop: {
      loopId: "repro-1",
      ownerSessionId: "session-1",
      status: "running",
      continuity: "session",
      generation: 1,
      cycleStep: "after_tick",
      binding: {
        goalId: "goal-1",
        workflowRunId: "workflow-run:repro-1",
        workflowSelector: "builtin:repro",
        reproId: "repro-1",
      },
      policy: {
        cadenceMs: 30_000,
        retry: { maxAttempts: 3, delaysMs: [30_000] },
        beforeTick: [],
        afterTick: [],
        completion: { selector: "builtin:repro-reviewer", input: {} },
      },
      counters: {
        tickCount: 1,
        skippedCount: 0,
        llmRequestsAvoided: 0,
        conditionRetryCount: 0,
      },
      attempt: 0,
    },
    checkpoint: {
      cycleId: "cycle-1",
      generation: 1,
      step: "after_tick",
      startedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:01.000Z",
      receipts: [],
      beforeAttempt: 0,
      afterAttempt: 0,
    },
    input: {},
    route: { cwd },
  };
}

function summaryInput(complete: boolean): SparkReproWorkSummaryInput {
  const profile = minimumProfile();
  const gates: SparkReproEvidenceGate[] = [
    formalGate("contract-frozen", "contract", "accepted"),
    {
      ...formalGate("reference-ready", "reference", "accepted", profile),
      establishes: ["reference_ready"],
    },
    { ...formalGate("target-ready", "target", "accepted", profile), establishes: ["target_ready"] },
    {
      ...formalGate("alignment", "alignment", "accepted", {
        ...profile,
        steps: { completed: 100, target: 100 },
        topology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY, pp: 2, ep: 4 },
      }),
      establishes: ["required_steps_aligned", "reference_parity"],
    },
    formalGate("delivery", "delivery", complete ? "accepted" : "open"),
  ];
  return {
    reproId: "repro-1",
    title: "Repro one",
    stage: complete ? "delivery" : "alignment",
    target: {
      model: "minimum_complete",
      requiredSteps: 100,
      referenceStrategies: ["pp", "ep"],
      validationTopology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY, pp: 2, ep: 4 },
    },
    profile,
    gates,
  };
}

function formalGate(
  id: string,
  stage: SparkReproWorkStage,
  status: SparkReproEvidenceGate["status"],
  profile?: SparkReproProfile,
): SparkReproEvidenceGate {
  return {
    id,
    title: id,
    stage,
    evidenceClass: "formal",
    status,
    weight: 1,
    evidenceRefs: status === "accepted" ? [`evidence:${id}` as EvidenceRef] : [],
    ...(profile ? { profile } : {}),
  };
}

function minimumProfile(): SparkReproProfile {
  return {
    id: "minimum-complete",
    model: "minimum_complete",
    compute: "optimizer",
    steps: { completed: 1, target: 1 },
    topology: SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
  };
}

function pendingDecision(): SparkReproDecisionRequest {
  return {
    id: "publish",
    status: "pending",
    kind: "external_publish",
    question: "Publish the report?",
    options: [
      { value: "yes", label: "Publish" },
      { value: "no", label: "Keep draft", recommended: true },
    ],
    blockedTransition: { from: "delivery", to: "delivery" },
    evidenceRefs: [],
    askRef: "ask:publish" as AskRef,
  };
}
