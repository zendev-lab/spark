import { createHash } from "node:crypto";

import type { ArtifactRef } from "@zendev-lab/spark-core";
import type { SparkGoalContract } from "@zendev-lab/spark-loop";
import type { SparkLoopView } from "@zendev-lab/spark-protocol/interaction";
import type { SparkWorkbenchActionId } from "@zendev-lab/spark-protocol/presentation";
import type { SparkTokenUsageAggregate } from "@zendev-lab/spark-protocol/domain";

import { SPARK_REPRO_WORK_STAGES, type SparkReproWorkSummary } from "./work-summary.ts";

const BASIC_CATALOG = "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json";

export type SparkReproWorkbenchCheckpointKind = "stage" | "final" | "manual";

/** Typed immutable checkpoint input; comparison never parses rendered A2UI. */
export interface SparkReproWorkbenchCheckpoint {
  checkpointId: string;
  kind: SparkReproWorkbenchCheckpointKind;
  stage: SparkReproWorkSummary["stage"];
  artifactRef: ArtifactRef;
  revision: number;
  hash: string;
  createdAt: string;
  work: SparkReproWorkSummary;
}

export interface SparkReproWorkbenchProjectionInput {
  work: SparkReproWorkSummary;
  goalContract: SparkGoalContract;
  loop: SparkLoopView;
  artifactRef: ArtifactRef;
  revision: number;
  lifecycle: "live" | "sealed";
  tokenUsage?: SparkTokenUsageAggregate;
  checkpoints?: SparkReproWorkbenchCheckpoint[];
}

export function sparkReproWorkbenchArtifactRef(reproId: string): ArtifactRef {
  return stableArtifactRef("spark.repro.workbench/v1", reproId);
}

export function sparkReproWorkbenchCheckpointArtifactRef(
  reproId: string,
  checkpointId: string,
): ArtifactRef {
  return stableArtifactRef("spark.repro.workbench-checkpoint/v1", `${reproId}\0${checkpointId}`);
}

/** Stable source digest used to avoid self-triggering revision churn. */
export function sparkReproWorkbenchProjectionDigest(
  input: Omit<SparkReproWorkbenchProjectionInput, "revision">,
): string {
  return sha256(JSON.stringify(input));
}

/** Deterministic A2UI v0.9.1 projection of typed Repro/Goal/Loop facts. */
export function renderSparkReproWorkbenchA2ui(input: SparkReproWorkbenchProjectionInput): string {
  assertProjectionBinding(input);
  const surfaceId = `spark-repro-${safeId(input.work.reproId)}`;
  const controls = workbenchControls(input);
  const components: Array<Record<string, unknown>> = [
    {
      id: "root",
      component: "Column",
      children: ["heading", "status", ...controls.ids, "tabs"],
    },
    { id: "heading", component: "Text", variant: "h1", text: input.work.title },
    {
      id: "status",
      component: "Text",
      text: `**${input.work.status}** · ${input.work.stage} · ${formatProgress(input.work.progress)} · Loop ${input.loop.status}`,
    },
    {
      id: "tabs",
      component: "Tabs",
      tabs: [
        { title: "Overview", child: "overview" },
        { title: "Plan", child: "plan" },
        { title: "Experiments / Coverage", child: "coverage" },
        { title: "History / Compare", child: "history" },
        { title: "Delivery", child: "delivery" },
      ],
    },
    { id: "overview", component: "Card", child: "overview-text" },
    { id: "overview-text", component: "Text", text: overviewMarkdown(input) },
    { id: "plan", component: "Card", child: "plan-text" },
    { id: "plan-text", component: "Text", text: planMarkdown(input) },
    { id: "coverage", component: "Card", child: "coverage-text" },
    { id: "coverage-text", component: "Text", text: coverageMarkdown(input) },
    { id: "history", component: "Card", child: "history-text" },
    { id: "history-text", component: "Text", text: historyMarkdown(input) },
    { id: "delivery", component: "Card", child: "delivery-text" },
    { id: "delivery-text", component: "Text", text: deliveryMarkdown(input) },
    ...controls.components,
  ];

  return `${JSON.stringify(
    {
      messages: [
        {
          version: "v0.9.1",
          createSurface: { surfaceId, catalogId: BASIC_CATALOG, sendDataModel: false },
        },
        { version: "v0.9.1", updateComponents: { surfaceId, components } },
        {
          version: "v0.9.1",
          updateDataModel: {
            surfaceId,
            path: "/",
            value: {
              schema: "spark.repro.workbench/v1",
              reproId: input.work.reproId,
              artifactRef: input.artifactRef,
              revision: input.revision,
              lifecycle: input.lifecycle,
              loopId: input.loop.loopId,
              generation: input.loop.generation,
            },
          },
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function workbenchControls(input: SparkReproWorkbenchProjectionInput): {
  ids: string[];
  components: Array<Record<string, unknown>>;
} {
  if (input.lifecycle === "sealed" || ["completed", "stopped"].includes(input.loop.status)) {
    return { ids: [], components: [] };
  }
  const actions: SparkWorkbenchActionId[] = [];
  if (["scheduled", "running", "retry_wait", "dormant"].includes(input.loop.status)) {
    actions.push("pause");
  }
  if (["paused", "blocked"].includes(input.loop.status)) actions.push("resume");
  if (["scheduled", "dormant", "paused"].includes(input.loop.status)) actions.push("run_now");
  if (["retry_wait", "blocked"].includes(input.loop.status)) actions.push("retry_checkpoint");
  actions.push("stop");

  const ids = actions.map((actionId) => `control-${actionId}`);
  const components = actions.flatMap((actionId) => {
    const componentId = `control-${actionId}`;
    const labelId = `${componentId}-label`;
    const context = {
      actionId,
      artifactRef: input.artifactRef,
      revision: input.revision,
      loopId: input.loop.loopId,
      generation: input.loop.generation,
      idempotencyKey: sha256(
        `${input.artifactRef}\0${input.revision}\0${input.loop.generation}\0${actionId}`,
      ),
      ...(actionId === "stop" ? { confirm: true } : {}),
    };
    return [
      { id: labelId, component: "Text", text: actionLabel(actionId) },
      {
        id: componentId,
        component: "Button",
        child: labelId,
        action: { event: { name: "spark.loop.control", context } },
      },
    ];
  });
  return { ids, components };
}

function overviewMarkdown(input: SparkReproWorkbenchProjectionInput): string {
  const checkpoint = input.loop.checkpoint;
  return [
    "## Goal Contract",
    `- Status: ${input.goalContract.status}`,
    `- Objective: ${input.goalContract.objective}`,
    `- Success criteria: ${listInline(input.goalContract.successCriteria)}`,
    `- Evidence required: ${listInline(input.goalContract.evidenceRequired)}`,
    "",
    "## Loop",
    `- Status: ${input.loop.status}`,
    `- Cycle checkpoint: ${checkpoint ? `${checkpoint.step} (${checkpoint.cycleId})` : "none"}`,
    `- Generation: ${input.loop.generation}`,
    `- Next trigger: ${input.loop.dueAt ?? "not scheduled"}`,
    `- Ticks / skips / avoided LLM requests: ${input.loop.counters.tickCount} / ${input.loop.counters.skippedCount} / ${input.loop.counters.llmRequestsAvoided}`,
    `- Token usage: ${input.tokenUsage ? `${input.tokenUsage.totalTokens} (${input.tokenUsage.quality})` : "unavailable"}`,
  ].join("\n");
}

function planMarkdown(input: SparkReproWorkbenchProjectionInput): string {
  const currentIndex = SPARK_REPRO_WORK_STAGES.indexOf(input.work.stage);
  const stages = SPARK_REPRO_WORK_STAGES.map((stage, index) => {
    const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "pending";
    return `- ${stage}: ${state}`;
  });
  const tasks = input.work.tasks.map(
    (task) => `- [${task.status === "done" ? "x" : " "}] ${task.title} (${task.status})`,
  );
  return [
    "## Workflow stages",
    ...stages,
    "",
    "## Tasks",
    ...(tasks.length ? tasks : ["- none"]),
  ].join("\n");
}

function coverageMarkdown(input: SparkReproWorkbenchProjectionInput): string {
  const gates = input.work.gates.map(
    (gate) =>
      `- ${gate.title}: ${gate.status} · ${gate.evidenceClass} · Evidence ${gate.evidenceRefs.length}`,
  );
  const conclusions = input.work.conclusions.map(
    (conclusion) => `- ${conclusion.verdict}: ${conclusion.claim}`,
  );
  const profile = input.work.profile;
  return [
    "## Profile",
    `- ${profile.id}: ${profile.model}/${profile.compute}; steps ${profile.steps.completed}/${profile.steps.target}`,
    `- topology: dp=${profile.topology.dp} tp=${profile.topology.tp} pp=${profile.topology.pp} ep=${profile.topology.ep} cp=${profile.topology.cp} sp=${profile.topology.sp}`,
    "",
    `## Gates (${formatProgress(input.work.progress)})`,
    ...(gates.length ? gates : ["- none"]),
    "",
    "## Claims",
    ...(conclusions.length ? conclusions : ["- none"]),
  ].join("\n");
}

function historyMarkdown(input: SparkReproWorkbenchProjectionInput): string {
  const receipts = input.loop.checkpoint?.receipts.map(
    (receipt) =>
      `- ${receipt.evaluatedAt}: ${receipt.checkpoint}/${receipt.selector} → ${receipt.verdict} (${receipt.reason})`,
  );
  const checkpoints = (input.checkpoints ?? []).map(
    (checkpoint) =>
      `- ${checkpoint.createdAt}: ${checkpoint.kind}/${checkpoint.stage} · ${checkpoint.artifactRef} r${checkpoint.revision}`,
  );
  return [
    "## Current cycle",
    ...(receipts?.length ? receipts : ["- no condition receipts"]),
    "",
    "## Sealed checkpoints",
    ...(checkpoints.length ? checkpoints : ["- none"]),
  ].join("\n");
}

function deliveryMarkdown(input: SparkReproWorkbenchProjectionInput): string {
  const refs = [...new Set([input.work.reportArtifactRef, ...input.work.artifactRefs])].filter(
    (ref): ref is ArtifactRef => Boolean(ref),
  );
  const accepted = input.work.gates.filter((gate) => gate.status === "accepted").length;
  return [
    "## Delivery",
    `- Report: ${input.work.reportArtifactRef ?? "not bound"}`,
    `- Artifact links: ${refs.length ? refs.join(", ") : "none"}`,
    `- Formal gates: ${accepted}/${input.work.gates.length} accepted`,
    `- Technical goal: ${input.work.technicalGoal.achieved ? "achieved" : "not achieved"}`,
    `- Close gate: ${input.work.status === "complete" ? "ready" : "blocked"}`,
  ].join("\n");
}

function assertProjectionBinding(input: SparkReproWorkbenchProjectionInput): void {
  if (input.loop.binding.reproId !== input.work.reproId) {
    throw new Error("Workbench Loop binding does not match Repro work summary");
  }
  if (input.goalContract.objective.trim() === "")
    throw new Error("Goal Contract objective is required");
  if (input.revision < 1 || !Number.isInteger(input.revision)) {
    throw new Error("Workbench revision must be a positive integer");
  }
}

function formatProgress(progress: SparkReproWorkSummary["progress"]): string {
  return progress.quantified ? `${progress.percent}%` : "unquantified";
}

function actionLabel(action: SparkWorkbenchActionId): string {
  return {
    pause: "Pause",
    resume: "Resume",
    run_now: "Run now",
    retry_checkpoint: "Retry checkpoint",
    stop: "Stop",
  }[action];
}

function listInline(values: string[]): string {
  return values.length ? values.join("; ") : "none";
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableArtifactRef(namespace: string, identity: string): ArtifactRef {
  const normalized = identity.trim();
  if (!normalized) throw new Error("Workbench Artifact identity is required");
  return `artifact:repro-workbench-${sha256(`${namespace}\0${normalized}`).slice(0, 32)}` as ArtifactRef;
}
