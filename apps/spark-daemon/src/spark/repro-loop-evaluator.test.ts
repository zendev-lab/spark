import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import type { AskRef, EvidenceRef, TaskRef } from "@zendev-lab/spark-core";
import {
  buildSparkReproWorkSummary,
  sparkReproProfileDigest,
  sparkReproTopologyDigest,
  SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
  type SparkReproDecisionRequest,
  type SparkReproFormalEvidenceReceipt,
  type SparkReproEvidenceGate,
  type SparkReproProfile,
  type SparkReproWorkSummaryInput,
  type SparkReproWorkStage,
} from "@zendev-lab/spark-repro/work-summary";
import { afterEach, describe, expect, it } from "vitest";
import type { SparkLoopEvaluationContext } from "../store/loop-evaluators.ts";
import {
  createReproCompletionEvaluator,
  reproPendingDecisionEvaluator,
} from "./repro-loop-evaluator.ts";

const receiptsByCwd = new Map<string, Map<string, SparkReproFormalEvidenceReceipt>>();
const reproCompletionEvaluator = completionEvaluator;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    receiptsByCwd.delete(dir);
    await rm(dir, { recursive: true, force: true });
  }
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
    const input = strictCompleteSummaryInput();
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    const result = await reproCompletionEvaluator(context(cwd));

    expect(result).toMatchObject({ verdict: "achieved" });
    expect(result.evidenceRefs).toHaveLength(1);
    expect(result.evidenceRefs?.[0]).toMatch(/^evidence:/u);
  });

  it("preserves an unchanged retired step proof across a later global plan append", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    input.exploreFrontier!.planRevision = 2;
    input.normativeCursor!.planRevision = 2;
    for (const candidate of input.normativeCursor!.candidateBuffer) candidate.planRevision = 2;
    for (const record of input.normativeCursor!.retirementLog) record.planRevision = 2;
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    await expect(
      reproCompletionEvaluator(context(cwd), {
        currentRevision: 2,
        effectiveS1Revision: 1,
      }),
    ).resolves.toMatchObject({ verdict: "achieved" });
  });

  it("rejects a retirement log that hides one current StepVerifier Evidence ref", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    await expect(
      reproCompletionEvaluator(context(cwd), {
        extraS1EvidenceRef: "evidence:hidden-missing" as EvidenceRef,
      }),
    ).rejects.toThrow(/retirement lacks current StepVerifier PASS: S1/u);
  });

  it("rejects completion when a required durable Task is omitted from the summary", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    input.tasks = [];
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    await expect(reproCompletionEvaluator(context(cwd))).rejects.toThrow(
      /completion omits a current done Task: task:delivery/u,
    );
  });

  it("rejects a caller-declared done Task when the durable Task is still running", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    await expect(
      reproCompletionEvaluator(context(cwd), { currentTaskStatus: "running" }),
    ).rejects.toThrow(/requires current durable Task done: task:delivery/u);
  });

  it("rejects duplicate durable subgoal taskRef bindings before completion", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    await expect(
      reproCompletionEvaluator(context(cwd), { duplicateDurableTaskBinding: true }),
    ).rejects.toThrow(/duplicate durable subgoal taskRef: task:delivery/u);
  });

  it("rejects completion when a retired non-Matrix step lacks current StepVerifier PASS", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    const profile = input.target.acceptanceProfile!;
    input.normativeCursor!.orderedStepIds.push("S2");
    input.normativeCursor!.stepDefinitionDigests!.S2 = "digest:S2";
    input.normativeCursor!.stepDependencies!.S2 = ["S1"];
    input.normativeCursor!.retiredStepIds.push("S2");
    input.normativeCursor!.candidateBuffer.push({
      id: "candidate-S2",
      stepId: "S2",
      dependsOn: ["S1"],
      planRevision: 1,
      stepDefinitionDigest: "digest:S2",
      verdict: "accepted",
      profile,
      evidenceRefs: ["evidence:retirement-S2" as EvidenceRef],
      unresolvedIds: [],
    });
    input.normativeCursor!.retirementLog.push({
      stepId: "S2",
      candidateId: "candidate-S2",
      planRevision: 1,
      stepDefinitionDigest: "digest:S2",
      profile,
      profileDigest: sparkReproProfileDigest(profile),
      evidenceRefs: ["evidence:retirement-S2" as EvidenceRef],
    });
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, [
      "evidence:retirement-S1" as EvidenceRef,
      "evidence:retirement-S2" as EvidenceRef,
    ]);
    await writeSummary(cwd, input);

    await expect(reproCompletionEvaluator(context(cwd), { includeS2: true })).rejects.toThrow(
      /retirement lacks current StepVerifier PASS: S2/u,
    );
  });

  it("rejects a typed completion projection without daemon-resolved StepVerifier state", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);
    const evaluator = createReproCompletionEvaluator({
      get(actualCwd, identity) {
        return receiptsByCwd.get(actualCwd)?.get(testReceiptKey(identity));
      },
    });

    await expect(evaluator(context(cwd))).rejects.toThrow(
      /requires current durable StepVerifier state/u,
    );
  });

  it("rejects accepted formal gates whose Evidence refs are not durable", async () => {
    const cwd = await workspace();
    await writeSummary(cwd, strictCompleteSummaryInput());

    await expect(reproCompletionEvaluator(context(cwd))).rejects.toThrow(
      /Repro completion evidence not found: evidence:contract-frozen/u,
    );
  });

  it("rejects missing Matrix Evidence even when gate receipts exist", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    input.validationMatrix!.rows[0]!.evidenceRefs.push("evidence:matrix-only" as EvidenceRef);
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    await expect(reproCompletionEvaluator(context(cwd))).rejects.toThrow(
      /Repro completion evidence not found: evidence:matrix-only/u,
    );
  });

  it("rejects missing retirement Evidence even when formal gate receipts exist", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    await persistAcceptedFormalEvidence(cwd, input);
    await writeSummary(cwd, input);

    await expect(reproCompletionEvaluator(context(cwd))).rejects.toThrow(
      /Repro completion evidence not found: evidence:retirement-S1/u,
    );
  });

  it("rejects missing unresolved-discharge Evidence", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    input.unresolved = [
      {
        id: "u-discharge",
        kind: "mismatch",
        owner: "repro-owner",
        impact: "A prior mismatch required formal discharge",
        reversible: true,
        rollback: "Restore the prior exact path",
        dischargeCriterion: "Current entrypoint receipt passes",
        status: "discharged",
        completionRequired: true,
        planRevision: 1,
        ownerStepId: "S1",
        stepDefinitionDigest: "digest:S1",
        evidenceRefs: ["evidence:unresolved-discharge" as EvidenceRef],
      },
    ];
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    await expect(reproCompletionEvaluator(context(cwd))).rejects.toThrow(
      /Repro completion evidence not found: evidence:unresolved-discharge/u,
    );
  });

  it("accepts strict completion only after gate, Matrix, and retirement Evidence resolve", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    await persistAcceptedFormalEvidence(cwd, input);
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    await expect(reproCompletionEvaluator(context(cwd))).resolves.toMatchObject({
      verdict: "achieved",
    });
  });

  it("rejects formal completion when an owning-entrypoint receipt is stale", async () => {
    const cwd = await workspace();
    const input = strictCompleteSummaryInput();
    await persistAcceptedFormalEvidence(cwd, input);
    const row = input.validationMatrix!.rows.find(
      (candidate) => candidate.evidenceClass === "entrypoint",
    );
    if (!row?.ownerStepId) throw new Error("missing formal receipt fixture");
    const evidenceRef = row.evidenceRefs[0]!;
    const receiptEntry = [...(receiptsByCwd.get(cwd)?.entries() ?? [])].find(
      ([, candidate]) =>
        candidate.reproId === input.reproId &&
        candidate.requirementId === row.gateId &&
        candidate.stepId === row.ownerStepId &&
        candidate.evidenceRef === evidenceRef,
    );
    if (!receiptEntry) throw new Error("missing formal receipt fixture");
    const [key, receipt] = receiptEntry;
    receiptsByCwd.get(cwd)!.set(key, { ...receipt, stale: true });
    await persistEvidenceRefs(cwd, ["evidence:retirement-S1" as EvidenceRef]);
    await writeSummary(cwd, input);

    await expect(reproCompletionEvaluator(context(cwd))).rejects.toThrow(
      /formal Evidence receipt is not current and accepted/u,
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
  const refs = [
    ...new Set(
      input.gates
        .filter((gate) => gate.evidenceClass === "formal" && gate.status === "accepted")
        .flatMap((gate) => gate.evidenceRefs),
    ),
  ];
  const formalRows =
    input.validationMatrix?.rows.filter(
      (row) => row.evidenceClass === "entrypoint" && row.invocationClass === "owning_entrypoint",
    ) ?? [];
  await persistEvidenceRefs(cwd, refs);
  const store = defaultEvidenceStore(cwd);
  const receipts = receiptsByCwd.get(cwd) ?? new Map();
  receiptsByCwd.set(cwd, receipts);
  for (const row of formalRows) {
    const stepId = row.ownerStepId;
    if (!stepId) continue;
    for (const evidenceRef of row.evidenceRefs) {
      const evidence = await store.tryGet(evidenceRef);
      if (!evidence) continue;
      if (!evidence.hash) throw new Error(`missing Evidence hash: ${evidenceRef}`);
      const receipt: SparkReproFormalEvidenceReceipt = {
        schema: "spark.repro.formal-evidence-receipt/v1",
        workspaceCwd: cwd,
        evidenceRef,
        evidenceHash: evidence.hash,
        reproId: input.reproId,
        requirementId: row.gateId,
        stepId,
        planRevision: 1,
        stepDefinitionDigest: "digest:S1",
        invocationClass: "owning_entrypoint",
        evidenceClass: "entrypoint",
        profileDigest: sparkReproProfileDigest(input.target.acceptanceProfile ?? input.profile),
        topologyDigest: sparkReproTopologyDigest(input.target.validationTopology),
        verifierId: "test-verifier",
        verifierVersion: "1",
        verdict: "accepted",
        verifiedAt: new Date().toISOString(),
        stale: false,
        superseded: false,
      };
      receipts.set(testReceiptKey(receipt), receipt);
    }
  }
}

async function persistEvidenceRefs(cwd: string, refs: EvidenceRef[]): Promise<void> {
  const store = defaultEvidenceStore(cwd);
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

function testReceiptKey(
  receipt: Pick<
    SparkReproFormalEvidenceReceipt,
    | "reproId"
    | "requirementId"
    | "stepId"
    | "evidenceRef"
    | "evidenceHash"
    | "planRevision"
    | "stepDefinitionDigest"
    | "profileDigest"
    | "topologyDigest"
  >,
): string {
  return JSON.stringify({
    reproId: receipt.reproId,
    requirementId: receipt.requirementId,
    stepId: receipt.stepId,
    evidenceRef: receipt.evidenceRef,
    evidenceHash: receipt.evidenceHash,
    planRevision: receipt.planRevision,
    stepDefinitionDigest: receipt.stepDefinitionDigest,
    profileDigest: receipt.profileDigest,
    topologyDigest: receipt.topologyDigest,
  });
}

function completionEvaluator(
  context: SparkLoopEvaluationContext,
  options: {
    includeS2?: boolean;
    effectiveS1Revision?: number;
    currentRevision?: number;
    extraS1EvidenceRef?: EvidenceRef;
    currentTaskStatus?: string;
    duplicateDurableTaskBinding?: boolean;
  } = {},
) {
  return createReproCompletionEvaluator(
    {
      get(cwd, identity) {
        return receiptsByCwd.get(cwd)?.get(testReceiptKey(identity));
      },
    },
    async (cwd) => ({
      reproId: "repro-1",
      dualLane: {
        planRevision: options.currentRevision ?? 1,
        normative: {
          orderedStepIds: options.includeS2 ? ["S1", "S2"] : ["S1"],
          retiredStepIds: options.includeS2 ? ["S1", "S2"] : ["S1"],
        },
      },
      subgoals: [
        {
          id: "S1",
          planRevision: options.effectiveS1Revision ?? 1,
          taskRef: "task:delivery",
        },
        ...(options.includeS2 ? [{ id: "S2", planRevision: 1 }] : []),
        ...(options.duplicateDurableTaskBinding
          ? [{ id: "S-extra", planRevision: 1, taskRef: "task:delivery" }]
          : []),
      ],
      taskStatusByRef: { "task:delivery": options.currentTaskStatus ?? "done" },
      plan: {
        currentRevision: options.currentRevision ?? 1,
        steps: [
          {
            id: "S1",
            status: "done",
            authority: "safe_local",
            doneWhen: ["S1 passed"],
            evidenceRefs: [
              ...[...(receiptsByCwd.get(cwd)?.values() ?? [])].map(
                (receipt) => receipt.evidenceRef as EvidenceRef,
              ),
              "evidence:retirement-S1" as EvidenceRef,
              ...(options.extraS1EvidenceRef ? [options.extraS1EvidenceRef] : []),
            ],
            verification: {
              verdict: "Pass",
              stepId: "S1",
              planRevision: options.effectiveS1Revision ?? 1,
              definitionDigest: "digest:S1",
              proofKind: "evidence",
              evidenceRefs: [
                ...[...(receiptsByCwd.get(cwd)?.values() ?? [])].map(
                  (receipt) => receipt.evidenceRef as EvidenceRef,
                ),
                "evidence:retirement-S1" as EvidenceRef,
                ...(options.extraS1EvidenceRef ? [options.extraS1EvidenceRef] : []),
              ],
              verifiedDoneWhen: ["S1 passed"],
            },
          },
          ...(options.includeS2
            ? [
                {
                  id: "S2",
                  status: "done",
                  authority: "safe_local",
                  doneWhen: ["S2 passed"],
                  evidenceRefs: ["evidence:retirement-S2" as EvidenceRef],
                },
              ]
            : []),
        ],
      },
    }),
  )(context);
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

function strictCompleteSummaryInput(): SparkReproWorkSummaryInput {
  const topology = {
    dp: 1,
    tp: 1,
    pp: 2,
    ep: 4,
    etp: 1,
    cp: 1,
    sp: false,
    worldSize: 8,
    strategies: [
      {
        axis: "pp" as const,
        id: "official-pipeline",
        source: "official" as const,
        revision: "r1",
        configDigest: "sha256:pp",
      },
      {
        axis: "ep" as const,
        id: "reference-expert",
        source: "reference" as const,
        revision: "r2",
        configDigest: "sha256:ep",
      },
    ],
  };
  const profile: SparkReproProfile = {
    id: "acceptance",
    model: "minimum_complete",
    compute: "optimizer",
    modelScope: "minimum_complete",
    computeScope: "optimizer",
    steps: { completed: 100, target: 100 },
    topology: structuredClone(topology),
    validationTopology: structuredClone(topology),
    runtime: {
      framework: "paddle",
      device: "gpu",
      dtype: "bf16",
      hardware: "h800",
      modelRevision: "r1",
      configDigest: "sha256:model",
    },
  };
  const gates = [
    formalGate("contract-frozen", "contract", "accepted"),
    {
      ...formalGate("reference-ready", "reference", "accepted", profile),
      establishes: ["reference_ready" as const],
    },
    {
      ...formalGate("target-ready", "target", "accepted", profile),
      establishes: ["target_ready" as const],
    },
    {
      ...formalGate("alignment", "alignment", "accepted", profile),
      establishes: ["required_steps_aligned" as const, "reference_parity" as const],
    },
    formalGate("delivery", "delivery", "accepted"),
  ];
  const candidate = {
    id: "candidate-S1",
    stepId: "S1",
    dependsOn: [],
    planRevision: 1,
    stepDefinitionDigest: "digest:S1",
    verdict: "accepted" as const,
    profile,
    evidenceRefs: [
      ...gates.flatMap((gate) => gate.evidenceRefs),
      "evidence:retirement-S1" as EvidenceRef,
    ],
    unresolvedIds: [],
  };
  return {
    schema: "spark.repro.work-summary/v2",
    reproId: "repro-1",
    title: "Strict complete Repro",
    stage: "delivery",
    target: {
      model: "minimum_complete",
      requiredSteps: 100,
      referenceStrategies: ["pp", "ep"],
      validationTopology: structuredClone(topology),
      acceptanceProfile: profile,
    },
    profile,
    gates,
    validationMatrix: {
      denominators: { contract: 1, reference: 1, target: 1, alignment: 1, delivery: 1 },
      rows: gates.map((gate) => ({
        id: `entrypoint:${gate.id}`,
        gateId: gate.id,
        stage: gate.stage,
        invocationClass: "owning_entrypoint",
        evidenceClass: "entrypoint",
        ownerStepId: "S1",
        verdict: "accepted",
        profile,
        repetitions: 1,
        exactScope: "frozen acceptance entrypoint",
        evidenceRefs: [...gate.evidenceRefs],
        artifactRefs: [],
      })),
    },
    exploreFrontier: {
      stage: "delivery",
      profile,
      planRevision: 1,
      observationId: "observation-S1",
      ownerStepId: "S1",
      stepDefinitionDigest: "digest:S1",
      evidenceRefs: ["evidence:observation-S1" as EvidenceRef],
      unresolvedIds: [],
    },
    normativeCursor: {
      planRevision: 1,
      orderedStepIds: ["S1"],
      stepDefinitionDigests: { S1: "digest:S1" },
      stepDependencies: { S1: [] },
      retiredStepIds: ["S1"],
      candidateBuffer: [candidate],
      retirementLog: [
        {
          stepId: "S1",
          candidateId: candidate.id,
          planRevision: 1,
          stepDefinitionDigest: "digest:S1",
          profile,
          profileDigest: sparkReproProfileDigest(profile),
          evidenceRefs: [...candidate.evidenceRefs],
        },
      ],
    },
    schedulerActivity: "sealed",
    independentReadyCount: 0,
    tasks: [
      {
        id: "delivery-task",
        taskRef: "task:delivery" as TaskRef,
        title: "Deliver Repro",
        stage: "delivery",
        status: "done",
      },
    ],
    retirementBlocks: [],
    unresolved: [],
    nextAction: {
      id: "sealed",
      summary: "No further action",
      passCriterion: "The run remains sealed",
    },
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
