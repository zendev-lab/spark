import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import {
  sparkEvidenceAnswerEventSchema,
  sparkLoopCountersSchema,
  sparkLoopPolicySchema,
} from "@zendev-lab/spark-protocol";

import { defaultProjectRoleModelSettingsStore, RoleRegistry } from "@zendev-lab/spark-roles";
import { registerSparkRolesTools } from "@zendev-lab/spark-roles/extension";
import { registerSparkSessionTool } from "@zendev-lab/spark-session/extension";
import {
  newRef,
  stableId,
  type AskRef,
  type EvidenceRef,
  type SparkHostLoopContext,
  type ExtensionRoleRunRequest,
  type ExtensionRoleRunResult,
  type ExtensionRoleRunStatus,
  type ExtensionRoleRunner,
  type ExtensionInteractionRequest,
  type ExtensionInteractionResponse,
  type RoleRef,
  type RunRef,
  type SubgoalRef,
  type TaskPlan,
  type TaskRef,
  type ProjectRef,
} from "@zendev-lab/spark-core";
import {
  defaultArtifactStore,
  defaultEvidenceStore,
  type ArtifactRef,
} from "@zendev-lab/spark-artifacts";
import { defaultLearningStore } from "@zendev-lab/spark-memory";
import { defaultWorkflowRunStore } from "@zendev-lab/spark-workflows";
import { registerSparkWorkflowTool } from "@zendev-lab/spark-workflows/extension";
import {
  killActiveSparkRoleRunProcesses,
  listActiveSparkRoleRunProcesses,
  runSparkTask,
} from "@zendev-lab/spark-runtime";
import {
  defaultTaskGraphStore,
  defaultTaskTodoStore,
  decideTaskPlanBeforeCreate,
  isActiveSessionTodo,
  renderTaskPlanReadinessRules,
  TaskGraph,
  TaskGraphStore,
} from "@zendev-lab/spark-tasks";
import { registerSparkEvidenceTool } from "@zendev-lab/spark-artifacts/extension";
import { registerSparkMemoryTool } from "@zendev-lab/spark-memory/extension";
import { recordCanonicalAnswerEventEvidenceReceipt } from "@zendev-lab/spark-ask";
import piAskExtension from "@zendev-lab/spark-ask/extension";
import sparkExtension from "../extension/index.ts";
import { SparkWorkflowRunManagerController } from "../extension/spark-workflow-run-manager.ts";
import { registerSparkReproTool } from "../extension/spark-repro-tool-registration.ts";
import { materializeReproStagePlan } from "../extension/spark-repro-project.ts";
import { REPRO_STAGE_BLUEPRINTS } from "../extension/spark-repro-stage-blueprints.ts";
import { collectReproOrchestrationSnapshot } from "../extension/spark-repro-orchestration.ts";
import { JsonStoreFormatError } from "../extension/json-store.ts";
import type { SparkToolContext } from "../extension/spark-tool-registration.ts";
import type { SparkDaemonLoopControl } from "../extension/spark-daemon-loop-client.ts";
import type { SparkDaemonUsageControl } from "../extension/spark-daemon-usage-client.ts";
import type { SparkTaskClaimDaemonClient } from "../extension/spark-task-claim-daemon-client.ts";
import {
  loadCurrentProjectState,
  loadHiddenRoleRunInboxState,
  loadSparkMode,
  saveCurrentProjectRef,
  sparkSessionKey,
} from "../extension/session-state.ts";
import {
  assignTodoDisplayNumber,
  importLegacyIndependentTodos,
  loadIndependentTodos,
  loadTodoDisplayNumberState,
  saveIndependentTodos,
  saveTodoDisplayNumberState,
} from "../extension/session-todos.ts";
import { renderSessionTodoContext } from "../extension/spark-session-todo-context.ts";
import {
  normalizeSparkStatusFormat,
  normalizeSparkStatusLimit,
  normalizeSparkStatusView,
} from "../extension/spark-status.ts";
import {
  normalizeForceAfterMs,
  normalizeKillSignal,
  normalizeOptionalProjectRef,
  normalizeOptionalRunRef,
  normalizeSparkBackgroundAction,
  normalizeSparkBackgroundBoolean,
} from "../extension/background-runs.ts";
import {
  normalizeSparkRunReadyTasksBoolean,
  normalizeSparkRunReadyTasksPositiveInteger,
} from "../extension/spark-run-ready-tasks-tool-registration.ts";
import { normalizeSparkPlanTaskInputs } from "../extension/spark-plan-tasks-tool-registration.ts";
import { collectReproExperimentIssues } from "../extension/spark-repro-experiment-lint.ts";
import { normalizeSparkClaimTaskInput } from "../extension/spark-claim-task-tool-registration.ts";
import {
  buildTaskReviewEvidenceContext,
  normalizeSparkFinishTaskInput,
} from "../extension/spark-finish-task-tool-registration.ts";
import {
  quarantineLegacyArtifactSubjectReviews,
  rebuildSubjectReviewIndex,
  rebuildWorkspaceReviewIndex,
  subjectReviewRecordPath,
  taskReviewDirectory,
} from "../extension/subject-review-store.ts";
import { normalizeSparkTodoOps } from "../extension/spark-todo-tool-registration.ts";
import {
  normalizeEvidenceBoolean,
  normalizeEvidenceLimit,
  normalizeEvidenceRef,
  normalizePositiveInteger,
} from "../extension/evidence-tools.ts";
import {
  normalizeLearningBoolean,
  normalizeLearningCategory,
  normalizeLearningConfidence,
  normalizeLearningInput,
  normalizeLearningLocation,
  normalizeLearningStatusFilter,
  normalizeStringArray,
} from "../extension/learning-tools.ts";
import {
  normalizeSparkWorkflowRunsAction,
  normalizeSparkWorkflowRunsBoolean,
  normalizeSparkWorkflowRunsNonNegativeInteger,
  normalizeSparkWorkflowRunsRunRef,
} from "../extension/spark-workflow-runs-tool-registration.ts";
import { defaultSparkDynamicWorkflowEventStore } from "@zendev-lab/spark-workflows";
import {
  normalizeSparkNewProjectInput,
  normalizeSparkProjectOptionalString,
  normalizeSparkProjectOutputLanguage,
  normalizeSparkProjectPatch,
} from "../extension/spark-project-tools.ts";
import {
  normalizeSparkStateAction,
  normalizeSparkStateOptionalString,
} from "../extension/spark-state-tool-registration.ts";
import { normalizeTaskKind, normalizeTaskStatus } from "../extension/task-plan-tool.ts";
import { normalizeSparkAskReplayEvidenceRef } from "../extension/spark-ask-tool-registration.ts";
import {
  readSessionRepro,
  sessionReproStorePath,
  writeSessionRepro,
} from "../extension/spark-session-repro.ts";
import {
  createReproStepAskBinding,
  createSparkSessionRepro,
  encodeReproStepAskBinding,
  reproStepPlanRevision,
  stepDefinitionDigest,
  updateReproStep,
} from "@zendev-lab/spark-repro";
import {
  SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
  type SparkReproWorkSummaryInput,
} from "@zendev-lab/spark-repro/work-summary";
import {
  inferSessionGoalObjective,
  loadSessionGoal,
  loadSessionLoop,
  sessionGoalStorePath,
  setSessionGoal,
  setSessionLoop,
  updateSessionGoalStatus,
} from "@zendev-lab/spark-loop";
import type {
  ReviewInput,
  ReviewerRunResult,
  ReviewerRunner,
} from "@zendev-lab/spark-roles/reviewer-runner";

type SparkHostApiForTest = Parameters<typeof sparkExtension>[0];
type SparkToolConfig = Parameters<NonNullable<SparkHostApiForTest["registerTool"]>>[0];
type SparkToolResult = Awaited<ReturnType<SparkToolConfig["execute"]>>;
const evidenceSurfaceNegativeValues = JSON.parse(
  readFileSync(
    join(process.cwd(), "test", "fixtures", "evidence-surface", "negative-values.json"),
    "utf8",
  ),
) as { wrongNamespaceRef: string; wrongKind: string };
type LegacyEvidenceFixture<T> = {
  legacyFieldNames: string[];
  value: T;
};
type TestNotification = { message: string; level?: "info" | "warning" | "error" | "success" };

async function loadLegacyEvidenceFixture<T>(
  name: string,
  replacements: Record<string, string> = {},
): Promise<T> {
  const fixturePath = join(process.cwd(), "test", "fixtures", "legacy-evidence", name);
  let source = await readFile(fixturePath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    source = source.replaceAll(`__${key}__`, value);
  }
  return JSON.parse(source) as T;
}

function quotedJsonField(field: string): RegExp {
  return new RegExp(`"${field.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
}
type TestSparkDaemonLoopControl = SparkDaemonLoopControl & {
  loops: Map<string, Awaited<ReturnType<SparkDaemonLoopControl["start"]>>["loop"]>;
  ensuredOwners: Array<{ sessionId: string; cwd: string }>;
  startInputs: Parameters<SparkDaemonLoopControl["start"]>[0][];
};

function executionReadyPlan(objective: string): TaskPlan {
  return {
    objective,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`Validation command for ${objective} passes with exit code 0.`],
    evidenceRequired: [
      `Validation evidence records command output, exit code, and changed-file summary for ${objective}.`,
    ],
    steps: [objective],
    riskLevel: "normal",
    openQuestions: [],
    askRefs: [],
  };
}

function successfulFinishEvidence(title: string) {
  return {
    title,
    notes: "Focused validation passed with exit code 0.",
    validationCommands: ["pnpm test — pass"],
  };
}

type NormalizerAcceptCase = [actual: () => unknown, expected: unknown];
type NormalizerRejectCase = [actual: () => unknown, error: RegExp];

function runNormalizerGroup(
  name: string,
  accepts: NormalizerAcceptCase[],
  rejects: NormalizerRejectCase[],
): void {
  accepts.forEach(([actual, expected], index) => {
    assert.deepEqual(actual(), expected, name + " accepted case " + index);
  });
  rejects.forEach(([actual, error], index) => {
    assert.throws(actual, error, name + " rejected case " + index);
  });
}

const workflowRunActionError =
  /action must be status, list, inspect, pause, resume, stop, restart, save, kill, reply, steer, reconcile, ack, prune, clear_inactive, or kill_active/;

test("Spark tool normalizer groups reject invalid explicit parameters instead of using defaults", () => {
  runNormalizerGroup(
    "status",
    [
      [() => normalizeSparkStatusView({}), "active"],
      [() => normalizeSparkStatusFormat({}), "text"],
      [() => normalizeSparkStatusLimit({}), undefined],
    ],
    [
      [() => normalizeSparkStatusView({ view: "compact" }), /view must be active/],
      [() => normalizeSparkStatusFormat({ format: "yaml" }), /format must be text or json/],
      [() => normalizeSparkStatusLimit({ limit: "20" }), /limit must be a finite number/],
      [() => normalizeSparkStatusLimit({ limit: 1.5 }), /limit must be a non-negative integer/],
    ],
  );

  runNormalizerGroup(
    "background runs",
    [
      [() => normalizeSparkBackgroundAction(undefined), "status"],
      [() => normalizeSparkBackgroundAction("kill"), "kill"],
      [() => normalizeSparkBackgroundAction("pause"), "pause"],
      [() => normalizeOptionalRunRef(" run:child "), "run:child"],
      [() => normalizeOptionalProjectRef(" proj:main "), "proj:main"],
      [() => normalizeKillSignal("sigkill"), "SIGKILL"],
      [() => normalizeForceAfterMs(0), 0],
      [() => normalizeSparkBackgroundBoolean(undefined, false, "field"), false],
    ],
    [
      [() => normalizeSparkBackgroundAction("cancel"), workflowRunActionError],
      [() => normalizeOptionalRunRef("child"), /runRef must be a run ref/],
      [() => normalizeOptionalRunRef(123), /runRef must be a string/],
      [() => normalizeOptionalProjectRef("project"), /projectRef must be a project ref/],
      [() => normalizeKillSignal("TERM"), /signal must be one of/],
      [() => normalizeForceAfterMs("0"), /forceAfterMs must be a finite number/],
      [() => normalizeForceAfterMs(1.5), /forceAfterMs must be a non-negative integer/],
      [
        () => normalizeSparkBackgroundBoolean("true", false, "includeHistory"),
        /includeHistory must be a boolean/,
      ],
    ],
  );

  runNormalizerGroup(
    "ready-task runner",
    [
      [() => normalizeSparkRunReadyTasksBoolean(undefined, true, "dryRun"), true],
      [() => normalizeSparkRunReadyTasksBoolean(false, true, "dryRun"), false],
      [() => normalizeSparkRunReadyTasksPositiveInteger(undefined, 4, "maxConcurrency"), 4],
      [() => normalizeSparkRunReadyTasksPositiveInteger(2, 4, "maxConcurrency"), 2],
    ],
    [
      [
        () => normalizeSparkRunReadyTasksBoolean("false", true, "dryRun"),
        /dryRun must be a boolean/,
      ],
      [
        () => normalizeSparkRunReadyTasksPositiveInteger("2", 4, "maxConcurrency"),
        /maxConcurrency must be a finite number/,
      ],
      [
        () => normalizeSparkRunReadyTasksPositiveInteger(2.5, 4, "maxConcurrency"),
        /maxConcurrency must be a positive integer/,
      ],
      [
        () => normalizeSparkRunReadyTasksPositiveInteger(0, 4, "maxConcurrency"),
        /maxConcurrency must be a positive integer/,
      ],
    ],
  );

  runNormalizerGroup(
    "workflow runs",
    [
      [() => normalizeSparkWorkflowRunsAction(undefined), "status"],
      [() => normalizeSparkWorkflowRunsAction("prune"), "prune"],
      [() => normalizeSparkWorkflowRunsAction("restart"), "restart"],
      [() => normalizeSparkWorkflowRunsAction("save"), "save"],
      [() => normalizeSparkWorkflowRunsRunRef(undefined), undefined],
      [() => normalizeSparkWorkflowRunsRunRef("run:one"), "run:one"],
      [() => normalizeSparkWorkflowRunsBoolean(undefined, true, "dryRun"), true],
      [() => normalizeSparkWorkflowRunsBoolean(false, true, "dryRun"), false],
      [() => normalizeSparkWorkflowRunsNonNegativeInteger(undefined, 10, "keepRecent"), 10],
      [() => normalizeSparkWorkflowRunsNonNegativeInteger(0, 10, "keepRecent"), 0],
    ],
    [
      [() => normalizeSparkWorkflowRunsAction("acknowledge"), workflowRunActionError],
      [() => normalizeSparkWorkflowRunsAction(""), workflowRunActionError],
      [() => normalizeSparkWorkflowRunsRunRef("task:one"), /runRef must be a run ref/],
      [
        () => normalizeSparkWorkflowRunsBoolean("false", true, "dryRun"),
        /dryRun must be a boolean/,
      ],
      [
        () => normalizeSparkWorkflowRunsNonNegativeInteger("0", 10, "keepRecent"),
        /keepRecent must be a finite number/,
      ],
      [
        () => normalizeSparkWorkflowRunsNonNegativeInteger(1.5, 10, "keepRecent"),
        /keepRecent must be a non-negative integer/,
      ],
      [
        () => normalizeSparkWorkflowRunsNonNegativeInteger(-1, 10, "keepRecent"),
        /keepRecent must be a non-negative integer/,
      ],
    ],
  );

  runNormalizerGroup(
    "evidence",
    [
      [() => normalizeEvidenceLimit(undefined, 20), 20],
      [() => normalizeEvidenceLimit(0, 20), 0],
      [() => normalizeEvidenceLimit(12, 20), 12],
      [() => normalizePositiveInteger(undefined, 1, "thresholdBytes"), 1],
      [() => normalizePositiveInteger(8, 1, "thresholdBytes"), 8],
      [() => normalizeEvidenceBoolean(undefined, false, "dryRun"), false],
      [() => normalizeEvidenceBoolean(true, false, "dryRun"), true],
      [() => normalizeEvidenceRef("evidence:one"), "evidence:one"],
    ],
    [
      [() => normalizeEvidenceLimit("12", 20), /limit must be a finite number/],
      [() => normalizeEvidenceLimit(1.5, 20), /limit must be a non-negative integer/],
      [() => normalizeEvidenceLimit(-1, 20), /limit must be a non-negative integer/],
      [
        () => normalizePositiveInteger(0, 1, "thresholdBytes"),
        /thresholdBytes must be a positive integer/,
      ],
      [() => normalizeEvidenceBoolean("true", false, "dryRun"), /dryRun must be a boolean/],
      [
        () => normalizeEvidenceRef(evidenceSurfaceNegativeValues.wrongNamespaceRef),
        /evidenceRef must be an evidence: ref/,
      ],
    ],
  );

  runNormalizerGroup(
    "learnings",
    [
      [() => normalizeLearningStatusFilter(undefined), undefined],
      [() => normalizeLearningStatusFilter("active"), "active"],
      [() => normalizeLearningStatusFilter(["active", "candidate"]), ["active", "candidate"]],
      [() => normalizeLearningLocation("workspace"), "workspace"],
      [() => normalizeLearningLocation("repo"), "repo"],
      [() => normalizeLearningCategory("decision"), "decision"],
      [() => normalizeStringArray(["a", "b"], "tags"), ["a", "b"]],
      [() => normalizeLearningBoolean(undefined, false, "includeCandidates"), false],
      [() => normalizeLearningConfidence(undefined), undefined],
      [() => normalizeLearningConfidence(0.75), 0.75],
    ],
    [
      [() => normalizeLearningStatusFilter("archived"), /status must be candidate/],
      [() => normalizeLearningStatusFilter(["active", "archived"]), /status must be/],
      [() => normalizeLearningLocation("thread"), /location must be user/],
      [() => normalizeLearningCategory("lesson"), /category must be pattern/],
      [() => normalizeStringArray(["a", 1], "tags"), /tags must be a string array/],
      [
        () => normalizeLearningBoolean("true", false, "includeCandidates"),
        /includeCandidates must be a boolean/,
      ],
      [() => normalizeLearningConfidence(1.2), /confidence must be a finite number/],
      [
        () =>
          normalizeLearningInput({
            title: "Bad learning",
            statement: "Bad learning statement",
            tags: ["valid", 1],
          }),
        /tags must be a string array/,
      ],
    ],
  );

  runNormalizerGroup(
    "state",
    [
      [() => normalizeSparkStateAction(undefined), "state_status"],
      [() => normalizeSparkStateAction("role_run_evidence_compact"), "role_run_evidence_compact"],
      [() => normalizeSparkStateOptionalString(undefined, "exportDir"), undefined],
      [() => normalizeSparkStateOptionalString("exports", "exportDir"), "exports"],
    ],
    [
      [() => normalizeSparkStateAction("repair"), /action must be state_status/],
      [() => normalizeSparkStateAction(42), /action must be state_status/],
      [() => normalizeSparkStateOptionalString("", "exportDir"), /exportDir must be/],
      [() => normalizeSparkStateOptionalString(1, "exportDir"), /exportDir must be/],
    ],
  );

  runNormalizerGroup(
    "projects",
    [
      [() => normalizeSparkProjectOptionalString(undefined, "title"), undefined],
      [() => normalizeSparkProjectOptionalString(" Demo ", "title"), "Demo"],
      [() => normalizeSparkProjectOutputLanguage(undefined), undefined],
      [() => normalizeSparkProjectOutputLanguage("zh"), "zh"],
      [() => normalizeSparkProjectOutputLanguage(""), undefined],
      [
        () =>
          normalizeSparkProjectPatch({
            title: " Renamed ",
            purpose: " Ship v0 ",
          }),
        {
          title: "Renamed",
          description: undefined,
          purpose: "Ship v0",
          outputLanguage: undefined,
          kind: undefined,
          kindState: undefined,
        },
      ],
      [
        () =>
          normalizeSparkNewProjectInput({
            project: " Demo ",
            title: " Next ",
            purpose: " Ship v0 ",
          }),
        {
          project: "Demo",
          title: "Next",
          description: undefined,
          purpose: "Ship v0",
          outputLanguage: undefined,
          kind: undefined,
          kindState: undefined,
        },
      ],
      [
        () => normalizeSparkProjectPatch({ intent: "ignored extra field" }),
        {
          title: undefined,
          description: undefined,
          purpose: undefined,
          outputLanguage: undefined,
          kind: undefined,
          kindState: undefined,
        },
      ],
      [
        () => normalizeSparkProjectPatch({ kind: " generic ", kindState: { target: "demo" } }),
        {
          title: undefined,
          description: undefined,
          purpose: undefined,
          outputLanguage: undefined,
          kind: "generic",
          kindState: { target: "demo" },
        },
      ],
    ],
    [
      [() => normalizeSparkProjectOptionalString("", "title"), /title must be/],
      [() => normalizeSparkProjectOptionalString(1, "title"), /title must be/],
      [() => normalizeSparkProjectOutputLanguage("fr"), /outputLanguage must be zh or en/],
      [() => normalizeSparkProjectPatch({ title: "" }), /title must be/],
      [() => normalizeSparkProjectPatch({ outputLanguage: "jp" }), /outputLanguage/],
      [() => normalizeSparkProjectPatch({ kindState: () => undefined }), /kindState/],
      [() => normalizeSparkNewProjectInput({ project: "" }), /project must be/],
    ],
  );

  const taskInputs = normalizeSparkPlanTaskInputs(
    {
      tasks: [
        {
          name: " focused-task ",
          title: " Focused task ",
          description: " Implement the focused task. ",
          plan: {
            objective: " Ship focused task ",
            contextRefs: [" docs/plan.md "],
            successCriteria: [" command passes "],
            evidenceRequired: [" focused test output "],
            steps: [" implement ", " verify "],
            riskLevel: "high",
          },
        },
      ],
    },
    new RoleRegistry(),
  );
  assert.equal(taskInputs?.[0]?.name, "focused-task");
  assert.equal(taskInputs?.[0]?.title, "Focused task");
  assert.equal(taskInputs?.[0]?.description, "Implement the focused task.");
  assert.equal(taskInputs?.[0]?.status, undefined);
  assert.equal(taskInputs?.[0]?.plan?.riskLevel, "high");
  assert.deepEqual(taskInputs?.[0]?.plan?.successCriteria, ["command passes"]);

  const claimInput = normalizeSparkClaimTaskInput(
    {
      name: " focused-claim ",
      title: " Focused claim ",
      description: " Claim focused work. ",
      kind: "implement",
      status: "ready",
    },
    new RoleRegistry(),
  );
  assert.equal(claimInput.name, "focused-claim");
  assert.equal(claimInput.title, "Focused claim");
  assert.equal(claimInput.description, "Claim focused work.");
  assert.equal(claimInput.kind, "implement");
  assert.equal(claimInput.requestedStatus, "ready");

  runNormalizerGroup(
    "task planning",
    [
      [() => normalizeTaskKind(undefined), undefined],
      [() => normalizeTaskKind("implement"), "implement"],
      [() => normalizeTaskKind("research"), "research"],
      [() => normalizeTaskKind("review"), "review"],
      [() => normalizeTaskStatus(undefined), undefined],
      [() => normalizeTaskStatus("pending"), "pending"],
      [() => normalizeSparkPlanTaskInputs({}, new RoleRegistry()), undefined],
      [
        () => normalizeSparkFinishTaskInput({}),
        {
          task: undefined,
          status: "done",
          summary: undefined,
          evidenceRefs: [],
          evidence: undefined,
        },
      ],
      [
        () =>
          normalizeSparkFinishTaskInput({
            status: "failed",
            summary: " Failed ",
            evidenceRefs: ["evidence:focused-validation"],
          }),
        {
          task: undefined,
          status: "failed",
          summary: "Failed",
          evidenceRefs: ["evidence:focused-validation"],
          evidence: undefined,
        },
      ],
      [
        () =>
          normalizeSparkFinishTaskInput({
            evidence: {
              title: " Evidence title ",
              notes: " Notes ",
              changedFiles: [" packages/spark-extension/src/file.ts "],
              sourceRefs: [" test/file.test.ts:10 "],
              validationCommands: [" pnpm test — pass "],
            },
          }),
        {
          task: undefined,
          status: "done",
          summary: undefined,
          evidenceRefs: [],
          evidence: {
            title: "Evidence title",
            notes: "Notes",
            changedFiles: ["packages/spark-extension/src/file.ts"],
            sourceRefs: ["test/file.test.ts:10"],
            validationCommands: ["pnpm test — pass"],
          },
        },
      ],
      [() => normalizeSparkTodoOps(undefined), undefined],
      [
        () => normalizeSparkTodoOps([{ op: "init", items: [" One ", "Two"] }]),
        [{ op: "init", items: ["One", "Two"] }],
      ],
      [
        () => normalizeSparkTodoOps([{ op: "block", item: "One", blockedBy: [" Gate "] }]),
        [{ op: "block", item: "One", blockedBy: ["Gate"] }],
      ],
      [
        () => normalizeSparkTodoOps([{ op: "upsert_done", item: " One " }]),
        [{ op: "upsert_done", item: "One" }],
      ],
    ],
    [
      [() => normalizeTaskKind("build"), /kind must be research, implement, or review/],
      [() => normalizeTaskKind(1), /kind must be research, implement, or review/],
      [() => normalizeTaskKind("plan"), /internal\/reserved/],
      [() => normalizeTaskKind("proj:demo"), /project ref/],
      [() => normalizeTaskStatus("waiting"), /status must be pending/],
      [() => normalizeTaskStatus(false), /status must be pending/],
      [
        () => normalizeSparkPlanTaskInputs({ tasks: {} }, new RoleRegistry()),
        /tasks must be a non-empty array/,
      ],
      [
        () =>
          normalizeSparkPlanTaskInputs(
            { tasks: [{ title: 42, description: "Implement focused task." }] },
            new RoleRegistry(),
          ),
        /tasks\[0\]\.title must be a string/,
      ],
      [
        () =>
          normalizeSparkPlanTaskInputs(
            { tasks: [{ title: "Focused task", description: "Implement.", dependsOn: [1] }] },
            new RoleRegistry(),
          ),
        /tasks\[0\]\.dependsOn must be an array of strings/,
      ],
      [
        () =>
          normalizeSparkPlanTaskInputs(
            { tasks: [{ title: "Focused task", description: "Implement.", plan: "later" }] },
            new RoleRegistry(),
          ),
        /tasks\[0\]\.plan must be an object/,
      ],
      [
        () =>
          normalizeSparkPlanTaskInputs(
            {
              tasks: [
                {
                  title: "Focused task",
                  description: "Implement.",
                  plan: { riskLevel: "urgent" },
                },
              ],
            },
            new RoleRegistry(),
          ),
        /tasks\[0\]\.plan\.riskLevel must be trivial, normal, or high/,
      ],
      [
        () =>
          normalizeSparkClaimTaskInput(
            { title: 42, description: "Claim focused work." },
            new RoleRegistry(),
          ),
        /title must be a string/,
      ],
      [
        () => normalizeSparkFinishTaskInput({ status: "cancel" }),
        /status must be done, failed, or cancelled/,
      ],
      [
        () => normalizeSparkFinishTaskInput({ evidenceRefs: "artifact:focused-validation" }),
        /evidenceRefs must be an array of evidence refs/,
      ],
      [
        () => normalizeSparkFinishTaskInput({ evidenceRefs: ["task:not-an-artifact"] }),
        /evidenceRefs\[0\] must be an evidence: ref/,
      ],
      [() => normalizeSparkFinishTaskInput({ summary: 42 }), /summary must be a string/],
      [() => normalizeSparkFinishTaskInput({ evidence: [] }), /evidence must be an object/],
      [
        () => normalizeSparkFinishTaskInput({ evidence: { changedFiles: [1] } }),
        /evidence\.changedFiles must be an array of strings/,
      ],
      [() => normalizeSparkStateAction("status"), /action must be state_status/],
      [() => normalizeSparkStateAction("compact-role-run-evidence"), /role_run_evidence_compact/],
      [() => normalizeSparkTodoOps({}), /ops must be a non-empty array/],
      [() => normalizeSparkTodoOps([{ op: "pause", item: "One" }]), /ops\[0\]\.op must be init/],
      [
        () => normalizeSparkTodoOps([{ op: "init", items: [1] }]),
        /ops\[0\]\.items must be an array of strings/,
      ],
    ],
  );

  runNormalizerGroup(
    "ask replay",
    [
      [() => normalizeSparkAskReplayEvidenceRef(undefined), undefined],
      [() => normalizeSparkAskReplayEvidenceRef("evidence:ask-one"), "evidence:ask-one"],
    ],
    [
      [() => normalizeSparkAskReplayEvidenceRef(42), /evidenceRef must be a string/],
      [
        () => normalizeSparkAskReplayEvidenceRef("artifact:one"),
        /evidenceRef must be an evidence: ref/,
      ],
    ],
  );
});

type TestSparkContext = {
  cwd: string;
  sessionId: string;
  sendUserMessage?: (content: string) => Promise<void>;
  sessionManager: {
    getSessionId?: () => string;
    getSessionFile: () => string | undefined;
    getLeafId: () => string | undefined;
  };
  waitForIdle?: () => Promise<void>;
  hasUI: boolean;
  notifications: TestNotification[];
  runRole?: ExtensionRoleRunner;
  model?: { provider: string; id: string };
  modelRegistry?: unknown;
  selected?: string;
  inputValue?: string;
  editorText?: string;
  askAutoAnswer?: boolean;
  askAutoAnswerResolver?: (request: unknown, ctx: SparkToolContext) => Promise<unknown>;
  askWaitTimeoutMs?: number;
  askReviewerFallbackAfterMs?: number;
  sparkActiveMode?: {
    mode: "plan" | "execute";
  };
  sparkAutonomousAsk?: SparkToolContext["sparkAutonomousAsk"];
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error" | "success") => void;
    setWidget: (key: string, cb: unknown, opts?: { placement?: string }) => void;
    setStatus: (key: string, text: string | undefined) => void;
    setEditorText?: (text: string) => void;
    confirm: (title: string, message: string) => Promise<boolean>;
    input: (title: string, defaultValue?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    custom?: (...args: unknown[]) => unknown;
    interaction?: (request: ExtensionInteractionRequest) => Promise<ExtensionInteractionResponse>;
  };
};

test("Spark command surface does not expose the removed /spark entry", () => {
  const run = registerSparkToolsForTest();
  assert.equal(run.commands.has("spark"), false);
});

test("/automate only prefills an existing canonical automation command", async () => {
  const ctx = testSparkContext("/tmp/spark-automate-picker", "main");
  const run = registerSparkToolsForTest();
  const automate = run.commands.get("automate");
  assert.ok(automate, "missing /automate command");

  const expected = new Map([
    ["Goal — finish one defined outcome", "/goal start "],
    ["Loop — repeat open-ended work", "/loop start "],
    ["Repro — follow evidence-gated reproduction steps", "/repro start "],
    ["Workflow — choose a saved procedure", "/workflow list"],
  ]);
  let shownOptions: string[] = [];
  ctx.ui.select = async (title, options) => {
    assert.equal(title, "Choose how Spark should continue");
    shownOptions = options;
    return ctx.selected;
  };

  for (const [selection, command] of expected) {
    ctx.selected = selection;
    ctx.editorText = undefined;
    await automate.handler("", ctx);
    assert.equal(ctx.editorText, command);
  }
  assert.deepEqual(shownOptions, [...expected.keys()]);
  assert.equal(run.loopControl.loops.size, 0);
  assert.equal(run.messages.length, 0);
  assert.equal(run.customMessages.length, 0);

  ctx.selected = undefined;
  ctx.editorText = "unchanged";
  await automate.handler("", ctx);
  assert.equal(ctx.editorText, "unchanged");

  await automate.handler("goal", ctx);
  assert.match(ctx.notifications.at(-1)?.message ?? "", /Usage: \/automate/);
  assert.equal(ctx.notifications.at(-1)?.level, "warning");

  ctx.ui.select = undefined as never;
  await automate.handler("", ctx);
  assert.match(ctx.notifications.at(-1)?.message ?? "", /\/goal start <objective>/);
  assert.match(ctx.notifications.at(-1)?.message ?? "", /\/workflow list/);
});

test("/ultracode enters opt-in high-effort workflow generation mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ultracode-command-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const ultracode = run.commands.get("ultracode");
    assert.ok(ultracode, "missing /ultracode command");

    await ultracode.handler("design and validate a workflow parity suite", ctx);

    const message = run.customMessages.at(-1);
    assert.equal(message?.customType, "spark-mode-request");
    assert.equal(message?.display, false);
    assert.equal(run.messages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/plan, /implement, /goal, and /workflow selector commands enter Spark modes directly", async () => {
  const existingDir = await mkdtemp(join(tmpdir(), "spark-plan-direct-existing-"));
  const initializedDir = await mkdtemp(join(tmpdir(), "spark-execute-direct-initialized-"));
  const emptyDir = await mkdtemp(join(tmpdir(), "spark-execute-direct-empty-"));
  try {
    await mkdir(join(existingDir, ".git"));
    await writeFile(join(existingDir, "README.md"), "# Existing project\n", "utf8");
    const existingCtx = testSparkContext(existingDir, "main");
    const existingRun = registerSparkToolsForTest();
    const planCommand = existingRun.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");
    await planCommand.handler("Audit current task flow", existingCtx);
    assert.equal(existsSync(projectTreeIndexPath(existingDir)), true);
    assert.equal(existsSync(join(existingDir, "SPARK.md")), false);
    assert.equal(existingRun.messages.length, 0);
    assert.equal(existingRun.customMessages.length, 1);
    assert.equal(existingRun.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.equal(existingCtx.sparkActiveMode?.mode, "plan");

    await writeEmptySparkProject(initializedDir);
    const initializedCtx = testSparkContext(initializedDir, "main");
    await defaultTaskGraphStore(initializedDir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await mkdir(sessionDirectoryPath(initializedDir, initializedCtx), { recursive: true });
      await writeFile(
        currentProjectStatePath(initializedDir, initializedCtx),
        JSON.stringify({ version: 1, projectRef: project.ref }, null, 2),
        "utf8",
      );
      graph.createTask({
        projectRef: project.ref,
        title: "Direct execution task needing a plan",
        description: "Direct execution task needing a plan",
        status: "pending",
      });
    });
    const initializedRun = registerSparkToolsForTest();
    assert.equal(initializedRun.commands.get("research"), undefined);
    const executeCommand = initializedRun.commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("Finish the direct execution task", initializedCtx);
    assert.equal(initializedRun.messages.length, 0);
    assert.equal(initializedRun.loopControl.loops.size, 0);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Execution mode requirements/u,
    );
    assert.deepEqual(initializedCtx.sparkActiveMode, {
      mode: "execute",
    });

    initializedCtx.ui.select = async () =>
      assert.fail("/implement should not open a canned implement-strategy ask");
    const implementMessageCount = initializedRun.customMessages.length;
    await executeCommand.handler("keep going until done", initializedCtx);
    assert.equal(initializedRun.loopControl.loops.size, 0);
    assert.equal(initializedRun.customMessages.length, implementMessageCount + 1);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");
    const askedGoalState = JSON.parse(
      await readFile(currentProjectStatePath(initializedDir, initializedCtx), "utf8"),
    ) as { projectRef?: string; executionMode?: unknown };
    assert.ok(askedGoalState.projectRef);
    assert.equal(askedGoalState.executionMode, undefined);
    initializedCtx.ui.select = async () =>
      assert.fail("explicit /workflow selector aliases should not ask for strategy");

    const goalCommand = initializedRun.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    const loopCommand = initializedRun.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");
    const reproCommand = initializedRun.commands.get("repro");
    assert.ok(reproCommand, "missing /repro command");
    assert.equal(initializedRun.commands.get("workflow:goal"), undefined);
    assert.ok(initializedRun.commands.get("workflow:research"));
    assert.ok(initializedRun.commands.get("workflow:review"));
    await goalCommand.handler("Finish the queue until done", initializedCtx);
    assert.match(activeTestLoop(initializedRun, "goal")?.reason ?? "", /Finish the queue/u);
    const goalSessionStateRaw = await readFile(
      sessionGoalPath(initializedDir, initializedCtx),
      "utf8",
    );
    const goalSessionState = JSON.parse(goalSessionStateRaw) as {
      goal?: { objective?: string; status?: string };
    };
    assert.equal(goalSessionState.goal?.objective, "Finish the queue until done");
    assert.equal(goalSessionState.goal?.status, "active");
    const sessionAfterGoal = JSON.parse(
      await readFile(currentProjectStatePath(initializedDir, initializedCtx), "utf8"),
    ) as { executionMode?: unknown };
    assert.equal(sessionAfterGoal.executionMode, undefined);

    await goalCommand.handler("", initializedCtx);
    assert.equal(activeTestLoop(initializedRun, "goal")?.status, "scheduled");
    assert.equal(initializedRun.commands.get("workflow:ready"), undefined);

    const messagesBeforeLoop = initializedRun.customMessages.length;
    await loopCommand.handler("Continue the queue without completing", initializedCtx);
    assert.equal(initializedRun.customMessages.length, messagesBeforeLoop);
    assert.equal(activeTestLoop(initializedRun, "loop")?.status, "scheduled");
    const activeLoop = await loadSessionLoop(initializedDir, initializedCtx);
    assert.equal(activeLoop?.objective, "Continue the queue without completing");
    assert.equal(activeLoop?.status, "active");
    assert.equal(await loadSessionGoal(initializedDir, initializedCtx), undefined);
    await loopCommand.handler("停止", initializedCtx);
    assert.equal(await loadSessionLoop(initializedDir, initializedCtx), undefined);

    await mkdir(join(initializedDir, ".agents", "workflows", "triage"), { recursive: true });
    await writeFile(
      join(initializedDir, ".agents", "workflows", "triage", "WORKFLOW.md"),
      `---
id: triage
title: Triage Workflow
description: Triage incidents with specialist stages.
stages: [collect, decide]
---
Collect incident facts and decide the bounded response.
`,
    );
    await writeFile(
      join(initializedDir, ".agents", "workflows", "broken.js"),
      `export const meta = { name: "Broken" };`,
    );
    const workflowCommand = initializedRun.commands.get("workflow");
    assert.ok(workflowCommand, "missing /workflow command");
    assert.deepEqual(
      (await workflowCommand.getArgumentCompletions?.("pa"))?.map((entry) => entry.value),
      ["pause"],
    );
    assert.deepEqual(
      (await workflowCommand.getArgumentCompletions?.("run builtin:re"))?.map(
        (entry) => entry.value,
      ),
      [
        "run builtin:research",
        "run builtin:review",
        "run builtin:repro",
        "run builtin:repro-stage-orchestrate",
        "run builtin:repro-module-sweep",
        "run builtin:repro-first-divergence",
        "run builtin:repro-change-loop",
        "run builtin:repro-long-horizon",
        "run builtin:repro-axis-qualify",
        "run builtin:repro-topology-compose",
        "run builtin:repro-evidence-review",
        "run builtin:repro-delivery-sync",
      ],
    );
    const workflowsCommand = initializedRun.commands.get("workflows");
    assert.ok(workflowsCommand, "missing /workflows command");
    assert.equal(workflowsCommand.metadata?.deprecatedAliasFor, "/workflow list");
    const workflowRunsCommand = initializedRun.commands.get("workflow-runs");
    assert.ok(workflowRunsCommand, "missing /workflow-runs command");
    assert.equal(workflowRunsCommand.metadata?.deprecatedAliasFor, "/workflow runs [runRef]");
    const researchWorkflowCommand = initializedRun.commands.get("workflow:research");
    assert.ok(researchWorkflowCommand, "missing /workflow:research command");
    assert.equal(initializedRun.commands.get("workflow:triage"), undefined);
    await workflowCommand.handler("workspace:triage Review with a workflow", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");

    await workflowCommand.handler("builtin:research Compare design options", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(initializedCtx.sparkActiveMode, {
      mode: "plan",
    });

    await workflowCommand.handler(
      "run research Compare canonical workflow actions",
      initializedCtx,
    );
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(initializedCtx.sparkActiveMode, {
      mode: "plan",
    });

    await researchWorkflowCommand.handler(
      "Compare default panel and judge behavior",
      initializedCtx,
    );
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(initializedCtx.sparkActiveMode, {
      mode: "plan",
    });

    let workflowNavigatorOptions: string[] = [];
    initializedCtx.ui.select = async (_title, options) => {
      workflowNavigatorOptions = options;
      return initializedCtx.selected;
    };
    initializedCtx.selected = "builtin:review";
    initializedCtx.inputValue = "Review the workflow UI direction";
    await workflowCommand.handler("", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");

    initializedCtx.selected = "builtin:research";
    await workflowCommand.handler("list Canonical navigator focus", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");

    initializedCtx.selected = "workspace:triage";
    await workflowsCommand.handler("Navigator supplied focus", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");

    const navigatorStore = defaultSparkDynamicWorkflowEventStore(initializedDir);
    const navigatorRun = await navigatorStore.start({
      source: { kind: "inline", label: "navigator control workflow" },
      script:
        "export const meta = { name: 'Navigator Control', description: 'Navigator control workflow' }\nreturn 'ok'",
      meta: { name: "Navigator Control", description: "Navigator control workflow" },
      options: {},
    });
    initializedCtx.selected = `dynamic:save:${navigatorRun.ref} running navigator control workflow`;
    await workflowsCommand.handler("", initializedCtx);
    assert.ok(
      workflowNavigatorOptions.some((option) =>
        option.startsWith(`dynamic:save:${navigatorRun.ref}`),
      ),
      "expected /workflows navigator to expose dynamic workflow run save action",
    );
    assert.ok(
      initializedCtx.notifications.some((entry) =>
        /Spark dynamic workflow dashboard \(navigator\)/.test(entry.message),
      ),
      "expected /workflows navigator to show the dynamic workflow dashboard before selection",
    );
    assert.match(
      initializedCtx.notifications.at(-1)?.message ?? "",
      /Spark dynamic workflow dashboard \(save\)/,
    );
    assert.match(initializedCtx.notifications.at(-1)?.message ?? "", /Control: save/);
    assert.match(
      initializedCtx.notifications.at(-1)?.message ?? "",
      /workspace:navigator-control-/,
    );
    assert.match(
      (await navigatorStore.get(navigatorRun.ref))?.savedWorkflow?.selector ?? "",
      /^workspace:navigator-control-/,
    );
    initializedCtx.ui.select = async () =>
      assert.fail("non-empty /workflow focus should not ask for a selector before prompting");

    await workflowCommand.handler(
      "Run this one-shot workflow:\n\n" +
        "```js\n" +
        "export const meta = {\n" +
        '  name: "Inline Cleanup",\n' +
        '  description: "Clean up temporary files with a one-shot workflow.",\n' +
        '  stages: [{ title: "Inspect" }, { title: "Remove" }],\n' +
        "};\n" +
        'export default async function workflow() { throw new Error("not run during discovery"); }\n' +
        "```",
      initializedCtx,
    );
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");

    assert.equal(initializedRun.commands.get("run"), undefined);
    assert.equal(initializedRun.commands.get("run-sequential"), undefined);
    assert.equal(initializedRun.commands.get("run-parallel"), undefined);

    const emptyCtx = testSparkContext(emptyDir, "main");
    const emptyRun = registerSparkToolsForTest();
    const emptyExecute = emptyRun.commands.get("execute");
    assert.ok(emptyExecute, "missing /execute command");
    await emptyExecute.handler("", emptyCtx);
    assert.equal(emptyRun.customMessages.length, 0);
    const emptyGoalCommand = emptyRun.commands.get("goal");
    assert.ok(emptyGoalCommand, "missing /goal command");
    assert.equal(emptyRun.commands.get("workflow:goal"), undefined);
    await emptyGoalCommand.handler("", emptyCtx);
    assert.equal(emptyRun.customMessages.length, 0);
    assert.match(activeTestLoop(emptyRun, "goal")?.loopId ?? "", /^goal-infer:/u);
    const emptyWorkflowCommand = emptyRun.commands.get("workflow:research");
    assert.ok(emptyWorkflowCommand, "missing /workflow:research command");
    await emptyWorkflowCommand.handler("Investigate standalone workflow usage", emptyCtx);
    assert.equal(emptyRun.customMessages.length, 1);
    assert.equal(emptyRun.customMessages.at(-1)?.customType, "spark-mode-request");
  } finally {
    await rm(existingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(initializedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("/plan dispatches through an externally owned command turn bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-command-turn-bridge-"));
  try {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "README.md"), "# Existing project\n", "utf8");
    const ctx = testSparkContext(dir, "main");
    const forwarded: string[] = [];
    ctx.sendUserMessage = async (content) => {
      await Promise.resolve();
      forwarded.push(content);
    };
    const run = registerSparkToolsForTest();
    const planCommand = run.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");

    await planCommand.handler("Trace the visible turn path", ctx);

    assert.equal(forwarded.length, 1);
    assert.match(forwarded[0] ?? "", /## Planning focus\nTrace the visible turn path/u);
    assert.equal(run.customMessages.length, 0);
    assert.deepEqual(ctx.sparkActiveMode, { mode: "plan" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/goal dispatches through an externally owned command turn bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-command-turn-bridge-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const forwarded: string[] = [];
    ctx.sendUserMessage = async (content) => {
      await Promise.resolve();
      forwarded.push(content);
    };
    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");

    await goalCommand.handler("Trace the daemon goal bridge", ctx);

    assert.equal(forwarded.length, 0);
    assert.match(activeTestLoop(run, "goal")?.reason ?? "", /Trace the daemon goal bridge/u);
    assert.equal(run.customMessages.length, 0);
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.objective, "Trace the daemon goal bridge");
    assert.equal(goal?.status, "active");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latest direct Spark mode replaces older pending hidden mode context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-phase-context-replace-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);

    const goalCommand = run.commands.get("goal");
    const executeCommand = run.commands.get("execute");
    const planCommand = run.commands.get("plan");
    assert.ok(goalCommand, "missing /goal command");
    assert.equal(run.commands.get("workflow:goal"), undefined);
    assert.ok(executeCommand, "missing /execute command");
    assert.ok(planCommand, "missing /plan command");

    await goalCommand.handler("work through background queue", ctx);
    await executeCommand.handler("take one task", ctx);
    await planCommand.handler("revise the failed task plan", ctx);

    const hiddenMessage = run.customMessages.at(-1);
    assert.equal(hiddenMessage?.customType, "spark-mode-request");
    assert.equal(ctx.sparkActiveMode?.mode, "plan");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/plan includes active roadmap item context and matches focus to an existing item", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-roadmap-context-"));
  try {
    await writeEmptySparkProject(dir);
    await writeRoadmap(dir, {
      activeItemRef: "roadmap-item:other",
      items: [
        {
          ref: "roadmap-item:other",
          title: "Other roadmap item",
          objective: "Keep an unrelated active item available.",
          status: "active",
        },
        {
          ref: "roadmap-item:planning",
          title: "Roadmap assisted planning",
          objective: "Use roadmap item intent while planning tasks.",
          scope: "Keep changes within task organization only.",
          successCriteria: [
            "Planning prompt text includes the matched roadmap item ref and objective.",
          ],
          evidenceRequired: [
            "Planning prompt capture records the roadmap item ref and objective text.",
          ],
        },
      ],
    });
    const ctx = testSparkContext(dir, "main");
    const seededGraph = await defaultTaskGraphStore(dir).load();
    const seededProject = seededGraph?.projects()[0];
    assert.ok(seededProject);
    await saveCurrentProjectRef(dir, ctx, seededProject.ref);
    const run = registerSparkToolsForTest();
    const planCommand = run.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");

    await planCommand.handler("Roadmap assisted planning", ctx);

    assert.equal(run.messages.length, 0);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(ctx.sparkActiveMode, { mode: "plan" });
    const graph = await defaultTaskGraphStore(dir).load();
    const project = graph?.projects()[0];
    assert.ok(project?.roadmap);
    assert.equal(project.roadmap.activeItemRef, "roadmap-item:planning");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/plan rejects malformed roadmap state without entering planning mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-roadmap-malformed-"));
  try {
    await writeEmptySparkProject(dir);
    const graph = await defaultTaskGraphStore(dir).load();
    const project = graph?.projects()[0];
    assert.ok(project);
    const roadmapPath = join(
      dir,
      ".spark",
      "projects",
      projectTreeDirName(project.ref),
      "roadmap.json",
    );
    const snapshot = JSON.parse(await readFile(roadmapPath, "utf8")) as { items?: unknown };
    snapshot.items = "not-array";
    await writeFile(roadmapPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const planCommand = run.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");

    await assert.rejects(async () => {
      await planCommand.handler("Roadmap assisted planning", ctx);
    }, /invalid project roadmap: .*\.items must be an array/);
    assert.equal(run.customMessages.length, 0);
    const currentState = await loadCurrentProjectState(dir, ctx);
    assert.equal(currentState, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks maps active roadmap item hints into task plans and attaches refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-roadmap-hints-"));
  try {
    await writeEmptySparkProject(dir);
    await writeRoadmap(dir, {
      activeItemRef: "roadmap-item:planning",
      items: [
        {
          ref: "roadmap-item:planning",
          title: "Roadmap assisted planning",
          objective: "Organize roadmap-backed Spark planning tasks.",
          scope: "Do not add dashboard or scheduling features.",
          successCriteria: [
            "Created task plans include the roadmap success criterion and roadmap item ref.",
          ],
          evidenceRequired: ["Task graph evidence records task refs attached to the roadmap item."],
          status: "active",
        },
      ],
    });
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "roadmap-backed-task",
          title: "Create roadmap-backed task",
          description: "Exercise roadmap-assisted planning hints.",
          kind: "implement",
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    assert.match(toolText(planned), /roadmap item updated: roadmap-item:planning/);
    assert.equal((planned.details as { approval?: unknown }).approval, undefined);
    const graph = await defaultTaskGraphStore(dir).load();
    const task = graph?.tasks()[0];
    assert.ok(task);
    assert.match(task.plan?.contextRefs.join("\n") ?? "", /Roadmap objective:/);
    assert.match(task.plan?.constraints.join("\n") ?? "", /Do not add dashboard/);
    assert.deepEqual(task.plan?.successCriteria, [
      "Created task plans include the roadmap success criterion and roadmap item ref.",
    ]);
    assert.deepEqual(task.plan?.evidenceRequired, [
      "Task graph evidence records task refs attached to the roadmap item.",
    ]);

    const project = graph?.projects()[0];
    const item = project?.roadmap.items[0];
    assert.ok(item?.taskRefs?.includes(task.ref));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks writes directly whenever durable planning is needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-direct-any-mode-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools, commands } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const noMode = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "direct-no-mode",
          title: "Direct plan outside prompt mode",
          description: "Save durable planning without requiring explicit /plan mode.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Save durable planning without requiring explicit /plan mode."),
        },
      ],
    });
    assert.match(toolText(noMode), /Planned tasks: created=1 updated=0/);

    const executeCommand = commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("Do one task", ctx);
    const duringExecute = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "direct-execute-mode",
          title: "Direct plan during execution prompt",
          description: "Save durable planning when the model detects planning is needed.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan(
            "Save durable planning when the model detects planning is needed.",
          ),
        },
      ],
    });
    assert.match(toolText(duringExecute), /Planned tasks: created=1 updated=0/);

    const graph = await defaultTaskGraphStore(dir).load();
    assert.deepEqual(
      graph
        ?.tasks()
        .map((task) => task.name)
        .sort(),
      ["direct-execute-mode", "direct-no-mode"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks writes directly without approval UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-direct-write-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = undefined as never;
    ctx.ui.input = undefined as never;
    ctx.ui.custom = undefined;
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "direct-plan-write",
          title: "Direct plan write task",
          description: "Exercise direct saving of ready task plans.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Exercise direct saving of ready task plans."),
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    const details = planned.details as { error?: string; approval?: unknown; dryRun?: unknown };
    assert.equal(details.error, undefined);
    assert.equal(details.approval, undefined);
    assert.equal(details.dryRun, undefined);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 1);
    assert.equal(graph?.tasks()[0]?.name, "direct-plan-write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks accepts an explicit project selector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-explicit-project-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultTaskGraphStore(dir);
    let secondProjectRef: ProjectRef | undefined;
    await store.update((graph) => {
      const second = graph.createProject({
        title: "Explicit project target",
        description: "Project selected directly by ref.",
      });
      secondProjectRef = second.ref;
    });
    assert.ok(secondProjectRef);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      project: secondProjectRef,
      tasks: [
        {
          name: "explicit-project-task",
          title: "Explicit project task",
          description: "Plan into the explicit project instead of the current project.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan(
            "Plan into the explicit project instead of the current project.",
          ),
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks(secondProjectRef).length, 1);
    assert.equal(graph?.tasks()[0]?.projectRef, secondProjectRef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks blocks mixed readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-readiness-mixed-"));
  try {
    await writeEmptySparkProject(dir);
    const before = await taskGraphSnapshotText(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "ready-plan",
          title: "Ready task",
          description: "A ready task that should not save when a sibling is blocked.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("A ready task that should not save when a sibling is blocked."),
        },
        {
          name: "blocked-plan",
          title: "Blocked task",
          description: "A blocked task that should prevent saving the whole batch.",
          kind: "implement",
          status: "pending",
        },
      ],
    });

    const details = planned.details as
      | {
          dryRun?: unknown;
          error?: string;
          result?: { created?: unknown[] };
          planDecisions?: Array<{ accepted?: boolean; blocked?: boolean }>;
        }
      | undefined;
    assert.match(toolText(planned), /Task plan not ready: @blocked-plan/);
    assert.match(toolText(planned), /missing_success_criteria\(blocking\)/);
    assert.match(toolText(planned), /Add at least one observable entry to plan\.successCriteria/);
    assert.equal(details?.dryRun, undefined);
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.result?.created?.length, 2);
    assert.equal(details?.planDecisions?.[0]?.accepted, true);
    assert.equal(details?.planDecisions?.[1]?.blocked, true);
    assert.equal(await taskGraphSnapshotText(dir), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks blocks low-bar unverifiable task plans without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-quality-gate-"));
  try {
    await writeEmptySparkProject(dir);
    const before = await taskGraphSnapshotText(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "weak-plan",
          title: "Weak plan",
          description: "Improve things.",
          kind: "implement",
          status: "pending",
          plan: {
            objective: "Basic improvement",
            successCriteria: ["Things are better"],
            evidenceRequired: ["Evidence is recorded"],
            steps: ["Do stuff"],
          },
        },
      ],
    });

    const details = planned.details as
      | { error?: string; planDecision?: { issues?: Array<{ kind?: string }> } }
      | undefined;
    assert.match(toolText(planned), /Task plan not ready: @weak-plan/);
    assert.match(toolText(planned), /unverifiable_success_criteria\(blocking\)/);
    assert.match(toolText(planned), /weak_evidence_required\(blocking\)/);
    assert.match(toolText(planned), /low_ambition_plan\(blocking\)/);
    assert.equal(details?.error, "task_plan_not_ready");
    assert.deepEqual(
      details?.planDecision?.issues?.map((issue) => issue.kind),
      [
        "weak_objective",
        "unverifiable_success_criteria",
        "weak_evidence_required",
        "weak_plan_items",
        "low_ambition_plan",
      ],
    );
    assert.equal(await taskGraphSnapshotText(dir), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks accepts warning-only openQuestions plans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-open-questions-warning-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "question-notes",
          title: "Task with scratch questions",
          description: "A task whose open questions are non-blocking planning notes.",
          kind: "implement",
          status: "pending",
          plan: {
            ...executionReadyPlan("Run with scratch questions"),
            openQuestions: ["Can we simplify later?"],
          },
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1/);
    const graph = await defaultTaskGraphStore(dir).load();
    const task = graph?.tasks().find((candidate) => candidate.name === "question-notes");
    assert.ok(task);
    assert.equal(graph?.taskPlanReadiness(task.ref).ready, true);
    assert.deepEqual(
      graph?.taskPlanReadiness(task.ref).issues.map((issue) => [issue.kind, issue.severity]),
      [["open_questions", "warning"]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks reports all-rejected readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-rejected-"));
  try {
    await writeEmptySparkProject(dir);
    const before = await taskGraphSnapshotText(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("readiness validation should not open a task-plan ask");
    ctx.ui.custom = async () =>
      assert.fail("readiness validation should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "blocked-one",
          title: "Blocked task one",
          description: "A blocked task that should not save.",
          kind: "implement",
          status: "pending",
        },
        {
          name: "blocked-two",
          title: "Blocked task two",
          description: "Another blocked task that should not save.",
          kind: "review",
          status: "pending",
        },
      ],
    });

    assert.match(toolText(planned), /Task plan not ready: @blocked-one/);
    assert.match(toolText(planned), /missing_success_criteria\(blocking\)/);
    const details = planned.details as
      | {
          dryRun?: unknown;
          error?: string;
          result?: { created?: unknown[] };
          planDecisions?: Array<{ accepted?: boolean; blocked?: boolean }>;
        }
      | undefined;
    assert.equal(details?.dryRun, undefined);
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.result?.created?.length, 2);
    assert.equal(
      details?.planDecisions?.every((decision) => decision.blocked),
      true,
    );
    assert.equal(await taskGraphSnapshotText(dir), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/implement continues through the agent-end hook without auto-answering or auto-claiming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-execute-one-task-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });
      await writeFile(
        currentProjectStatePath(dir, ctx),
        JSON.stringify({ version: 1, projectRef: project.ref }, null, 2),
        "utf8",
      );
      graph.createTask({
        projectRef: project.ref,
        name: "first-ready",
        title: "First ready task",
        description: "First ready task",
        plan: executionReadyPlan("First ready task"),
        status: "pending",
      });
      graph.createTask({
        projectRef: project.ref,
        name: "second-ready",
        title: "Second ready task",
        description: "Second ready task",
        plan: executionReadyPlan("Second ready task"),
        status: "pending",
      });
    });

    const run = registerSparkToolsForTest();
    const executeCommand = run.commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("work through the ready queue", ctx);
    assert.equal(run.loopControl.loops.size, 0);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(ctx.sparkActiveMode, {
      mode: "execute",
    });

    await executeSparkTool(run.tools, "impl_claim_task", ctx, {
      name: "first-ready",
      title: "First ready task",
      description: "First ready task",
      status: "running",
      todos: ["Finish first ready task"],
    });
    await executeSparkTool(run.tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Finish first ready task"] },
        { op: "done", item: "Finish first ready task" },
      ],
    });
    const finished = await executeSparkTool(run.tools, "impl_finish_task", ctx, {
      summary: "Finished first ready task.",
      evidence: successfulFinishEvidence("First ready task validation"),
    });

    const text = finished.content.map((item) => item.text).join("\n");
    assert.match(text, /Implementation phase can continue/);
    assert.match(text, /Next ready task: @second-ready/);
    assert.match(text, /claim the next ready task, and continue until blocked/);
    assert.doesNotMatch(text, /Implementation phase stopped after one task/);
    assert.doesNotMatch(text, /auto-claimed next ready task/);
    assert.equal((finished.details as { autoClaimedTask?: unknown }).autoClaimedTask, undefined);
    assert.ok((finished.details as { nextReadyTask?: unknown }).nextReadyTask);
    assert.equal((finished.details as { statusBefore?: string }).statusBefore, "running");
    assert.equal((finished.details as { statusAfter?: string }).statusAfter, "done");
    assert.equal(
      (finished.details as { remainingReadyTasks?: unknown[] }).remainingReadyTasks?.length,
      1,
    );
    assert.equal(
      (finished.details as { projectCompletionCandidate?: { unfinishedTaskCount?: number } })
        .projectCompletionCandidate?.unfinishedTaskCount,
      1,
    );
    assert.equal(await tryConsumeSparkModeContext(run, ctx), undefined);

    const agentEndHandlers = run.eventHandlers.get("agent_end") ?? [];
    assert.ok(agentEndHandlers.length > 0, "missing agent-end reconciliation hook");
    const messageCountBeforeAgentEnd = run.customMessages.length;
    for (const handler of agentEndHandlers) await handler({}, ctx);
    const continuation = run.customMessages
      .slice(messageCountBeforeAgentEnd)
      .find((message) => message.customType === "spark-agent-end-reconciliation");
    assert.ok(continuation, "ready implementation work should queue one hook continuation");
    assert.match(continuation.content, /@second-ready/u);
    assert.equal(run.loopControl.loops.size, 0);
    assert.deepEqual(ctx.sparkActiveMode, {
      mode: "execute",
    });

    const graph = await defaultTaskGraphStore(dir).load();
    const next = graph?.tasks().find((task) => task.name === "second-ready");
    assert.equal(next?.status, "pending");
    assert.equal(next?.claim, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("claim reports committed partial success when local metadata projection disappears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-partial-success-"));
  const projectsPath = join(dir, ".spark", "projects");
  const hiddenPath = join(dir, ".spark", "projects-hidden");
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "claim-partial");
    const run = registerSparkToolsForTest({
      taskClaimDaemonClient: createTestTaskClaimDaemonClient({
        afterAcquire: async () => rename(projectsPath, hiddenPath),
      }),
    });
    await useOnlySparkProject(run.tools, ctx);
    await executeSparkTool(run.tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "partial-claim",
          title: "Partial claim",
          description: "Report daemon authority after metadata projection failure.",
          kind: "implement",
          plan: executionReadyPlan("Report daemon authority after metadata projection failure."),
        },
      ],
    });

    const claimed = await executeSparkTool(run.tools, "impl_claim_task", ctx, {
      task: "partial-claim",
      status: "blocked",
    });
    const details = claimed.details as {
      committed?: boolean;
      partial?: boolean;
      postCommitWarnings?: string[];
      task?: { status?: string; claim?: { sessionId?: string } };
    };
    assert.equal(claimed.isError, undefined);
    assert.equal(details.committed, true);
    assert.equal(details.partial, true);
    assert.equal(details.task?.status, "blocked");
    assert.match(details.postCommitWarnings?.join("\n") ?? "", /metadata/i);

    await rm(projectsPath, { recursive: true, force: true });
    await rename(hiddenPath, projectsPath);
    const task = (await defaultTaskGraphStore(dir).load())
      ?.tasks()
      .find((entry) => entry.name === "partial-claim");
    assert.equal(task?.status, "blocked");
    assert.equal(task?.claim?.sessionId, ctxSessionKey(ctx));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("finish reports committed success when post-daemon graph reload disappears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-finish-partial-success-"));
  const projectsPath = join(dir, ".spark", "projects");
  const hiddenPath = join(dir, ".spark", "projects-hidden");
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "finish-partial");
    const run = registerSparkToolsForTest({
      taskClaimDaemonClient: createTestTaskClaimDaemonClient({
        afterRelease: async () => rename(projectsPath, hiddenPath),
      }),
    });
    await useOnlySparkProject(run.tools, ctx);
    await executeSparkTool(run.tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "partial-finish",
          title: "Partial finish",
          description: "Return committed terminal status after projection failure.",
          kind: "implement",
          plan: executionReadyPlan("Return committed terminal status after projection failure."),
        },
      ],
    });
    await executeSparkTool(run.tools, "impl_claim_task", ctx, { task: "partial-finish" });
    await executeSparkTool(run.tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "upsert_done", item: "Return committed terminal status after projection failure." },
      ],
    });

    const finished = await executeSparkTool(run.tools, "impl_finish_task", ctx, {
      task: "partial-finish",
      summary: "Daemon terminal mutation committed before projection failure.",
      evidence: successfulFinishEvidence("Partial finish validation"),
    });
    const details = finished.details as {
      transition?: { committed?: boolean };
      statusAfter?: string;
      postCommitWarnings?: string[];
    };
    assert.equal(finished.isError, undefined);
    assert.equal(details.transition?.committed, true);
    assert.equal(details.statusAfter, "done");
    assert.match(details.postCommitWarnings?.join("\n") ?? "", /reload returned no graph/i);

    await rm(projectsPath, { recursive: true, force: true });
    await rename(hiddenPath, projectsPath);
    const task = (await defaultTaskGraphStore(dir).load())
      ?.tasks()
      .find((entry) => entry.name === "partial-finish");
    assert.equal(task?.status, "done");
    assert.equal(task?.claim, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/goal sets a durable session goal instead of execute-mode continuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-run-foreground-continue-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });
      await writeFile(
        currentProjectStatePath(dir, ctx),
        JSON.stringify({ version: 1, projectRef: project.ref }, null, 2),
        "utf8",
      );
    });

    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    assert.equal(run.commands.get("workflow:goal"), undefined);
    await goalCommand.handler("work through the ready queue until done", ctx);
    assert.equal(activeTestLoop(run, "goal")?.status, "scheduled");
    const goalState = JSON.parse(await readFile(sessionGoalPath(dir, ctx), "utf8")) as {
      goal?: { objective?: string; status?: string };
    };
    assert.equal(goalState.goal?.objective, "work through the ready queue until done");
    assert.equal(goalState.goal?.status, "active");

    const sessionState = JSON.parse(await readFile(currentProjectStatePath(dir, ctx), "utf8")) as {
      executionMode?: unknown;
      runMode?: unknown;
    };
    assert.equal(sessionState.executionMode, undefined);
    assert.equal(sessionState.runMode, undefined);
    assert.match(
      activeTestLoop(run, "goal")?.reason ?? "",
      /work through the ready queue until done/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("foreground loops do not expose selected phases for research-progress objectives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-foreground-empty-frontier-plan-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const objective = "不断学习其他项目，调研，考虑优化 Spark 方案，创建任务并完成它们";

    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler(objective, ctx);
    const goalDriver = activeTestLoop(run, "goal");
    assert.match(goalDriver?.reason ?? "", new RegExp(objective));
    assert.doesNotMatch(
      goalDriver?.reason ?? "",
      /Selected Spark phase|selected phase|phase requirements/,
    );

    const loopCommand = run.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");
    await loopCommand.handler(objective, ctx);
    const loopDriver = activeTestLoop(run, "loop");
    assert.match(loopDriver?.reason ?? "", /loop started/u);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("foreground loops keep pure research objectives driver-owned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-foreground-empty-frontier-research-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const objective = "调研其他项目并总结发现";

    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler(objective, ctx);
    const goalDriver = activeTestLoop(run, "goal");
    assert.match(goalDriver?.reason ?? "", new RegExp(objective));
    assert.doesNotMatch(
      goalDriver?.reason ?? "",
      /Selected Spark phase|selected phase|phase requirements/,
    );

    const loopCommand = run.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");
    await loopCommand.handler(objective, ctx);
    assert.equal(activeTestLoop(run, "loop")?.status, "scheduled");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("/goal without objective dispatches an agent infer instruction without writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-empty-infer-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");

    await goalCommand.handler("", ctx);

    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal, undefined);
    const inferDriver = activeTestLoop(run, "goal");
    assert.match(inferDriver?.loopId ?? "", /^goal-infer:/u);
    assert.match(inferDriver?.reason ?? "", /infer goal/u);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("goal status surfaces lifecycle actions, usage, and review state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-status-polish-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const goal = await setSessionGoal(dir, ctx, {
      objective: "Explain polished goal status output",
      source: "explicit",
      status: "active",
    });
    await updateSessionGoalStatus(dir, ctx, "active", {
      expectedGoalId: goal.goalId,
      review: {
        achieved: false,
        confidence: "medium",
        reason: "status output still needs polish",
        remainingWork: "finish the display copy",
        blockers: ["missing action guidance"],
        reviewedAt: "2026-06-10T00:00:00.000Z",
      },
    });

    const status = await executeSparkTool(run.tools, "goal", ctx, { action: "status" });
    const statusText = toolText(status);
    assert.match(statusText, /Spark session goal active/);
    assert.match(statusText, /Goal: Explain polished goal status output/);
    assert.doesNotMatch(statusText, /Objective:/);
    assert.doesNotMatch(statusText, /Spark session goal active:/);
    assert.doesNotMatch(statusText, /Usage:/);
    assert.doesNotMatch(statusText, /tokens/);
    assert.match(statusText, /Last review: unrecorded at 2026-06-10T00:00:00.000Z/);
    assert.match(statusText, /Cadence and retry state are owned by the Spark daemon Loop/);
    assert.match(statusText, /Current project: .* unfinishedTasks=0 readyTasks=0/);
    assert.match(statusText, /Goal\/project relationship: Goal is session-scoped/);
    assert.doesNotMatch(statusText, /project_finish/);
    assert.match(statusText, /request goal\(\{ action: "complete" \}\)/);
    assert.doesNotMatch(statusText, /goal\(\{ action: "pause"/);
    assert.match(statusText, /autonomous pause is forbidden/);
    assert.doesNotMatch(statusText, /goal_complete/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("goal status explains absent durable goal against current project context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-status-no-goal-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);

    const status = await executeSparkTool(run.tools, "goal", ctx, { action: "status" });
    const statusText = toolText(status);
    assert.match(statusText, /No session goal is set in durable session state/);
    assert.match(statusText, /Current project: .* unfinishedTasks=0 readyTasks=0/);
    assert.match(statusText, /goal\(\{ action: "start" \}\)/);
    const relationship = status.details?.goalProjectRelationship as
      | { hasGoal?: boolean; binding?: string; currentProject?: { ref?: ProjectRef } }
      | undefined;
    assert.equal(relationship?.hasGoal, false);
    assert.equal(relationship?.binding, "current_project");
    assert.ok(relationship?.currentProject?.ref?.startsWith("proj:"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("/goal restarts without overwriting an existing goal objective", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-no-overwrite-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");

    await goalCommand.handler("finish the original queue", ctx);
    await goalCommand.handler("replace with a different goal", ctx);

    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.objective, "finish the original queue");
    assert.equal(activeTestLoop(run, "goal")?.loopId, goal?.goalId);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("/goal handles stale inferred project goals after project work has no unfinished tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-stale-done-project-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Done goal project",
      description: "Already finished project.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    const staleObjective = `Advance project “${project.title}” to completion.\nUnfinished tasks: 3. Ready tasks: 2.`;
    await setSessionGoal(dir, ctx, {
      objective: staleObjective,
      source: "inferred",
      status: "active",
    });

    await goalCommand.handler("", ctx);

    let goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal, undefined);
    assert.equal(run.customMessages.length, 0);

    await setSessionGoal(dir, ctx, {
      objective: staleObjective,
      source: "inferred",
      status: "active",
    });
    await goalCommand.handler("review 全盘代码进行改进", ctx);

    goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.objective, "review 全盘代码进行改进");
    assert.equal(goal?.source, "explicit");
    assert.equal(activeTestLoop(run, "goal")?.loopId, goal?.goalId);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("/goal start clears an existing foreground loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-clears-loop-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const loopCommand = run.commands.get("loop");
    const goalCommand = run.commands.get("goal");
    assert.ok(loopCommand, "missing /loop command");
    assert.ok(goalCommand, "missing /goal command");

    await loopCommand.handler("Loop before goal", ctx);
    assert.equal((await loadSessionLoop(dir, ctx))?.status, "active");
    await goalCommand.handler("Goal replaces loop", ctx);
    assert.equal(await loadSessionLoop(dir, ctx), undefined);
    assert.equal((await loadSessionGoal(dir, ctx))?.objective, "Goal replaces loop");
    assert.equal(activeTestLoop(run, "goal")?.status, "scheduled");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("/loop stop aliases clear plain loop state and pause is removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-loop-pause-aliases-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const loopCommand = run.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");

    for (const alias of ["stop", "halt", "停止", "停下"] as const) {
      await loopCommand.handler(`objective before ${alias}`, ctx);
      const active = await loadSessionLoop(dir, ctx);
      assert.equal(active?.status, "active");
      await loopCommand.handler(alias, ctx);
      assert.ok(active?.loopId);
      assert.equal(await loadSessionLoop(dir, ctx), undefined);
    }

    await loopCommand.handler("objective before removed pause", ctx);
    const activeBeforeRemovedPause = await loadSessionLoop(dir, ctx);
    assert.equal(activeBeforeRemovedPause?.status, "active");
    await loopCommand.handler("pause", ctx);
    assert.equal((await loadSessionLoop(dir, ctx))?.loopId, activeBeforeRemovedPause?.loopId);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /pause was removed/);

    await assert.rejects(
      executeSparkTool(run.tools, "loop", ctx, { action: "pause" }),
      /loop action must be status, schedule, or clear/,
    );
    const clearedViaTool = await executeSparkTool(run.tools, "loop", ctx, { action: "clear" });
    assert.equal(clearedViaTool.details?.loop, null);
    assert.equal(await loadSessionLoop(dir, ctx), undefined);

    await setSessionLoop(dir, ctx, {
      objective: "legacy paused loop",
      source: "explicit",
      status: "paused",
    });
    const legacyStatus = await executeSparkTool(run.tools, "loop", ctx, { action: "status" });
    assert.equal(legacyStatus.details?.loop, null);
    assert.equal(await loadSessionLoop(dir, ctx), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("Spark extension leaves Shift+Tab to the host thinking-level binding", () => {
  const run = registerSparkToolsForTest();
  assert.equal(run.shortcuts.has("shift+tab"), false);
});

test("impl_plan_tasks blocks underspecified executable tasks without opening a canned ask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-plan-not-ready-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("impl_plan_tasks should not open a task-plan ask");
    ctx.ui.custom = async () => assert.fail("impl_plan_tasks should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "clarify-plan",
          title: "Clarify underspecified plan",
          description: "Exercise task plan readiness validation.",
          kind: "implement",
        },
      ],
    });

    const details = planned.details as
      | {
          error?: string;
          planDecision?: {
            asked?: boolean;
            accepted?: boolean;
            blocked?: boolean;
            summary?: string;
          };
        }
      | undefined;
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.planDecision?.asked, false);
    assert.equal(details?.planDecision?.accepted, false);
    assert.equal(details?.planDecision?.blocked, true);
    assert.match(details?.planDecision?.summary ?? "", /fix: Add at least one observable entry/);
    assert.match(toolText(planned), /Task plan not ready: @clarify-plan/);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks rejects standalone design/planning tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-not-concrete-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "background-role-results-design",
          title: "设计 DAG 子 agent 完成结果的用户/父 agent 可见机制",
          description: "Decide how background child role-run results should be visible.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Decide result visibility."),
        },
      ],
    });

    assert.match(toolText(planned), /task_not_concrete/);
    assert.match(toolText(planned), /standalone design\/planning/);
    assert.match(toolText(planned), /embed the chosen design in each concrete task\.plan/);
    assert.equal((planned.details as { error?: string }).error, "task_not_concrete");
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks rejects invalid explicit kind and status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-invalid-kind-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              name: "invalid-kind",
              title: "Invalid kind",
              description: "Invalid kind must not become a generic task.",
              kind: "build",
              plan: executionReadyPlan("Reject invalid kind"),
            },
          ],
        }),
      /kind must be research, implement, or review/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              name: "project-ref-as-kind",
              title: "Project ref as kind",
              description: "Project refs should be passed via project/projectRef.",
              kind: "proj:demo-project",
              plan: executionReadyPlan("Reject project ref passed as kind"),
            },
          ],
        }),
      /kind received a project ref/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              name: "invalid-status",
              title: "Invalid status",
              description: "Invalid status must be rejected.",
              status: "waiting",
              plan: executionReadyPlan("Reject invalid status"),
            },
          ],
        }),
      /status must be pending, ready, running, blocked, done, failed, or cancelled/,
    );

    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks rejects invalid explicit task shapes without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-invalid-shape-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              title: 42,
              description: "Invalid title must not be trusted.",
              plan: executionReadyPlan("Reject invalid title."),
            },
          ],
        }),
      /tasks\[0\]\.title must be a string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              title: "Invalid dependency",
              description: "Invalid dependency must not reach graph planning.",
              dependsOn: [123],
              plan: executionReadyPlan("Reject invalid dependency."),
            },
          ],
        }),
      /tasks\[0\]\.dependsOn must be an array of strings/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              title: "Invalid risk",
              description: "Invalid plan risk must not be downgraded to normal.",
              plan: { ...executionReadyPlan("Reject invalid risk."), riskLevel: "urgent" },
            },
          ],
        }),
      /tasks\[0\]\.plan\.riskLevel must be trivial, normal, or high/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              title: "Invalid role",
              description: "Invalid role ref must not be ignored.",
              roleRef: 42,
              plan: executionReadyPlan("Reject invalid role."),
            },
          ],
        }),
      /tasks\[0\]\.roleRef must be a string/,
    );

    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks accepts cancelled cleanup tasks without success/evidence readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-cancelled-plan-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "retire-placeholder",
          title: "Retire placeholder task",
          description:
            "Historical placeholder that should be cancelled without execution evidence.",
          status: "cancelled",
        },
      ],
    });

    const details = planned.details as
      | { planDecisions?: Array<{ asked?: boolean; accepted?: boolean; blocked?: boolean }> }
      | undefined;
    assert.equal(details?.planDecisions?.[0]?.asked, false);
    assert.equal(details?.planDecisions?.[0]?.accepted, true);
    assert.equal(details?.planDecisions?.[0]?.blocked, false);
    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    const task = (await defaultTaskGraphStore(dir).load())?.tasks()[0];
    assert.equal(task?.status, "cancelled");
    assert.equal(task?.plan?.successCriteria.length, 0);
    assert.equal(task?.plan?.evidenceRequired.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks refuses to cancel tasks that still have dependents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-cancel-dependent-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      const prerequisite = graph.createTask({
        projectRef: project.ref,
        name: "kept-prereq",
        title: "Kept prerequisite",
        description: "A prerequisite that is still depended on.",
        status: "pending",
        plan: executionReadyPlan("Keep prerequisite"),
      });
      const dependent = graph.createTask({
        projectRef: project.ref,
        name: "dependent-work",
        title: "Dependent work",
        description: "Depends on the kept prerequisite.",
        status: "pending",
        plan: executionReadyPlan("Use prerequisite"),
      });
      graph.addDependency(dependent.ref, prerequisite.ref);
    });
    const before = await taskGraphSnapshotText(dir);
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "kept-prereq",
          title: "Kept prerequisite",
          description: "A prerequisite that is still depended on.",
          kind: "implement",
          status: "cancelled",
        },
      ],
    });

    assert.match(toolText(planned), /Task plan dependency error/);
    assert.match(toolText(planned), /cannot be cancelled/);
    assert.equal((planned.details as { error?: string }).error, "task_dependency_error");
    assert.equal(await taskGraphSnapshotText(dir), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task explains how to create or select a project when none exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-no-project-hint-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const claimed = await executeSparkTool(tools, "impl_claim_task", ctx, {
      name: "claim-without-project",
      title: "Claim without project",
      description: "Claim should report an actionable project setup hint.",
      kind: "implement",
    });

    assert.equal((claimed.details as { found?: boolean }).found, false);
    assert.match(toolText(claimed), /No Spark project found\./);
    assert.match(toolText(claimed), /Create or select a project/);
    assert.match(
      toolText(claimed),
      /task_write\(\{ action: "project_use", title, description \}\)/,
    );
    assert.doesNotMatch(toolText(claimed), /\/spark/);
    assert.equal(existsSync(join(dir, ".spark", "projects.json")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task can claim an existing named task without title or description", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-existing-by-name-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const graph = await defaultTaskGraphStore(dir).load();
    const project = graph?.projects()[0];
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "existing-named-task",
      title: "Existing named task",
      description: "Existing task fields should be inherited by name-only claim.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Existing task fields should be inherited by name-only claim."),
    });
    await defaultTaskGraphStore(dir).save(graph);

    const claimed = await executeSparkTool(tools, "impl_claim_task", ctx, {
      name: "existing-named-task",
    });

    assert.match(
      toolText(claimed),
      /Claimed Spark task: @existing-named-task: Existing named task/,
    );
    assert.match(toolText(claimed), /Task plan items are present for this claim/);
    const task = (await defaultTaskGraphStore(dir).load())?.tasks(project.ref)[0];
    assert.equal(task?.title, "Existing named task");
    assert.equal(task?.description, "Existing task fields should be inherited by name-only claim.");
    assert.equal(task?.claim?.sessionId, ctxSessionKey(ctx));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_status surfaces foreign-claim recovery guidance for blocked ready frontier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-status-stale-claim-guidance-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "status-stale-claim",
      title: "Status stale claim",
      description: "Status should explain how a foreign claim blocks the ready frontier.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Surface stale-claim recovery guidance in status."),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:old-owner",
      sessionId: "session:old-owner",
      leaseMs: 60_000,
    });
    await store.save(graph);

    const status = await executeSparkTool(tools, "impl_status", ctx, {});

    assert.match(
      toolText(status),
      /Recovery: ready_frontier is blocked by 1 other-session claimed task/,
    );
    assert.match(
      toolText(status),
      /reclaim with task_write\(\{ action: "claim", task: "@name" \}\)/,
    );
    const renderedProject = (
      status.details as {
        renderedProjects?: Array<{
          ref?: string;
          claimRecovery?: Array<{ name?: string; expired?: boolean; workflowIdle?: boolean }>;
        }>;
      }
    ).renderedProjects?.find((candidate) => candidate.ref === project.ref);
    assert.equal(renderedProject?.claimRecovery?.[0]?.name, "status-stale-claim");
    assert.equal(renderedProject?.claimRecovery?.[0]?.expired, false);
    assert.equal(renderedProject?.claimRecovery?.[0]?.workflowIdle, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task recovers an expired foreign claim when background work is idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-recover-expired-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "recover-expired-claim",
      title: "Recover expired claim",
      description:
        "Expired foreign claim should be safely recoverable when background work is idle.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Recover an expired foreign claim safely."),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:old-owner",
      sessionId: "session:old-owner",
      now: "2026-01-01T00:00:00.000Z",
      leaseMs: 1_000,
    });
    await store.save(graph);

    const claimed = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });

    assert.match(toolText(claimed), /Recovered previous task claim: claim_expired/);
    assert.match(toolText(claimed), /Recovery evidence: evidence:/);
    const details = claimed.details as {
      recoveredClaimEvidenceRef?: string;
      claimRecovery?: { recoverable?: boolean; reason?: string };
    };
    assert.equal(details.claimRecovery?.recoverable, true);
    assert.equal(details.claimRecovery?.reason, "claim_expired");
    assert.match(details.recoveredClaimEvidenceRef ?? "", /^evidence:/);
    const recovered = (await store.load())?.getTask(task.ref);
    assert.equal(recovered?.claim?.sessionId, ctxSessionKey(ctx));
    assert.equal(recovered?.status, "running");
    const artifact = await defaultEvidenceStore(dir).get(
      details.recoveredClaimEvidenceRef as EvidenceRef,
    );
    const body = artifact.body as {
      previousClaim?: { claimedBy?: string };
      decision?: { reason?: string };
    };
    assert.equal(body.previousClaim?.claimedBy, "session:old-owner");
    assert.equal(body.decision?.reason, "claim_expired");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task_write recover requeues needs_changes inactive-owner claim without marking done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-recover-needs-changes-requeue-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "recover-needs-changes",
      title: "Recover needs changes",
      description: "Recover a needs_changes task with evidence without marking it done.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Recover a needs_changes inactive-owner claim."),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:old-owner",
      sessionId: "session:old-owner",
      now: "2026-01-01T00:00:00.000Z",
      leaseMs: 365 * 24 * 60 * 60 * 1_000,
    });
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "document",
      title: "Final evidence that still needs review changes",
      format: "markdown",
      body: "# Evidence\n\nThe work has evidence but still received needs_changes.",
      provenance: { producer: "task", projectRef: project.ref, taskRef: task.ref },
    });
    graph.attachOutputEvidence(task.ref, evidence.ref);
    await store.save(graph);
    await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Task finish review for @recover-needs-changes",
      format: "json",
      body: { verdict: { outcome: "needs_changes", summary: "Still needs changes." } },
      provenance: { producer: "review", projectRef: project.ref, taskRef: task.ref },
    });

    const before = await executeSparkTool(tools, "impl_status", ctx, {});
    const beforeProject = (
      before.details as {
        renderedProjects?: Array<{ ref?: string; taskCounts?: { ready?: number } }>;
      }
    ).renderedProjects?.find((candidate) => candidate.ref === project.ref);
    assert.equal(beforeProject?.taskCounts?.ready, 0);

    const recovered = await executeSparkTool(tools, "task_write", ctx, {
      action: "recover",
      taskRef: task.ref,
    });

    assert.match(toolText(recovered), /Recovered Spark task claim: @recover-needs-changes/);
    assert.match(toolText(recovered), /Reason: review_needs_changes_owner_inactive/);
    assert.match(
      toolText(recovered),
      /Task is now unclaimed and can re-enter the ready frontier; it was not marked done/,
    );
    const recoveredDetails = recovered.details as {
      recoveredClaimEvidenceRef?: string;
      claimRecovery?: { recoverable?: boolean; reason?: string };
    };
    assert.match(recoveredDetails.recoveredClaimEvidenceRef ?? "", /^evidence:/);
    assert.equal(recoveredDetails.claimRecovery?.recoverable, true);
    assert.equal(recoveredDetails.claimRecovery?.reason, "review_needs_changes_owner_inactive");

    const after = await executeSparkTool(tools, "impl_status", ctx, {});
    const afterProject = (
      after.details as {
        renderedProjects?: Array<{ ref?: string; taskCounts?: { ready?: number } }>;
      }
    ).renderedProjects?.find((candidate) => candidate.ref === project.ref);
    assert.equal(afterProject?.taskCounts?.ready, 1);
    const reloaded = (await store.load())?.getTask(task.ref);
    assert.equal(reloaded?.status, "pending");
    assert.equal(reloaded?.claim, undefined);
    assert.equal(reloaded?.outputEvidenceRefs.includes(evidence.ref), true);
    assert.notEqual(reloaded?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task_write release gives up the current claim without finishing or dropping task state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-release-current-claim-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Release preservation evidence",
      format: "json",
      body: { summary: "Keep this evidence attached after release." },
      provenance: { producer: "task", projectRef: project.ref },
    });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "release-current-claim",
      title: "Release current claim",
      description: "Release must preserve plan items and evidence without finishing the task.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Release the current task claim safely."),
      todos: [
        {
          content: "Assert exact task plan and evidence state before and after claim release",
          status: "done",
        },
        {
          content:
            "Run pnpm test test/spark-tools.test.ts -t task_write release and record exit code 0",
          status: "pending",
        },
      ],
    });
    graph.attachOutputEvidence(task.ref, evidence.ref);
    const runRef = newRef("run");
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: ctxSessionKey(ctx),
      sessionId: ctxSessionKey(ctx),
      runRef,
      leaseMs: 60_000,
    });
    const before = graph.getTask(task.ref);
    const beforePlan = structuredClone(before.plan);
    const beforeTodos = structuredClone(graph.taskTodos(task.ref));
    const beforeEvidenceRefs = [...before.outputEvidenceRefs];
    await store.save(graph);
    const evidenceCount = (await defaultEvidenceStore(dir).list()).length;
    const learningCount = (await defaultLearningStore(dir).list({ includeCandidates: true }))
      .length;

    const released = await executeSparkTool(tools, "task_write", ctx, { action: "release" });

    assert.match(toolText(released), /Released Spark task claim: @release-current-claim/);
    assert.match(toolText(released), /Task remains unfinished/);
    const releaseDetails = released.details as {
      releasedBy?: string;
      previousClaim?: { runRef?: string; sessionId?: string };
    };
    assert.equal(releaseDetails.releasedBy, ctxSessionKey(ctx));
    assert.equal(releaseDetails.previousClaim?.runRef, runRef);
    assert.equal(releaseDetails.previousClaim?.sessionId, ctxSessionKey(ctx));
    const reloaded = await store.load();
    assert.ok(reloaded);
    const releasedTask = reloaded.getTask(task.ref);
    assert.equal(releasedTask.status, "pending");
    assert.equal(releasedTask.claim, undefined);
    assert.deepEqual(releasedTask.plan, beforePlan);
    assert.deepEqual(reloaded.taskTodos(task.ref), beforeTodos);
    assert.deepEqual(releasedTask.outputEvidenceRefs, beforeEvidenceRefs);
    assert.equal(
      reloaded.readyTasks(project.ref).some((candidate) => candidate.ref === task.ref),
      true,
    );

    reloaded.claimTask(task.ref, {
      kind: "main",
      claimedBy: ctxSessionKey(ctx),
      sessionId: ctxSessionKey(ctx),
      leaseMs: 60_000,
    });
    await store.save(reloaded);
    const explicitlyReleased = await executeSparkTool(tools, "task_write", ctx, {
      action: "release",
      taskRef: task.ref,
    });
    assert.match(toolText(explicitlyReleased), /Released Spark task claim: @release-current-claim/);
    assert.equal((await store.load())?.getTask(task.ref).claim, undefined);
    assert.equal((await defaultEvidenceStore(dir).list()).length, evidenceCount);
    assert.equal(
      (await defaultLearningStore(dir).list({ includeCandidates: true })).length,
      learningCount,
    );

    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
      projectRef: project.ref,
      format: "json",
    });
    const statusDetails = status.details as {
      selectedProject?: { taskCounts?: { claimedByCurrentSession?: number } };
      currentClaim?: unknown;
    };
    assert.equal(statusDetails.selectedProject?.taskCounts?.claimedByCurrentSession, 0);
    assert.equal(statusDetails.currentClaim, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task_write release rejects non-owner, unclaimed, terminal, and unrelated inputs without mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-release-refusals-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const create = (name: string, status: "ready" | "done" | "failed" | "cancelled") =>
      graph.createTask({
        projectRef: project.ref,
        name,
        title: name,
        description: `Release refusal fixture for ${name}.`,
        kind: "implement",
        status,
        plan: executionReadyPlan(`Refuse release for ${name}.`),
      });
    const foreign = create("foreign-claim", "ready");
    graph.claimTask(foreign.ref, {
      kind: "main",
      claimedBy: "session:other",
      sessionId: "session:other",
      leaseMs: 60_000,
    });
    const cases = [
      { task: foreign, error: "claimed_by_other" },
      { task: create("unclaimed", "ready"), error: "task_unclaimed" },
      { task: create("terminal-done", "done"), error: "task_terminal" },
      { task: create("terminal-failed", "failed"), error: "task_terminal" },
      { task: create("terminal-cancelled", "cancelled"), error: "task_terminal" },
    ];
    await store.save(graph);

    for (const entry of cases) {
      const taskPath = join(
        dir,
        ".spark",
        "projects",
        project.ref.replace(":", "-"),
        "tasks",
        entry.task.ref.replace(":", "-"),
        "task.json",
      );
      const before = await readFile(taskPath);
      const refused = await executeSparkTool(tools, "task_write", ctx, {
        action: "release",
        taskRef: entry.task.ref,
      });
      assert.equal((refused.details as { error?: string }).error, entry.error);
      assert.deepEqual(await readFile(taskPath), before);
    }

    const noCurrentClaim = await executeSparkTool(tools, "task_write", ctx, {
      action: "release",
    });
    assert.equal((noCurrentClaim.details as { error?: string }).error, "no_current_claim");
    await assert.rejects(
      () =>
        executeSparkTool(tools, "task_write", ctx, {
          action: "release",
          taskRef: cases[1]?.task.ref,
          status: "done",
        }),
      /accepts only project\/projectRef and task\/taskRef; unexpected: status/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task refuses stale-claim recovery while workflow work is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-recovery-active-workflow-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "refuse-active-workflow-recovery",
      title: "Refuse active workflow recovery",
      description: "Expired claim must not be recovered while workflow work is active.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Refuse stale-claim recovery while workflow work is active."),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:old-owner",
      sessionId: "session:old-owner",
      now: "2026-01-01T00:00:00.000Z",
      leaseMs: 1_000,
    });
    await store.save(graph);
    await defaultWorkflowRunStore(dir).startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 10_000,
    });

    const refused = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });

    assert.match(toolText(refused), /Claim recovery refused: active_workflow_run/);
    const details = refused.details as {
      error?: string;
      claimRecovery?: { recoverable?: boolean; reason?: string };
    };
    assert.equal(details.error, "claimed_by_other");
    assert.equal(details.claimRecovery?.recoverable, false);
    assert.equal(details.claimRecovery?.reason, "active_workflow_run");
    const stillClaimed = (await store.load())?.getTask(task.ref);
    assert.equal(stillClaimed?.claim?.sessionId, "session:old-owner");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical task claim can claim an existing planned task by taskRef", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-write-claim-existing-by-ref-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const graph = await defaultTaskGraphStore(dir).load();
    const project = graph?.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "planned-ready-task",
      title: "Planned ready task",
      description: "A planned task should be claimable through the canonical task facade.",
      kind: "research",
      status: "ready",
      plan: executionReadyPlan("Audit a ready planned task through the canonical task facade."),
    });
    await defaultTaskGraphStore(dir).save(graph);

    const claimed = await executeSparkTool(tools, "task_write", ctx, {
      action: "claim",
      taskRef: task.ref,
    });

    assert.match(toolText(claimed), /Claimed Spark task: @planned-ready-task: Planned ready task/);
    const claimedTask = (await defaultTaskGraphStore(dir).load())?.getTask(task.ref);
    assert.equal(claimedTask?.claim?.sessionId, ctxSessionKey(ctx));
    assert.equal(
      claimedTask?.plan?.objective,
      "Audit a ready planned task through the canonical task facade.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical task claim preserves every explicit unfinished status", async () => {
  for (const status of ["pending", "ready", "running", "blocked"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `task-write-claim-status-${status}-`));
    try {
      await writeEmptySparkProject(dir);
      const ctx = testSparkContext(dir, `status-${status}`);
      const { tools } = registerSparkToolsForTest();
      await useOnlySparkProject(tools, ctx);
      const graph = await defaultTaskGraphStore(dir).load();
      const project = graph?.projects()[0];
      assert.ok(project);
      const task = graph.createTask({
        projectRef: project.ref,
        name: `claim-status-${status}`,
        title: `Claim status ${status}`,
        description: `Explicit ${status} must survive daemon-owned claim acquisition.`,
        kind: "implement",
        status: "ready",
        plan: executionReadyPlan(`Preserve explicit ${status} during claim acquisition.`),
      });
      await defaultTaskGraphStore(dir).save(graph);

      await executeSparkTool(tools, "task_write", ctx, {
        action: "claim",
        taskRef: task.ref,
        status,
      });

      const claimedTask = (await defaultTaskGraphStore(dir).load())?.getTask(task.ref);
      assert.equal(claimedTask?.status, status);
      assert.equal(claimedTask?.claim?.sessionId, ctxSessionKey(ctx));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("impl_claim_task rejects ephemeral main-claim ownership deterministically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-ephemeral-rejected-"));
  try {
    const persistent = testSparkContext(dir, "ephemeral");
    const ctx: TestSparkContext = {
      ...persistent,
      sessionId: "",
      sessionManager: {
        getSessionFile: () => undefined,
        getLeafId: () => undefined,
      },
    };
    const { tools } = registerSparkToolsForTest();

    const rejected = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: "task:unreachable",
    });

    assert.equal((rejected.details as { error?: string }).error, "durable_session_required");
    assert.match(toolText(rejected), /persistent session/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task rejects inline plan on claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-plan-rejected-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const rejected = await executeSparkTool(tools, "impl_claim_task", ctx, {
      name: "claim-plan-patch",
      title: "Inline plan claim",
      description: "Inline plan on claim must be rejected.",
      kind: "implement",
      plan: executionReadyPlan("Inline plan on claim must be rejected."),
    });

    assert.equal((rejected.details as { error?: string }).error, "claim_plan_not_allowed");
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task returns structured task plan details after claiming a planned task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-plan-output-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    const project = graph?.projects()[0];
    assert.ok(graph);
    assert.ok(project);
    const planned = graph.createTask({
      projectRef: project.ref,
      name: "claim-plan-output",
      title: "Claim plan output",
      description: "Claim output should surface the plan.",
      kind: "implement",
      status: "ready",
      plan: {
        ...executionReadyPlan("Surface the claim plan summary."),
        constraints: ["Keep output compact", "Do not remove details.task"],
        successCriteria: ["Claim output text includes the success criteria and plan items."],
        evidenceRequired: ["Focused test output proves plan fields are rendered."],
        steps: ["Render the plan details", "Validate task plan item prompt text"],
      },
    });
    await store.save(graph);

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: planned.ref,
    });

    const claimedTask = claim.details?.task as
      | {
          ref?: TaskRef;
          name?: string;
          title?: string;
          plan?: TaskPlan;
          claim?: { sessionId?: string };
        }
      | undefined;
    assert.equal(claimedTask?.ref, planned.ref);
    assert.equal(claimedTask?.name, "claim-plan-output");
    assert.equal(claimedTask?.title, "Claim plan output");
    assert.equal(claimedTask?.claim?.sessionId, ctxSessionKey(ctx));
    assert.deepEqual(claimedTask?.plan?.successCriteria, [
      "Claim output text includes the success criteria and plan items.",
    ]);
    assert.deepEqual(claimedTask?.plan?.evidenceRequired, [
      "Focused test output proves plan fields are rendered.",
    ]);
    assert.deepEqual(claimedTask?.plan?.constraints, [
      "Keep output compact",
      "Do not remove details.task",
    ]);
    assert.deepEqual(
      claimedTask?.plan?.items?.map((item) => item.title),
      ["Render the plan details", "Validate task plan item prompt text"],
    );
    const reloaded = await defaultTaskGraphStore(dir).load();
    assert.deepEqual(
      reloaded?.taskTodos(planned.ref).map((todo) => [todo.content, todo.status]),
      [
        ["Render the plan details", "pending"],
        ["Validate task plan item prompt text", "pending"],
      ],
    );
    assert.equal(existsSync(sessionTaskTodoPath(dir, ctx)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task requires an existing bound task plan instead of asking at claim time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-claim-no-plan-ask-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    const project = graph?.projects()[0];
    assert.ok(graph);
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "claim-plan",
      title: "Claim underspecified plan",
      description: "Claiming should not ask for task plan refinement.",
      kind: "implement",
      status: "ready",
    });
    await store.save(graph);

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });

    const details = claim.details as
      | { error?: string; issues?: Array<{ kind?: string; severity?: string }> }
      | undefined;
    assert.equal(details?.error, "task_plan_required");
    assert.deepEqual(
      details?.issues?.map((issue) => [issue.kind, issue.severity]),
      [
        ["missing_success_criteria", "blocking"],
        ["missing_evidence_required", "blocking"],
        ["weak_plan_items", "blocking"],
      ],
    );
    const reloaded = await defaultTaskGraphStore(dir).load();
    assert.equal(reloaded?.getTask(task.ref).claim, undefined);
    assert.equal((await defaultEvidenceStore(dir).list({ kind: "record" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task and impl_update_task_plan_items persist task plan items across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-todos-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    const project = graph?.projects()[0];
    assert.ok(graph);
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "persist-todos",
      title: "Persist task plan items",
      description: "Exercise task plan-item persistence through Spark tools.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Exercise task plan-item persistence through Spark tools."),
    });
    await store.save(graph);

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });
    const claimedTask = claim.details?.task as
      | {
          ref?: TaskRef;
          name?: string;
          claim?: { sessionId?: string };
        }
      | undefined;
    assert.equal(claimedTask?.name, "persist-todos");
    assert.ok(claimedTask?.ref);
    assert.equal(claimedTask.claim?.sessionId, ctxSessionKey(ctx));

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [{ op: "init", items: ["Read sources", "Run focused tests"] }],
    });

    const afterClaimGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(afterClaimGraph);
    const afterClaim = afterClaimGraph.taskTodos(claimedTask.ref);
    assert.equal(afterClaim.length, 2);
    assert.deepEqual(
      afterClaim.map((todo) => [todo.content, todo.status]),
      [
        ["Read sources", "in_progress"],
        ["Run focused tests", "pending"],
      ],
    );
    assert.match(await taskGraphSnapshotText(dir), /Read sources/);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "done", item: "Read sources" },
        { op: "append", items: ["Check reload"] },
        { op: "note", item: "Run focused tests", text: "Persisted after reload" },
      ],
    });

    const afterUpdateGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(afterUpdateGraph);
    const afterUpdate = afterUpdateGraph.taskTodos(claimedTask.ref);
    assert.deepEqual(
      afterUpdate.map((todo) => [todo.content, todo.status, todo.notes ?? []]),
      [
        ["Read sources", "done", []],
        ["Run focused tests", "in_progress", ["Persisted after reload"]],
        ["Check reload", "pending", []],
      ],
    );

    const reloadedGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(reloadedGraph);
    assert.deepEqual(
      reloadedGraph.taskTodos(claimedTask.ref).map((todo) => [todo.content, todo.status]),
      [
        ["Read sources", "done"],
        ["Run focused tests", "in_progress"],
        ["Check reload", "pending"],
      ],
    );

    const reloaded = registerSparkToolsForTest();
    const status = await executeSparkTool(reloaded.tools, "impl_status", ctx, {});
    const statusText = toolText(status);
    assert.match(statusText, /Persist task plan items/);
    assert.match(statusText, /\[done\].*Read sources/);
    assert.match(statusText, /\[in_progress\].*Run focused tests/);
    assert.match(statusText, /\[pending\].*Check reload/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_update_task_plan_items supports upsert_done with planned task item sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-plan-item-upsert-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    const project = graph?.projects()[0];
    assert.ok(graph);
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "todo-upsert-sync",
      title: "plan item upsert sync",
      description: "Exercise task plan item upsert and plan sync operations.",
      kind: "implement",
      status: "ready",
      plan: {
        ...executionReadyPlan("Exercise task plan item upsert and plan sync operations."),
        successCriteria: ["Plan sync test output includes the represented criterion."],
        steps: ["Inspect plan item sync state", "Verify plan item sync output"],
      },
    });
    await store.save(graph);

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
          ops: [{ op: "done", item: "Typo TODO" }],
        }),
      /unknown todo item: Typo TODO/,
    );

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "upsert_done", item: "Verify plan item sync output" },
        { op: "upsert_done", item: "Ad hoc validation completed" },
      ],
    });
    const updatedGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(updatedGraph);
    const todos = updatedGraph.taskTodos(taskRef);
    assert.deepEqual(
      todos.map((todo) => [todo.content, todo.status]),
      [
        ["Inspect plan item sync state", "in_progress"],
        ["Verify plan item sync output", "done"],
        ["Ad hoc validation completed", "done"],
      ],
    );
    assert.match(
      todos.find((todo) => todo.content === "Ad hoc validation completed")?.notes?.[0] ?? "",
      /upsert_done created this TODO as done/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks syncs concrete plan items into task plan items", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-task-todo-sync-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "planned-todo-sync",
          title: "Planned plan item sync",
          description: "Planned task should get concrete TODOs from its plan.",
          kind: "implement",
          plan: {
            ...executionReadyPlan("Planned task should get concrete TODOs from its plan."),
            successCriteria: ["Plan sync test output includes the represented planned criterion."],
            steps: ["Inspect planned plan-item sync state", "Verify planned plan-item sync output"],
          },
        },
      ],
    });

    const created = (planned.details?.result as { created?: Array<{ ref?: TaskRef }> } | undefined)
      ?.created?.[0]?.ref;
    assert.ok(created);
    assert.deepEqual(
      (planned.details as { planTodoSync?: Array<{ items?: string[] }> }).planTodoSync?.[0]?.items,
      [],
    );
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const todos = graph.taskTodos(created);
    assert.deepEqual(
      todos.map((todo) => [todo.content, todo.status]),
      [
        ["Inspect planned plan-item sync state", "pending"],
        ["Verify planned plan-item sync output", "pending"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark rename tools improve obvious placeholder project and generic task names without changing refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-rename-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "「自定义输入」", description: "placeholder" });
    const generic = graph.createTask({
      projectRef: project.ref,
      name: "capture-project-intent",
      title: "Capture project intent",
      description: "Old broad placeholder task.",
      kind: "interaction",
      status: "running",
      plan: executionReadyPlan("Update generic task display names while preserving stable refs."),
    });
    const existing = graph.createTask({
      projectRef: project.ref,
      name: "implement-safe-naming",
      title: "Other naming task",
      description: "Ensure rename conflict suffixes are safe.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });

    const renamedProject = await executeSparkTool(tools, "impl_project_mutation", ctx, {
      intent: "rename",
      title: "Autonomous Spark naming quality",
    });
    const renamedProjectDetails = renamedProject.details?.project as
      | { ref?: ProjectRef; title?: string }
      | undefined;
    assert.equal(renamedProjectDetails?.ref, project.ref);
    assert.equal(renamedProjectDetails?.title, "Autonomous Spark naming quality");
    assert.equal(
      Object.hasOwn(renamedProjectDetails ?? {}, "status"),
      false,
      "Project mutation details must not expose Project.status",
    );

    const statusOnlyMutation = await executeSparkTool(tools, "impl_project_mutation", ctx, {
      intent: "metadata_update",
      project: project.ref,
      status: "done",
    });
    assert.equal(statusOnlyMutation.isError, true);
    assert.equal(
      (statusOnlyMutation.details as { error?: string }).error,
      "project_status_removed",
    );

    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      title: "Implement safe naming",
      description: "Update generic task display names while preserving stable refs.",
      kind: "implement",
    });
    const claimedTask = claim.details?.task as
      | { ref?: TaskRef; name?: string; title?: string }
      | undefined;
    assert.equal(claimedTask?.ref, generic.ref);
    assert.equal(claimedTask?.title, "Implement safe naming");
    assert.equal(claimedTask?.name, "implement-safe-naming-2");

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getProject(project.ref).title, "Autonomous Spark naming quality");
    assert.equal(loaded.getTask(generic.ref).name, "implement-safe-naming-2");
    assert.equal(loaded.getTask(existing.ref).name, "implement-safe-naming");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task project mutation actions preserve permanent projects and reject lifecycle actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-intents-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Existing project",
      description: "Only project in graph.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      project: project.ref,
    });

    await assert.rejects(
      () =>
        executeSparkTool(tools, "task_write", ctx, {
          action: "project_update",
          project: project.ref,
          title: "Old overloaded action",
        }),
      /task_write\.action must be one of:.*project_rename.*project_metadata_update/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "task_write", ctx, { action: "project_finish" }),
      /task_write\.action must be one of:/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "task_write", ctx, {
          action: "project_status_update",
          status: "done",
        }),
      /task_write\.action must be one of:/,
    );

    const missing = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_rename",
      project: "Missing project",
      title: "Better project title",
    });
    assert.equal(missing.isError, true);
    assert.equal((missing.details as { error?: string }).error, "no_project");
    assert.match(toolText(missing), /No matching Spark project found/);

    const renamed = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_rename",
      title: "Intent-specific project title",
    });
    assert.match(toolText(renamed), /Renamed Spark project:/);
    assert.equal((renamed.details as { titleBefore?: string }).titleBefore, "Existing project");
    assert.equal(
      (renamed.details as { titleAfter?: string }).titleAfter,
      "Intent-specific project title",
    );

    const metadata = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_metadata_update",
      description: "Updated description.",
      purpose: "Updated purpose.",
    });
    assert.match(toolText(metadata), /Updated Spark project metadata/);
    assert.deepEqual((metadata.details as { changedFields?: string[] }).changedFields?.sort(), [
      "description",
      "purpose",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task preserves intentional task names when only the title improves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-intentional-name-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Hypha v0", description: "intentional" });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "hypha-v0",
      title: "Current task",
      description: "Generic title, intentional @name.",
      kind: "interaction",
      status: "running",
      plan: executionReadyPlan(
        "Narrow the active Hypha work without replacing the intentional handle.",
      ),
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      title: "Implement editor diagnostics slice",
      description: "Narrow the active Hypha work without replacing the intentional handle.",
      kind: "implement",
    });
    const claimedTask = claim.details?.task as
      | { ref?: TaskRef; name?: string; title?: string }
      | undefined;
    assert.equal(claimedTask?.ref, task.ref);
    assert.equal(claimedTask?.name, "hypha-v0");
    assert.equal(claimedTask?.title, "Implement editor diagnostics slice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task refuses to create a new task when generic rename candidates are ambiguous", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-ambiguous-name-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Spark project", description: "placeholder" });
    const first = graph.createTask({
      projectRef: project.ref,
      name: "task-deadbeefcafebabe",
      title: "整理一下",
      description: "First generic non-ASCII placeholder.",
      kind: "interaction",
      status: "running",
    });
    const second = graph.createTask({
      projectRef: project.ref,
      name: "capture-project-intent",
      title: "Capture project intent",
      description: "Second generic placeholder.",
      kind: "interaction",
      status: "running",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      title: "Implement concrete naming policy test",
      description:
        "No existing task can be chosen without guessing because multiple generic tasks are present.",
      kind: "implement",
    });
    assert.equal((claim.details as { error?: string }).error, "task_not_found");
    assert.match(toolText(claim), /no existing planned task matched/);

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(first.ref).name, "task-deadbeefcafebabe");
    assert.equal(loaded.getTask(second.ref).name, "capture-project-intent");
    assert.equal(loaded.tasks(project.ref).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task rejects terminal statuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-terminal-claim-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const rejected = await executeSparkTool(tools, "impl_claim_task", ctx, {
      name: "terminal-claim",
      title: "Terminal claim",
      description: "Attempt to finish through the claim tool.",
      kind: "implement",
      status: "done",
    });

    assert.equal(rejected.details?.error, "terminal_status_not_allowed");
    assert.match(toolText(rejected), /only accepts unfinished statuses/);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    assert.equal(
      graph.tasks(project.ref).some((task) => task.name === "terminal-claim"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task rejects invalid explicit kind and status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-invalid-claim-kind-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_claim_task", ctx, {
          title: "Invalid claim kind",
          description: "Invalid kind must not become interaction.",
          kind: "build",
        }),
      /kind must be research, implement, or review/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_claim_task", ctx, {
          title: "Invalid claim status",
          description: "Invalid status must not become running.",
          status: "waiting",
        }),
      /status must be pending, ready, running, blocked, done, failed, or cancelled/,
    );

    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_claim_task rejects invalid explicit task shapes without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-invalid-claim-shape-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_claim_task", ctx, {
          title: 42,
          description: "Invalid title must not be trusted.",
        }),
      /title must be a string/,
    );
    const inlinePlan = await executeSparkTool(tools, "impl_claim_task", ctx, {
      title: "Invalid risk",
      description: "Claim must reject every inline plan before validating plan fields.",
      plan: { ...executionReadyPlan("Reject invalid risk."), riskLevel: "urgent" },
    });
    assert.equal((inlinePlan.details as { error?: string }).error, "claim_plan_not_allowed");
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_claim_task", ctx, {
          title: "Invalid role",
          description: "Invalid role ref must not be ignored.",
          roleRef: 42,
        }),
      /roleRef must be a string/,
    );

    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task completes this session's claimed task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-task-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-me",
      title: "Finish me",
      description: "Exercise task lifecycle completion.",
      plan: executionReadyPlan("Finish me"),
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);
    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [{ op: "init", items: ["Run focused finish lifecycle test"] }],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Done for test.",
    });
    assert.match(toolText(finished), /Task finish blocked by open task plan items/);
    assert.equal((finished.details as { error?: string } | undefined)?.error, "open_plan_items");

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [{ op: "done", item: "Run focused finish lifecycle test" }],
    });
    const missingEvidence = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Done for test.",
    });
    assert.match(toolText(missingEvidence), /Task finish blocked by completion readiness/);
    assert.equal(
      (missingEvidence.details as { error?: string } | undefined)?.error,
      "missing_completion_evidence",
    );

    const completed = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Done for test.",
      evidence: successfulFinishEvidence("Focused finish lifecycle validation"),
    });
    assert.match(toolText(completed), /Finished Spark task: \[done\] @finish-me: Finish me/);
    assert.match(toolText(completed), /Evidence recorded: evidence:/);
    assert.match(
      toolText(completed),
      /Learning candidate: evidence:.* — Candidate from @finish-me/,
    );
    assert.equal((completed.details?.task as { status?: string } | undefined)?.status, "done");
    assert.equal((completed.details as { statusBefore?: string }).statusBefore, "running");
    assert.equal((completed.details as { statusAfter?: string }).statusAfter, "done");
    assert.deepEqual(
      (completed.details as { transition?: { committed?: boolean; statusBefore?: string } })
        .transition,
      {
        requestedStatus: "done",
        statusBefore: "running",
        statusAfter: "done",
        committed: true,
      },
    );
    assert.equal((completed.details as { reviewRequired?: boolean }).reviewRequired, true);
    assert.equal((completed.details?.review as { approved?: boolean } | undefined)?.approved, true);
    assert.ok(
      (completed.details as { reviewEvidence?: string }).reviewEvidence?.startsWith("evidence:"),
    );
    assert.equal(
      (completed.details as { reviewer?: { required?: boolean; approved?: boolean } }).reviewer
        ?.required,
      true,
    );
    assert.equal(
      (completed.details?.completionReadiness as { ready?: boolean } | undefined)?.ready,
      true,
    );
    const generatedEvidenceRef = (completed.details as { generatedEvidenceRef?: EvidenceRef })
      .generatedEvidenceRef;
    assert.ok(generatedEvidenceRef);
    assert.deepEqual((completed.details as { evidenceRefs?: string[] }).evidenceRefs, [
      generatedEvidenceRef,
    ]);
    assert.deepEqual((completed.details as { inputEvidenceRefs?: string[] }).inputEvidenceRefs, [
      generatedEvidenceRef,
    ]);
    assert.deepEqual(
      (completed.details as { remainingReadyTasks?: unknown[] }).remainingReadyTasks,
      [],
    );
    assert.equal(
      (completed.details as { projectCompletionCandidate?: { ready?: boolean } })
        .projectCompletionCandidate?.ready,
      true,
    );
    assert.equal(
      (completed.details?.learningCandidate as { status?: string } | undefined)?.status,
      "candidate",
    );
    assert.match(
      (completed.details?.learningCandidate as { title?: string } | undefined)?.title ?? "",
      /Candidate from @finish-me/,
    );
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 1);
    assert.equal((await defaultLearningStore(dir).list()).length, 0);

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "done");
    assert.equal(loaded.getTask(taskRef).claim, undefined);
    const reviewEvidences = await defaultEvidenceStore(dir).list({ kind: "record" });
    assert.equal(reviewEvidences.length, 1);
    const reviewDir = taskReviewDirectory(dir, loaded.getTask(taskRef).projectRef, taskRef);
    const reviewIndex = JSON.parse(await readFile(join(reviewDir, "index.json"), "utf8")) as {
      reviews: Array<{ subjectKind?: string; subjectRef?: string; evidenceRef?: string }>;
    };
    assert.equal(reviewIndex.reviews[0]?.subjectKind, "task");
    assert.equal(reviewIndex.reviews[0]?.subjectRef, taskRef);
    assert.equal(reviewIndex.reviews[0]?.evidenceRef, reviewEvidences[0]?.ref);
    const subjectReview = JSON.parse(
      await readFile(subjectReviewRecordPath(reviewDir, reviewEvidences[0]!.ref), "utf8"),
    ) as { subjectKind?: string; subjectRef?: string; outcome?: string };
    assert.equal(subjectReview.subjectKind, "task");
    assert.equal(subjectReview.subjectRef, taskRef);
    assert.equal(subjectReview.outcome, "approved");
    const workspaceReviewIndex = await rebuildWorkspaceReviewIndex(dir);
    const reviewEntry = workspaceReviewIndex.reviews.find((entry) => entry.subjectRef === taskRef);
    assert.equal(reviewEntry?.subjectKind, "task");
    assert.match(
      reviewEntry?.path ?? "",
      /projects\/proj-.*\/tasks\/task-.*\/reviews\/evidence-.*\.json/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task commits a canonical managed role-run claim without main-claim authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-managed-role-run-"));
  try {
    const ctx = testSparkContext(dir, "sess_task_worker");
    const sessionKey = sparkSessionKey(ctx);
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Managed Task Session",
      description: "Exercise managed role-run completion.",
    });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "managed-role-run",
      title: "Managed role-run",
      description: "Finish through the managed Task Session identity.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Finish managed role-run"),
    });
    graph.claimTask(task.ref, {
      kind: "role-run",
      claimedBy: sessionKey,
      sessionId: sessionKey,
      roleRef: "role:builtin-explorer" as RoleRef,
      runName: "managed-role-run",
      leaseMs: 600_000,
    });
    const claimed = graph.getTask(task.ref);
    assert.ok(claimed.plan);
    graph.updateTask(task.ref, {
      plan: {
        ...claimed.plan,
        items: (claimed.plan.items ?? []).map((item) => ({
          ...item,
          status: "done" as const,
          updatedAt: new Date().toISOString(),
        })),
      },
    });
    await defaultTaskGraphStore(dir).save(graph);
    await saveCurrentProjectRef(dir, ctx, project.ref);

    let mainAuthorityCalls = 0;
    const rejectMainAuthority = async (): Promise<never> => {
      mainAuthorityCalls += 1;
      throw new Error("managed role-run completion must not enter main claim authority");
    };
    const { tools } = registerSparkToolsForTest({
      taskClaimDaemonClient: {
        acquire: rejectMainAuthority,
        recover: rejectMainAuthority,
        release: rejectMainAuthority,
      },
    });
    const completed = await executeSparkTool(tools, "impl_finish_task", ctx, {
      task: task.ref,
      summary: "Managed Task Session completed its assigned role-run.",
      evidence: successfulFinishEvidence("Managed role-run validation"),
    });

    assert.match(toolText(completed), /Finished Spark task: \[done\] @managed-role-run/);
    assert.equal(mainAuthorityCalls, 0);
    assert.equal((await defaultTaskGraphStore(dir).load())?.getTask(task.ref).status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task returns structured transition data for failed no-review completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-failed-structured-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          throw new Error("failed status must not invoke reviewer");
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    await planAndClaimTask(tools, ctx, {
      name: "finish-failed-no-review",
      title: "Finish failed without review",
      description: "Terminal failed status should not run the reviewer gate.",
      plan: executionReadyPlan("Finish failed without review"),
    });

    const failed = await executeSparkTool(tools, "impl_finish_task", ctx, {
      status: "failed",
      summary: "External validation failed.",
    });

    assert.match(toolText(failed), /Finished Spark task: \[failed\]/);
    assert.equal(reviewerCalls, 0);
    assert.equal((failed.details as { statusBefore?: string }).statusBefore, "running");
    assert.equal((failed.details as { statusAfter?: string }).statusAfter, "failed");
    assert.equal((failed.details as { reviewRequired?: boolean }).reviewRequired, false);
    assert.equal((failed.details as { review?: unknown }).review, undefined);
    assert.equal(
      (failed.details as { reviewer?: { required?: boolean } }).reviewer?.required,
      false,
    );
    assert.equal(
      (failed.details as { transition?: { committed?: boolean } }).transition?.committed,
      true,
    );
    assert.equal((failed.details as { learningCandidate?: unknown }).learningCandidate, undefined);
    assert.equal(
      (failed.details as { projectCompletionCandidate?: { ready?: boolean } })
        .projectCompletionCandidate?.ready,
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task attaches evidenceRefs before reviewer gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-evidence-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerEvidenceRefs: string[] = [];
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          if (input.targetKind === "task") reviewerEvidenceRefs = input.evidenceRefs;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Focused validation evidence",
      format: "markdown",
      body: "Targeted tests passed.",
      provenance: { producer: "task" },
    });

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-evidence",
      title: "Finish with evidence",
      description: "Finish should pass explicit evidence refs to reviewer.",
      plan: executionReadyPlan("Finish with evidence"),
      todos: ["Attach evidence and finish task"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Attach evidence and finish task"] },
        { op: "done", item: "Attach evidence and finish task" },
      ],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Validated with attached evidence.",
      evidenceRefs: [evidence.ref],
    });

    assert.match(toolText(finished), /Finished Spark task: \[done\] @finish-evidence/);
    assert.deepEqual(reviewerEvidenceRefs, [evidence.ref]);
    assert.deepEqual((finished.details as { evidenceRefs?: string[] }).evidenceRefs, [
      evidence.ref,
    ]);
    assert.deepEqual((finished.details as { reviewEvidenceRefs?: string[] }).reviewEvidenceRefs, [
      evidence.ref,
    ]);
    assert.equal(
      (finished.details?.completionReadiness as { ready?: boolean } | undefined)?.ready,
      true,
    );
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.deepEqual(loaded.getTask(taskRef).outputEvidenceRefs, [evidence.ref]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task can create bounded task Evidence before reviewer gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-generated-evidence-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerEvidenceRefs: string[] = [];
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          if (input.targetKind === "task") reviewerEvidenceRefs = input.evidenceRefs;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-generated-evidence",
      title: "Finish with generated evidence",
      description: "Finish should create a bounded task Evidence record.",
      plan: executionReadyPlan("Finish with generated evidence"),
      todos: ["Generate evidence and finish task"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Generate evidence and finish task"] },
        { op: "done", item: "Generate evidence and finish task" },
      ],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Generated evidence validates the task.",
      evidence: {
        title: "Generated finish evidence",
        notes: "Bounded evidence notes.",
        changedFiles: [
          "packages/spark-extension/src/extension/spark-finish-task-tool-registration.ts",
        ],
        sourceRefs: ["test/spark-tools.test.ts:generated-evidence"],
        validationCommands: ["pnpm test test/spark-tools.test.ts — pass"],
      },
    });

    assert.match(toolText(finished), /Evidence recorded: evidence:/);
    const generatedRef = (finished.details as { generatedEvidenceRef?: EvidenceRef })
      .generatedEvidenceRef;
    assert.ok(generatedRef?.startsWith("evidence:"));
    if (!generatedRef) throw new Error("missing generated evidence ref");
    assert.deepEqual(reviewerEvidenceRefs, [generatedRef]);
    assert.deepEqual((finished.details as { evidenceRefs?: string[] }).evidenceRefs, [
      generatedRef,
    ]);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.deepEqual(loaded.getTask(taskRef).outputEvidenceRefs, [generatedRef]);
    const evidence = await defaultEvidenceStore(dir).get(generatedRef);
    assert.equal(evidence.provenance.producer, "task");
    assert.equal(evidence.provenance.taskRef, taskRef);
    assert.equal(evidence.curation?.status, "candidate");
    assert.equal(evidence.curation?.retention, "task");
    const body = evidence.body;
    assert.equal(typeof body, "string");
    if (typeof body !== "string") throw new Error("generated evidence body must be markdown");
    assert.match(body, /Generated finish evidence/);
    assert.match(body, /pnpm test test\/spark-tools\.test\.ts — pass/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task does not persist evidenceRefs when follow-up gate blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-evidence-followup-block-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          throw new Error("reviewer should not run before follow-up disposition passes");
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Follow-up evidence",
      format: "markdown",
      body: "TODO: create a follow-up before this research can close.",
      provenance: { producer: "task" },
    });

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-evidence-followup-block",
      title: "Finish evidence follow-up block",
      description: "Blocked follow-up checks must not persist explicit finish evidence.",
      kind: "research",
      plan: executionReadyPlan("Finish evidence follow-up block"),
      todos: ["Validate follow-up gate blocks before evidence persistence"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Validate follow-up gate blocks before evidence persistence"] },
        { op: "done", item: "Validate follow-up gate blocks before evidence persistence" },
      ],
    });

    const blocked = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Research conclusion: still has an open follow-up.",
      evidenceRefs: [evidence.ref],
    });

    assert.match(toolText(blocked), /Task finish blocked by follow-up disposition gate/);
    assert.equal(
      (blocked.details as { error?: string } | undefined)?.error,
      "followup_disposition_required",
    );
    assert.equal(reviewerCalls, 0);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "running");
    assert.deepEqual(loaded.getTask(taskRef).outputEvidenceRefs, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task finish review resolves superseded Evidence to its current replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-current-evidence-"));
  try {
    const store = defaultEvidenceStore(dir);
    const historical = await store.put({
      kind: "record",
      title: "Historical failed smoke",
      format: "json",
      body: { passed: false },
      provenance: { producer: "task" },
    });
    const current = await store.put({
      kind: "record",
      title: "Current smoke pass",
      format: "json",
      body: { passed: true },
      provenance: { producer: "task" },
    });
    await store.update(historical.ref, {
      curation: {
        status: "superseded",
        retention: "task",
        reason: "current-main rerun passed",
        supersededBy: [current.ref],
      },
    });
    const plan = executionReadyPlan("Resolve current completion Evidence");
    plan.evidenceRequired = [
      `Current smoke replaces ${historical.ref}`,
      "artifact:delivery is the linked delivery product",
    ];
    plan.items = [
      {
        id: "verify-current",
        title: "Verify current Evidence",
        status: "done",
        evidenceRefs: [historical.ref],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const context = await buildTaskReviewEvidenceContext(dir, {
      outputEvidenceRefs: [historical.ref],
      plan,
    });

    assert.deepEqual(context.currentEvidenceRefs, [current.ref]);
    assert.deepEqual(context.supersededEvidenceRefs, [historical.ref]);
    assert.equal(context.currentEvidencePreviews[0]?.ref, current.ref);
    assert.deepEqual(context.currentEvidencePreviews[0]?.bodyPreview, '{\n  "passed": true\n}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task finish review fails closed on cyclic superseded Evidence replacements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-cyclic-evidence-"));
  try {
    const store = defaultEvidenceStore(dir);
    const first = await store.put({
      kind: "record",
      title: "First historical receipt",
      format: "json",
      body: { generation: 1 },
      provenance: { producer: "task" },
    });
    const second = await store.put({
      kind: "record",
      title: "Second historical receipt",
      format: "json",
      body: { generation: 2 },
      provenance: { producer: "task" },
    });
    await store.update(first.ref, {
      curation: {
        status: "superseded",
        retention: "task",
        reason: "replaced by second",
        supersededBy: [second.ref],
      },
    });
    await store.update(second.ref, {
      curation: {
        status: "superseded",
        retention: "task",
        reason: "invalid cycle back to first",
        supersededBy: [first.ref],
      },
    });

    const context = await buildTaskReviewEvidenceContext(dir, {
      outputEvidenceRefs: [first.ref],
      plan: executionReadyPlan("Reject cyclic Evidence replacement"),
    });

    assert.deepEqual(context.currentEvidenceRefs, []);
    assert.deepEqual(new Set(context.supersededEvidenceRefs), new Set([first.ref, second.ref]));
    assert.equal(context.unreadableEvidence.length, 2);
    assert.match(context.unreadableEvidence[0]?.error ?? "", /contains a cycle/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task finish review rejects cycles even when another replacement is current", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-cyclic-current-evidence-"));
  try {
    const store = defaultEvidenceStore(dir);
    const historical = await store.put({
      kind: "record",
      title: "Historical self-linked receipt",
      format: "json",
      body: { generation: 1 },
      provenance: { producer: "task" },
    });
    const current = await store.put({
      kind: "record",
      title: "Current valid receipt",
      format: "json",
      body: { generation: 2 },
      provenance: { producer: "task" },
    });
    await store.update(historical.ref, {
      curation: {
        status: "superseded",
        retention: "task",
        reason: "invalid self-edge plus current leaf",
        supersededBy: [historical.ref, current.ref],
      },
    });

    const context = await buildTaskReviewEvidenceContext(dir, {
      outputEvidenceRefs: [historical.ref],
      plan: executionReadyPlan("Reject any reachable Evidence cycle"),
    });

    assert.deepEqual(context.currentEvidenceRefs, [current.ref]);
    assert.deepEqual(context.supersededEvidenceRefs, [historical.ref]);
    assert.equal(context.unreadableEvidence.length, 1);
    assert.match(context.unreadableEvidence[0]?.error ?? "", /contains a cycle/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task blocks unreadable current Evidence before semantic review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-unreadable-evidence-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);
    const plan = executionReadyPlan("Reject unreadable Evidence deterministically");
    plan.evidenceRequired = ["Required receipt evidence:missing-current"];
    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-unreadable-evidence",
      title: "Finish unreadable Evidence",
      description: "Unreadable current Evidence must fail before semantic review.",
      plan,
      todos: ["Verify unreadable Evidence preflight"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);
    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Verify unreadable Evidence preflight"] },
        { op: "done", item: "Verify unreadable Evidence preflight" },
      ],
    });

    const blocked = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Completion packet contains an unreadable required receipt.",
      evidence: successfulFinishEvidence("Unreadable Evidence preflight fixture"),
    });

    assert.match(toolText(blocked), /Task finish blocked by unreadable current Evidence/u);
    assert.match(toolText(blocked), /evidence:missing-current/u);
    assert.match(toolText(blocked), /semantic reviewer was not started/u);
    assert.equal((blocked.details as { error?: string }).error, "unreadable_completion_evidence");
    assert.equal(reviewerCalls, 0);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "running");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task keeps task unfinished when reviewer rejects done transition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-review-reject-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: createRejectingReviewerRunner("reviewer requires focused validation"),
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-review-reject",
      title: "Finish review reject",
      description: "Reviewer rejection must keep this task unfinished.",
      plan: executionReadyPlan("Finish review reject"),
      todos: ["Validate reviewer rejection keeps task unfinished"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Validate reviewer rejection keeps task unfinished"] },
        { op: "done", item: "Validate reviewer rejection keeps task unfinished" },
      ],
    });

    const rejected = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Pretend complete without validation.",
      evidence: successfulFinishEvidence("Reviewer rejection fixture validation"),
    });

    assert.match(toolText(rejected), /Task finish blocked by reviewer/);
    assert.match(toolText(rejected), /reviewer requires focused validation/);
    assert.match(toolText(rejected), /The task was not marked done/);
    assert.equal((rejected.details as { error?: string }).error, "task_review_failed");
    assert.equal((rejected.details?.task as { status?: string } | undefined)?.status, "running");
    assert.equal((rejected.details as { statusBefore?: string }).statusBefore, "running");
    assert.equal((rejected.details as { statusAfter?: string }).statusAfter, "running");
    assert.equal(
      (rejected.details as { transition?: { committed?: boolean; blocker?: string } }).transition
        ?.committed,
      false,
    );
    assert.equal(
      (rejected.details as { transition?: { committed?: boolean; blocker?: string } }).transition
        ?.blocker,
      "task_review_failed",
    );
    assert.equal(
      (rejected.details as { reviewer?: { required?: boolean; approved?: boolean } }).reviewer
        ?.required,
      true,
    );
    assert.equal(
      (rejected.details?.review as { outcome?: string; approved?: boolean } | undefined)?.outcome,
      "needs_changes",
    );
    assert.equal(
      (rejected.details?.review as { outcome?: string; approved?: boolean } | undefined)?.approved,
      false,
    );
    assert.ok(
      (rejected.details as { reviewEvidence?: string }).reviewEvidence?.startsWith("evidence:"),
    );
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "running");
    assert.ok(loaded.getTask(taskRef).claim);
    const reviewEvidences = await defaultEvidenceStore(dir).list({ kind: "record" });
    assert.equal(reviewEvidences.length, 1);
    assert.equal(reviewEvidences[0]?.provenance.producer, "review");
    assert.equal(reviewEvidences[0]?.provenance.taskRef, taskRef);
    const reviewEvidence = await defaultEvidenceStore(dir).get(reviewEvidences[0]!.ref);
    const reviewerRun = (
      reviewEvidence?.body as { reviewerRun?: { stdoutPreview?: string } } | undefined
    )?.reviewerRun;
    assert.match(reviewerRun?.stdoutPreview ?? "", /test reviewer raw stdout/);
    const reviewDir = taskReviewDirectory(dir, loaded.getTask(taskRef).projectRef, taskRef);
    const reviewIndex = JSON.parse(await readFile(join(reviewDir, "index.json"), "utf8")) as {
      reviews: Array<{ subjectKind?: string; subjectRef?: string; evidenceRef?: string }>;
    };
    assert.equal(reviewIndex.reviews[0]?.subjectKind, "task");
    assert.equal(reviewIndex.reviews[0]?.subjectRef, taskRef);
    assert.equal(reviewIndex.reviews[0]?.evidenceRef, reviewEvidences[0]?.ref);
    const subjectReview = JSON.parse(
      await readFile(subjectReviewRecordPath(reviewDir, reviewEvidences[0]!.ref), "utf8"),
    ) as { subjectKind?: string; subjectRef?: string; outcome?: string };
    assert.equal(subjectReview.subjectKind, "task");
    assert.equal(subjectReview.subjectRef, taskRef);
    assert.equal(subjectReview.outcome, "needs_changes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task classifies malformed reviewer output as reviewer unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-review-malformed-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review() {
          throw new Error("reviewer verdict must be a JSON object");
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-review-malformed",
      title: "Finish review malformed",
      description: "Malformed reviewer output must block completion transparently.",
      plan: executionReadyPlan("Finish review malformed"),
      todos: ["Verify malformed reviewer output blocks finish"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Verify malformed reviewer output blocks finish"] },
        { op: "done", item: "Verify malformed reviewer output blocks finish" },
      ],
    });

    const blocked = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Pretend complete with malformed reviewer output.",
      evidence: successfulFinishEvidence("Malformed reviewer fixture validation"),
    });

    assert.match(toolText(blocked), /Task finish could not run the reviewer/);
    assert.match(toolText(blocked), /reviewer verdict must be a JSON object/);
    assert.match(toolText(blocked), /not a semantic task rejection/);
    assert.equal((blocked.details as { error?: string }).error, "reviewer_unavailable");
    assert.equal(
      (blocked.details as { transition?: { blocker?: string } }).transition?.blocker,
      "reviewer_unavailable",
    );
    assert.equal(
      (blocked.details as { reviewer?: { failure?: { kind?: string } } }).reviewer?.failure?.kind,
      "runtime_error",
    );
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "running");
    assert.ok(loaded.getTask(taskRef).claim);
    const reviewEvidences = await defaultEvidenceStore(dir).list({ kind: "record" });
    assert.equal(reviewEvidences.length, 0);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task blocks research follow-ups without explicit disposition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-followup-block-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review() {
          reviewerCalls += 1;
          throw new Error("reviewer should not run before follow-up disposition passes");
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-research-followup-block",
      title: "Finish research follow-up block",
      description: "Research outputs with orphan follow-ups must not be marked done.",
      kind: "research",
      plan: executionReadyPlan("Finish research follow-up block"),
      todos: ["Verify orphan follow-ups block research finish"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    const blocked = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary:
        "Research conclusion: compact is incomplete.\nP1: wire Spark-native compaction into SparkAgentLoop.\nTODO: create memory scratch/daily follow-up.",
    });

    assert.match(toolText(blocked), /Task finish blocked by follow-up disposition gate/);
    assert.match(
      toolText(blocked),
      /created_task, already_covered, deferred, rejected, out_of_scope/,
    );
    assert.equal((blocked.details as { error?: string }).error, "followup_disposition_required");
    assert.equal(reviewerCalls, 0);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "running");
    assert.ok(loaded.getTask(taskRef).claim);
    assert.equal((await defaultEvidenceStore(dir).list({ kind: "record" })).length, 0);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task accepts summary disposition for Evidence follow-ups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-evidence-followup-disposition-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Follow-up evidence",
      format: "markdown",
      body: "TODO: create a separate follow-up.",
      provenance: { producer: "task" },
    });

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-evidence-followup-disposition",
      title: "Finish Evidence follow-up disposition",
      description: "Summary disposition may explicitly cover Evidence follow-up signals.",
      kind: "research",
      plan: executionReadyPlan("Finish Evidence follow-up disposition"),
      todos: ["Validate Evidence follow-up disposition"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Validate Evidence follow-up disposition"] },
        { op: "done", item: "Validate Evidence follow-up disposition" },
      ],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: `Research conclusion: Evidence disposition is explicit.\nFollow-ups:\n- already_covered: ${evidence.ref} is covered by an existing task.`,
      evidenceRefs: [evidence.ref],
    });

    assert.match(toolText(finished), /Finished Spark task: \[done\]/);
    assert.equal(reviewerCalls, 1);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "done");
    assert.deepEqual(loaded.getTask(taskRef).outputEvidenceRefs, [evidence.ref]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task completes research when follow-ups are dispositioned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-followup-pass-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-research-followup-pass",
      title: "Finish research follow-up pass",
      description: "Research outputs with dispositioned follow-ups may complete.",
      kind: "research",
      plan: executionReadyPlan("Finish research follow-up pass"),
      todos: ["Verify dispositioned follow-ups allow research finish"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Verify dispositioned follow-ups allow research finish"] },
        { op: "done", item: "Verify dispositioned follow-ups allow research finish" },
      ],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary:
        "Research conclusion: route is selected.\nFollow-ups:\n- created_task: @compact-auto-budget covers P1 compaction wiring.\n- deferred: memory scratch/daily remains P2 outside this slice.",
      evidence: successfulFinishEvidence("Dispositioned research validation"),
    });

    assert.match(toolText(finished), /Finished Spark task: \[done\]/);
    assert.equal(reviewerCalls, 1);
    assert.equal((finished.details?.task as { status?: string } | undefined)?.status, "done");
    assert.equal((finished.details?.review as { approved?: boolean } | undefined)?.approved, true);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "done");
    assert.equal(loaded.getTask(taskRef).claim, undefined);
    assert.equal((await defaultEvidenceStore(dir).list({ kind: "record" })).length, 1);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task rejects invalid explicit parameters without changing status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-invalid",
      title: "Finish invalid",
      description: "Invalid finish parameters must not alter task state.",
      plan: executionReadyPlan("Reject invalid finish parameters."),
      todos: ["Validate finish parameters"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await assert.rejects(
      () => executeSparkTool(tools, "impl_finish_task", ctx, { status: "cancel" }),
      /status must be done, failed, or cancelled/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "impl_finish_task", ctx, { summary: 42 }),
      /summary must be a string/,
    );

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.equal(loaded?.getTask(taskRef).status, "running");
    assert.ok(loaded?.getTask(taskRef).claim);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_finish_task refuses to cancel a claimed prerequisite with dependents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-cancel-dependent-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      const prerequisite = graph.createTask({
        projectRef: project.ref,
        name: "claimed-prereq",
        title: "Claimed prerequisite",
        description: "A claimed prerequisite with a dependent.",
        status: "running",
        plan: executionReadyPlan("Keep claimed prerequisite"),
      });
      graph.claimTask(prerequisite.ref, {
        kind: "main",
        claimedBy: ctxSessionKey(ctx),
        sessionId: ctxSessionKey(ctx),
        leaseMs: 60_000,
      });
      const dependent = graph.createTask({
        projectRef: project.ref,
        name: "dependent-on-claimed",
        title: "Dependent on claimed",
        description: "Depends on the claimed prerequisite.",
        status: "pending",
        plan: executionReadyPlan("Use claimed prerequisite"),
      });
      graph.addDependency(dependent.ref, prerequisite.ref);
    });
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const cancelled = await executeSparkTool(tools, "impl_finish_task", ctx, {
      status: "cancelled",
      summary: "Try to cancel prerequisite.",
    });

    assert.match(toolText(cancelled), /Cannot finish Spark task/);
    assert.match(toolText(cancelled), /cannot be cancelled/);
    assert.equal((cancelled.details as { error?: string }).error, "task_dependency_error");
    const graph = await defaultTaskGraphStore(dir).load();
    const task = graph?.tasks().find((candidate) => candidate.name === "claimed-prereq");
    assert.equal(task?.status, "running");
    assert.ok(task?.claim);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("split task tools dispatch read, write, and assign actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-canonical-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    assert.equal(tools.has("task"), false, "old task multiplexer must not be public");
    assert.ok(tools.has("task_read"), "missing task_read tool");
    assert.ok(tools.has("task_write"), "missing task_write tool");
    assert.ok(tools.has("assign"), "missing assign tool");
    const taskParameters = JSON.stringify(tools.get("task_write")?.parameters);
    assert.match(taskParameters, /Executor role ref/);
    assert.match(taskParameters, /omit for normal task planning/);
    assert.doesNotMatch(taskParameters, /Preferred role ref/);
    assert.doesNotMatch(taskParameters, /run_ready/);
    assert.doesNotMatch(taskParameters, /run_control/);
    assert.match(
      taskParameters,
      /recover \| release \| artifact_link \| artifact_unlink \| plan_update/,
    );
    const taskReadParameters = JSON.stringify(tools.get("task_read")?.parameters);
    assert.match(taskReadParameters, /task_status/);
    assert.match(taskReadParameters, /project_status/);
    assert.match(taskReadParameters, /workspace_status/);
    assert.match(taskReadParameters, /run_status/);
    assert.match(taskReadParameters, /kill_active/);
    assert.match(taskReadParameters, /forceAfterMs/);
    await assert.rejects(
      () => executeSparkTool(tools, "task_read", ctx, { action: "status" }),
      /task_read\.action must be one of: task_status, project_status, workspace_status, project_list, run_status/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "task_read", ctx, { action: "project_use" }),
      /task_read\.action must be one of: task_status, project_status, workspace_status, project_list, run_status/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "task_write", ctx, { action: "run_ready" }),
      /task_write\.action must be one of:/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "task_read", ctx, { action: "run_status", runAction: "stop" }),
      /task\.runAction must be status, list, inspect, reconcile, kill, reply, steer, ack, or kill_active/,
    );
    const guardedKill = await executeSparkTool(tools, "task_read", ctx, {
      action: "run_status",
      runAction: "kill",
    });
    assert.match(toolText(guardedKill), /kill_requires_target/);

    const created = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      title: "Canonical task tool project",
      description: "Exercise the canonical task action tool.",
    });
    assert.match(toolText(created), /Created new Spark project/);

    const planned = await executeSparkTool(tools, "task_write", ctx, {
      action: "plan",
      tasks: [
        {
          name: "canonical-task-tool",
          title: "Canonical task tool",
          description: "Exercise task action routing.",
          status: "ready",
          executionPolicy: {
            continuity: "fresh",
            isolation: "isolated_results",
            comparison: "paired",
            resources: { gpuCount: 0 },
            concurrencyKeys: ["results:canonical-task-tool"],
            timeoutMs: 60_000,
            maxAttempts: 3,
          },
          plan: executionReadyPlan("Exercise task action routing"),
        },
      ],
    });
    assert.match(toolText(planned), /Planned tasks: created=1/);
    const plannedGraph = await defaultTaskGraphStore(dir).load();
    assert.deepEqual(
      plannedGraph?.tasks().find((task) => task.name === "canonical-task-tool")?.executionPolicy,
      {
        sessionLifetime: "task_run",
        continuity: "fresh",
        isolation: "isolated_results",
        comparison: "paired",
        concurrencyKeys: ["results:canonical-task-tool"],
        timeoutMs: 60_000,
        maxAttempts: 3,
      },
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "task_write", ctx, {
          action: "plan",
          tasks: [
            {
              name: "invalid-resource-policy",
              title: "Invalid resource policy",
              description: "Must fail closed.",
              executionPolicy: { resources: { gpuCount: -1 } },
              plan: executionReadyPlan("Reject invalid resource policy"),
            },
          ],
        }),
      /resources\.gpuCount must be a non-negative integer/u,
    );

    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
    });
    assert.match(toolText(status), /Canonical task tool project/);

    const assigned = await executeSparkTool(tools, "assign", ctx, {
      dryRun: true,
      maxConcurrency: 1,
    });
    assert.match(toolText(assigned), /Dry-run checked 1 Spark task run/);

    const claimed = await executeSparkTool(tools, "task_write", ctx, {
      action: "claim",
      name: "canonical-task-tool",
      title: "Canonical task tool",
      description: "Exercise task action routing.",
      todos: ["Validate canonical task action routing"],
    });
    assert.match(toolText(claimed), /Claimed Spark task/);

    const todos = await executeSparkTool(tools, "task_write", ctx, {
      action: "plan_update",
      scope: "task",
      ops: [
        { op: "init", items: ["Validate canonical task action routing"] },
        { op: "append", items: ["Validate canonical task routing"] },
        { op: "done", item: "Validate canonical task action routing" },
        { op: "done", item: "Validate canonical task routing" },
      ],
    });
    assert.match(toolText(todos), /Updated plan items/);

    const finished = await executeSparkTool(tools, "task_write", ctx, {
      action: "finish",
      summary: "Canonical task routing works.",
      evidence: successfulFinishEvidence("Canonical task routing validation"),
    });
    assert.match(toolText(finished), /Finished Spark task/);

    const contextList = await executeSparkTool(tools, "context", ctx, { action: "list" });
    assert.match(toolText(contextList), /spark\.active/);
    const contextPreview = await executeSparkTool(tools, "context", ctx, {
      action: "preview",
      providerIds: ["spark.active"],
      budgetChars: 1_000,
    });
    assert.match(toolText(contextPreview), /Spark context/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical assign rejects a mixed frontier before creating any identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-attempt-limit-refusal-"));
  try {
    await writeEmptySparkProject(dir);
    await defaultProjectRoleModelSettingsStore(dir).save("implementation", "test/model");
    const ctx = testSparkContext(dir, "main");
    ctx.model = { provider: "test-provider", id: "test-model" };
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const runnable = graph.createTask({
      projectRef: project.ref,
      name: "attempt-available",
      title: "Attempt available",
      description: "Must not be dispatched when another requested Task is exhausted.",
      kind: "implement",
      status: "ready",
      roleRef: "role:builtin-worker" as RoleRef,
      executionPolicy: {
        sessionLifetime: "task_revision",
        continuity: "reuse_within_revision",
        isolation: "isolated_worktree",
        comparison: "single_side",
        resources: { gpuCount: 0 },
        concurrencyKeys: [],
        maxAttempts: 2,
      },
      plan: executionReadyPlan("Do not partially dispatch a mixed exhausted frontier"),
    });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "attempt-exhausted",
      title: "Attempt exhausted",
      description: "Canonical assign must fail closed before durable dispatch identities exist.",
      kind: "implement",
      status: "ready",
      roleRef: "role:builtin-worker" as RoleRef,
      executionPolicy: {
        sessionLifetime: "task_revision",
        continuity: "reuse_within_revision",
        isolation: "isolated_worktree",
        comparison: "single_side",
        resources: { gpuCount: 0 },
        concurrencyKeys: [],
        maxAttempts: 2,
      },
      plan: executionReadyPlan("Refuse exhausted canonical assignment"),
    });
    for (const attempt of [1, 2]) {
      graph.recordRun({
        ref: `run:attempt-exhausted-${attempt}` as RunRef,
        projectRef: project.ref,
        taskRef: task.ref,
        roleRef: "role:builtin-worker" as RoleRef,
        runName: `${task.name}-attempt-${attempt}`,
        ownerSessionId: "session:historical-owner",
        status: "failed",
        startedAt: `2026-08-01T00:0${attempt}:00.000Z`,
        finishedAt: `2026-08-01T00:0${attempt}:30.000Z`,
        outputEvidenceRefs: [],
      });
    }
    await store.save(graph);
    await saveCurrentProjectRef(dir, ctx, project.ref);
    const { tools } = registerSparkToolsForTest();

    const assigned = await executeSparkTool(tools, "assign", ctx, {
      dryRun: false,
      maxConcurrency: 1,
      taskRefs: [runnable.ref, task.ref],
    });

    assert.match(toolText(assigned), /Refused managed Task Session assignment/u);
    const details = assigned.details as {
      accepted?: boolean;
      reason?: string;
      taskRefs?: string[];
      bindings?: unknown[];
      resourceDeferred?: Array<{ taskRef?: string; reason?: string }>;
    };
    assert.equal(details.accepted, false);
    assert.equal(details.reason, "attempt_limit");
    assert.deepEqual(details.taskRefs, []);
    assert.deepEqual(details.bindings, []);
    assert.deepEqual(details.resourceDeferred, [
      { taskRef: task.ref, reason: "attempt_limit", message: "Task reached maxAttempts=2." },
    ]);
    for (const identity of ["runRef", "executionSessionId", "invocationId", "leaseId"]) {
      assert.equal(identity in details, false);
    }

    const persisted = await store.load();
    assert.equal(persisted?.runs(project.ref).length, 2);
    assert.equal(persisted?.getTask(runnable.ref).claim, undefined);
    assert.equal(persisted?.getTask(runnable.ref).status, "ready");
    assert.equal(persisted?.getTask(task.ref).claim, undefined);
    assert.equal(persisted?.getTask(task.ref).status, "ready");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task_read project_status hides unclaimed task plan-item details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-claim-gated-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const unclaimed = graph.createTask({
      projectRef: project.ref,
      name: "unclaimed-details",
      title: "Unclaimed task with plan items",
      description: "Plan-item content must not leak before claim.",
      status: "ready",
      plan: executionReadyPlan("Keep unclaimed plan-item content compact"),
      todos: [{ content: "Hidden unclaimed plan item", status: "pending" }],
    });
    const claimed = graph.createTask({
      projectRef: project.ref,
      name: "claimed-details",
      title: "Claimed task with plan items",
      description: "Claimed plan-item content should remain visible.",
      status: "ready",
      plan: executionReadyPlan("Show claimed plan-item content"),
      todos: [{ content: "Visible claimed plan item", status: "pending" }],
    });
    const sessionKey = ctxSessionKey(ctx);
    graph.claimTask(claimed.ref, {
      kind: "main",
      claimedBy: sessionKey,
      sessionId: sessionKey,
      leaseMs: 60_000,
    });
    await store.save(graph);
    await saveCurrentProjectRef(dir, ctx, project.ref);

    const { tools } = registerSparkToolsForTest();
    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
      projectRef: project.ref,
    });
    const text = toolText(status);
    assert.match(text, /Unclaimed task with plan items/);
    assert.doesNotMatch(text, /Hidden unclaimed plan item/);
    assert.match(text, /Visible claimed plan item/);

    const detailsStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
      projectRef: project.ref,
    });
    const details = detailsStatus.details as {
      selectedProject?: {
        tasks?: Array<{
          ref?: string;
          todos?: { total?: number; items?: Array<{ content?: string }> };
        }>;
      };
    };
    const taskDetails = details.selectedProject?.tasks ?? [];
    const unclaimedDetails = taskDetails.find((task) => task.ref === unclaimed.ref);
    const claimedDetails = taskDetails.find((task) => task.ref === claimed.ref);
    assert.equal(unclaimedDetails?.todos?.total, 0);
    assert.deepEqual(unclaimedDetails?.todos?.items, []);
    assert.equal(claimedDetails?.todos?.total, 1);
    assert.equal(claimedDetails?.todos?.items?.[0]?.content, "Visible claimed plan item");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task_read scoped status actions do not return unrelated projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-scoped-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [currentProject] = graph.projects();
    assert.ok(currentProject);
    const selectedTask = graph.createTask({
      projectRef: currentProject.ref,
      name: "selected-task",
      title: "Selected task",
      description: "The only task expected in task_status.",
      status: "ready",
      plan: executionReadyPlan("The only task expected in task_status."),
    });
    graph.createTask({
      projectRef: currentProject.ref,
      name: "sibling-task",
      title: "Sibling task",
      description: "Same-project task excluded from task_status.",
      status: "pending",
      plan: executionReadyPlan("Same-project task excluded from task_status."),
    });
    const unrelatedProject = graph.createProject({
      title: "Unrelated project",
      description: "Must not appear in scoped project/task status.",
    });
    graph.createTask({
      projectRef: unrelatedProject.ref,
      name: "unrelated-task",
      title: "Unrelated task",
      description: "Must not leak into scoped status.",
      status: "ready",
      plan: executionReadyPlan("Must not leak into scoped status."),
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      project: currentProject.ref,
    });

    const projectStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
      projectRef: currentProject.ref,
    });
    const projectDetails = projectStatus.details as {
      scope?: string;
      selectedProject?: { ref?: string; title?: string; tasks?: Array<{ name?: string }> };
      renderedProjects?: Array<{ ref?: string; title?: string }>;
      projects?: Array<{ title?: string }>;
    };
    assert.equal(projectDetails.scope, "project");
    assert.equal(projectDetails.selectedProject?.ref, currentProject.ref);
    assert.deepEqual(
      projectDetails.renderedProjects?.map((project) => project.ref),
      [currentProject.ref],
    );
    assert.equal(projectDetails.projects, undefined);
    assert.doesNotMatch(toolText(projectStatus), /Unrelated project|Unrelated task/);

    const projectStatusJson = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
      projectRef: currentProject.ref,
      format: "json",
    });
    const projectJson = JSON.parse(toolText(projectStatusJson)) as {
      scope?: string;
      selectedProject?: { ref?: string };
      activeProject?: unknown;
      renderedProjects?: unknown;
      hints?: unknown;
    };
    assert.equal(projectJson.scope, "project");
    assert.equal(projectJson.selectedProject?.ref, currentProject.ref);
    assert.equal(projectJson.activeProject, undefined);
    assert.equal(projectJson.renderedProjects, undefined);
    assert.equal(projectJson.hints, undefined);

    const taskStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "task_status",
      taskRef: selectedTask.ref,
    });
    const taskDetails = taskStatus.details as {
      scope?: string;
      selectedTask?: { ref?: string; name?: string; readyFrontier?: boolean };
      selectedProject?: { ref?: string; current?: boolean; tasks?: Array<{ name?: string }> };
      renderedProjects?: unknown;
      ready?: unknown;
      hints?: unknown;
    };
    assert.equal(taskDetails.scope, "task");
    assert.equal(taskDetails.selectedTask?.ref, selectedTask.ref);
    assert.equal(taskDetails.selectedTask?.name, "selected-task");
    assert.equal(taskDetails.selectedTask?.readyFrontier, true);
    assert.equal(taskDetails.selectedProject?.ref, currentProject.ref);
    assert.equal(taskDetails.selectedProject?.tasks, undefined);
    assert.equal(taskDetails.renderedProjects, undefined);
    assert.equal(taskDetails.ready, undefined);
    assert.equal(taskDetails.hints, undefined);
    assert.doesNotMatch(toolText(taskStatus), /Sibling task|Unrelated project|Unrelated task/);
    assert.doesNotMatch(toolText(taskStatus), /\n\n/);

    const taskStatusJson = await executeSparkTool(tools, "task_read", ctx, {
      action: "task_status",
      taskRef: selectedTask.ref,
      format: "json",
    });
    const taskJson = JSON.parse(toolText(taskStatusJson)) as {
      selectedTask?: { ref?: string; name?: string };
      selectedProject?: { ref?: string; tasks?: unknown };
      renderedProjects?: unknown;
      activeProject?: unknown;
      ready?: unknown;
      hints?: unknown;
    };
    assert.equal(taskJson.selectedTask?.ref, selectedTask.ref);
    assert.equal(taskJson.selectedTask?.name, "selected-task");
    assert.equal(taskJson.selectedProject?.ref, currentProject.ref);
    assert.equal(taskJson.selectedProject?.tasks, undefined);
    assert.equal(taskJson.renderedProjects, undefined);
    assert.equal(taskJson.activeProject, undefined);
    assert.equal(taskJson.ready, undefined);
    assert.equal(taskJson.hints, undefined);

    const workspaceStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "workspace_status",
      view: "summary",
      format: "json",
    });
    const workspaceDetails = JSON.parse(toolText(workspaceStatus)) as {
      scope?: string;
      renderedProjects?: Array<{ title?: string }>;
    };
    assert.equal(workspaceDetails.scope, "workspace");
    assert.ok(
      workspaceDetails.renderedProjects?.some((project) => project.title === "Unrelated project"),
    );

    const limitedWorkspaceStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "workspace_status",
      view: "summary",
      format: "json",
      limit: 1,
    });
    const limitedWorkspaceDetails = JSON.parse(toolText(limitedWorkspaceStatus)) as {
      renderedProjects?: Array<{ title?: string }>;
      hiddenProjectsByLimit?: number;
      hints?: unknown;
    };
    assert.equal(limitedWorkspaceDetails.renderedProjects?.length, 1);
    assert.equal(limitedWorkspaceDetails.hiddenProjectsByLimit, 1);
    assert.equal(limitedWorkspaceDetails.hints, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical task project_use creates the first Spark project when graph is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-project-bootstrap-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    assert.equal(existsSync(join(dir, ".spark", "projects.json")), false);
    const created = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      title: "Goal bootstrap project",
      description: "Create the first project directly from a foreground goal tick.",
    });

    assert.match(toolText(created), /Created new Spark project/);
    assert.equal((created.details as { created?: boolean }).created, true);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.projects()[0]?.title, "Goal bootstrap project");

    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
    });
    assert.match(toolText(status), /Goal bootstrap project/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence tool lists and reads evidence through the canonical facade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-artifacts-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "document",
      title: "Facade research note",
      format: "text",
      body: "evidence body",
      provenance: { producer: "spark" },
    });
    const { tools } = registerSparkToolsForTest();

    const listed = await executeSparkTool(tools, "evidence", ctx, {
      action: "list",
      kind: "document",
    });
    assert.match(toolText(listed), new RegExp(`- ${evidence.ref}`));
    assert.doesNotMatch(toolText(listed), /Facade research note/);
    assert.equal((listed.details as { count?: number }).count, 1);
    assert.equal((listed.details as { view?: string }).view, "ref-only");

    const summary = await executeSparkTool(tools, "evidence", ctx, {
      action: "list",
      kind: "document",
      view: "summary",
    });
    assert.match(toolText(summary), new RegExp(`${evidence.ref}.*Facade research note`));

    const refOnly = await executeSparkTool(tools, "evidence", ctx, {
      action: "list",
      kind: "document",
      view: "ref-only",
    });
    assert.match(toolText(refOnly), new RegExp(`- ${evidence.ref}`));
    assert.doesNotMatch(toolText(refOnly), /Facade research note/);

    const read = await executeSparkTool(tools, "evidence", ctx, {
      action: "read",
      evidenceRef: evidence.ref,
    });
    assert.match(toolText(read), /Facade research note/);
    assert.match(toolText(read), /Recorded evidence|evidence body|Facade research note/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence tool rejects invalid filters and non-evidence refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-artifacts-invalid-filters-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "document",
      title: "Boundary note",
      format: "text",
      body: "evidence body",
      provenance: { producer: "spark" },
    });
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "evidence", ctx, { action: "list", kind: "note" }),
      /kind must be a valid Evidence kind; valid values: document, record, trace, knowledge; received: note/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "evidence", ctx, { action: "list", producer: "agent" }),
      /producer must be a valid Evidence producer; valid values: spark, role, task, review, ask, cue, user; received: agent.*producer=task.*runRef\/taskRef/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "evidence", ctx, {
          action: "record",
          kind: "plan-draft",
          title: "Draft",
          format: "markdown",
          body: "draft",
          provenance: { producer: "task" },
        }),
      /kind must be a valid Evidence kind; valid values: document, record, trace, knowledge; received: plan-draft.*kind=document/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "evidence", ctx, {
          action: "link",
          from: evidence.ref,
          to: "task:demo",
          relation: "review",
        }),
      /relation must be a valid Evidence link relation; valid values: parent, input, output, review-of, answer-to, trace-of, derived-from; received: review/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "evidence", ctx, { action: "list", projectRef: "project:one" }),
      /projectRef must be a proj: ref/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "evidence", ctx, { action: "list", limit: 1.5 }),
      /limit must be a positive integer/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "evidence", ctx, { action: "list", view: "unsupported" }),
      /view must be ref-only or summary/,
    );

    await assert.rejects(
      () =>
        executeSparkTool(tools, "evidence", ctx, {
          action: "read",
          evidenceRef: evidenceSurfaceNegativeValues.wrongNamespaceRef,
        }),
      /evidenceRef must be an evidence: ref/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory kind=learning routes record, list, search, read, export, and import", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-learnings-"));
  const importDir = await mkdtemp(join(tmpdir(), "spark-tool-learnings-import-"));
  try {
    await writeEmptySparkProject(dir);
    await writeEmptySparkProject(importDir);
    const ctx = testSparkContext(dir, "main");
    const importCtx = testSparkContext(importDir, "main");
    const { tools } = registerSparkToolsForTest();

    assert.ok(tools.has("memory"), "missing canonical memory tool");
    const recorded = await executeSparkTool(tools, "memory", ctx, {
      kind: "learning",
      action: "record",
      id: "learning-explicit-export",
      title: "Export shared learnings explicitly",
      statement:
        "Spark learnings live in .spark/memory/learnings locally and can be shared through explicit Markdown exports.",
      category: "decision",
      status: "candidate",
      evidenceRefs: ["evidence:decision-gate"],
      tags: ["nyakore", "spark"],
      confidence: 0.9,
    });
    assert.match(toolText(recorded), /Recorded learning evidence:learning-explicit-export/);
    await writeFile(
      join(dir, ".spark", "memory", "learnings", "invalid-kind-learning.json"),
      JSON.stringify(
        {
          ref: "evidence:invalid-kind-learning",
          kind: "not-a-valid-kind",
          title: "Invalid learning Evidence metadata",
          format: "json",
          body: {},
          links: [],
          provenance: { producer: "task" },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        null,
        2,
      ),
    );

    const listed = await executeSparkTool(tools, "memory", ctx, {
      kind: "learning",
      action: "list",
      tag: "spark",
      location: "workspace",
      includeCandidates: true,
    });
    assert.match(toolText(listed), /Export shared learnings explicitly/);
    assert.match(toolText(listed), /warning:.*kind must be a valid Evidence kind/);
    assert.equal((listed.details as { warnings?: unknown[] }).warnings?.length, 1);

    const search = await executeSparkTool(tools, "memory", ctx, {
      kind: "learning",
      action: "search",
      query: "explicit Markdown exports",
      location: "workspace",
      includeCandidates: true,
    });
    assert.match(toolText(search), /Export shared learnings explicitly/);
    assert.match(toolText(search), /warning:.*kind must be a valid Evidence kind/);
    assert.equal((search.details as { warnings?: unknown[] }).warnings?.length, 1);

    const read = await executeSparkTool(tools, "memory", ctx, {
      kind: "learning",
      action: "read",
      ref: "evidence:learning-explicit-export",
    });
    assert.match(toolText(read), /Export shared learnings explicitly/);
    assert.ok(
      (
        await stat(join(dir, ".spark", "memory", "learnings", "learning-explicit-export.json"))
      ).isFile(),
    );

    const exportPath = join("exports", "learnings.md");
    const exported = await executeSparkTool(tools, "memory", ctx, {
      kind: "learning",
      action: "export_markdown",
      outputPath: exportPath,
      location: "workspace",
      includeCandidates: true,
    });
    assert.match(toolText(exported), /Exported 1 learning/);
    assert.equal((exported.details as { count?: number }).count, 1);

    const dryRun = await executeSparkTool(tools, "memory", importCtx, {
      kind: "learning",
      action: "import_markdown",
      inputPath: join(dir, exportPath),
    });
    assert.match(toolText(dryRun), /Dry-run parsed 1 learning/);
    assert.equal((dryRun.details as { apply?: boolean; count?: number }).apply, false);
    assert.equal((dryRun.details as { apply?: boolean; count?: number }).count, 1);

    const imported = await executeSparkTool(tools, "memory", importCtx, {
      kind: "learning",
      action: "import_markdown",
      inputPath: join(dir, exportPath),
      apply: true,
    });
    assert.match(toolText(imported), /Imported 1 learning/);
    assert.equal((imported.details as { count?: number }).count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(importDir, { recursive: true, force: true });
  }
});

test("memory kind=learning rejects invalid explicit parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-learnings-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "memory", ctx, {
          kind: "learning",
          action: "record",
          title: "Invalid category",
          statement: "This category should not be accepted.",
          category: "lesson",
        }),
      /memory\.category must be one of/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "memory", ctx, {
          kind: "learning",
          action: "record",
          title: "Invalid confidence",
          statement: "Confidence should stay normalized.",
          confidence: 2,
        }),
      /learning confidence must be between 0 and 1/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "memory", ctx, {
          kind: "learning",
          action: "search",
          query: "anything",
          includeCandidates: "true",
        }),
      /memory\.includeCandidates must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "memory", ctx, {
          kind: "learning",
          action: "list",
          status: ["active", "archived"],
        }),
      /memory\.status must be one of/,
    );

    await assert.rejects(
      () =>
        executeSparkTool(tools, "memory", ctx, {
          kind: "learning",
          action: "export_markdown",
          includeInactive: "false",
        }),
      /memory\.includeInactive must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "memory", ctx, {
          kind: "learning",
          action: "import_markdown",
          inputPath: ".spark/memory/learnings",
          apply: "true",
        }),
      /memory\.apply must be a boolean/,
    );

    await writeFile(
      join(dir, "not-learning-export.md"),
      "# Notes\n\nNo pi-learning blocks here.\n",
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "memory", ctx, {
          kind: "learning",
          action: "import_markdown",
          inputPath: "not-learning-export.md",
        }),
      /\[E_LEARNING_IMPORT_FORMAT\][\s\S]*export_markdown[\s\S]*dry-run[\s\S]*apply=true/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_ask_replay rejects non-evidence refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-ask-replay-invalid-ref-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_ask_replay", ctx, { evidenceRef: 42 }),
      /evidenceRef must be a string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_ask_replay", ctx, {
          evidenceRef: evidenceSurfaceNegativeValues.wrongNamespaceRef,
        }),
      /evidenceRef must be an evidence: ref/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_use_project clarifies generic project labels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-intent-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const created = await executeSparkTool(tools, "impl_use_project", ctx, { title: "tasks" });
    assert.match(toolText(created), /Created new Spark project/);
    assert.equal((created.details as { created?: boolean } | undefined)?.created, true);
    const artifacts = await defaultEvidenceStore(dir).list({
      kind: "record",
    });
    assert.equal(artifacts.length, 1);
    const traces = await defaultEvidenceStore(dir).list({
      kind: "trace",
    });
    const askArtifact = await defaultEvidenceStore(dir).get(artifacts[0].ref);
    const askBody = askArtifact.body as {
      request?: { questions?: Array<{ id: string; prompt?: string }> };
    };
    assert.ok((askBody.request?.questions?.length ?? 0) > 0);
    const clarificationTrace = traces.find(
      (artifact) => artifact.title === "Project purpose clarification",
    );
    assert.ok(clarificationTrace);
    assert.equal(clarificationTrace.provenance.producer, "task");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_use_project blocks active duplicate project creation without writing state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-active-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeGraph = await defaultTaskGraphStore(dir).load();
    const beforeCount = beforeGraph?.projects().length ?? 0;
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);

    const blocked = await executeSparkTool(tools, "impl_use_project", ctx, {
      title: "Tool persistence",
      description: "Same work as the existing Tool persistence project.",
    });

    assert.match(toolText(blocked), /Duplicate Spark project creation blocked/);
    assert.match(toolText(blocked), /Tool persistence/);
    assert.doesNotMatch(toolText(blocked), /status=/);
    assert.match(toolText(blocked), /task_write\(\{ action: "project_use"/);
    const details = blocked.details as
      | {
          error?: string;
          duplicateProject?: boolean;
          candidates?: Array<{ ref?: string; title?: string }>;
        }
      | undefined;
    assert.equal(details?.error, "duplicate_project");
    assert.equal(details?.duplicateProject, true);
    assert.equal(details?.candidates?.[0]?.title, "Tool persistence");
    const afterGraph = await defaultTaskGraphStore(dir).load();
    assert.equal(afterGraph?.projects().length ?? 0, beforeCount);
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_use_project compares duplicates against permanent projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-permanent-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultTaskGraphStore(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await store.load())?.projects().length ?? 0;

    const blocked = await executeSparkTool(tools, "impl_use_project", ctx, {
      title: "Tool persistence",
      description: "Attempt to recreate a duplicate permanent project.",
    });

    assert.match(toolText(blocked), /Duplicate Spark project creation blocked/);
    assert.doesNotMatch(toolText(blocked), /status=/);
    const details = blocked.details as { candidates?: Array<{ title?: string }> } | undefined;
    assert.equal(details?.candidates?.[0]?.title, "Tool persistence");
    assert.equal((await store.load())?.projects().length ?? 0, beforeCount);
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_use_project creates clearly distinct projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-distinct-create-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0;

    const created = await executeSparkTool(tools, "impl_use_project", ctx, {
      title: "Renderer pipeline profiling",
      description: "Investigate frame timing and GPU trace capture for the renderer pipeline.",
    });

    assert.match(toolText(created), /Created new Spark project/);
    const details = created.details as
      | { created?: boolean; project?: { ref?: string } }
      | undefined;
    assert.equal(details?.created, true);
    assert.equal(
      (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0,
      beforeCount + 1,
    );
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, details?.project?.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_use_project duplicate gate does not block explicit existing project selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-use-existing-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0;

    const selected = await executeSparkTool(tools, "impl_use_project", ctx, {
      project: "Tool persistence",
      title: "Tool persistence",
      description:
        "Even duplicate create metadata must be ignored when selecting an existing Project.",
    });

    assert.match(toolText(selected), /Selected existing Spark project/);
    assert.equal((selected.details as { created?: boolean } | undefined)?.created, false);
    assert.equal((await defaultTaskGraphStore(dir).load())?.projects().length ?? 0, beforeCount);
    assert.ok((await loadCurrentProjectState(dir, ctx))?.projectRef?.startsWith("proj:"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical task project_use exposes duplicate creation gate guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-canonical-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0;

    const blocked = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      title: "Tool persistence",
      description: "Duplicate via canonical task tool surface.",
    });

    assert.match(toolText(blocked), /Duplicate Spark project creation blocked/);
    assert.match(toolText(blocked), /Tool persistence/);
    assert.doesNotMatch(toolText(blocked), /status=/);
    assert.match(toolText(blocked), /Select the existing Project/);
    const details = blocked.details as
      | {
          error?: string;
          duplicateProject?: boolean;
          candidates?: Array<{ ref?: string; title?: string }>;
          guidance?: string[];
        }
      | undefined;
    assert.equal(details?.error, "duplicate_project");
    assert.equal(details?.duplicateProject, true);
    assert.equal(details?.candidates?.[0]?.title, "Tool persistence");
    assert.ok(
      details?.guidance?.some((line) => line.includes('task_write({ action: "project_use"')),
    );
    assert.equal((await defaultTaskGraphStore(dir).load())?.projects().length ?? 0, beforeCount);
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_use_project reports selected existing projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-use-project-existing-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const selected = await executeSparkTool(tools, "impl_use_project", ctx, {
      project: "Tool persistence",
    });

    assert.match(toolText(selected), /Selected existing Spark project/);
    assert.equal((selected.details as { created?: boolean } | undefined)?.created, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subject review rebuild reads a controlled v1 Evidence fixture and writes canonical indexes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-subject-review-legacy-"));
  try {
    const fixture =
      await loadLegacyEvidenceFixture<LegacyEvidenceFixture<Record<string, unknown>>>(
        "subject-review-v1.json",
      );
    const reviewDir = join(dir, "reviews");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "legacy.json"), JSON.stringify(fixture.value));
    await writeFile(
      join(reviewDir, "legacy-artifact.json"),
      JSON.stringify({
        version: 1,
        subjectKind: "task",
        subjectRef: "task:legacy-artifact",
        [["artifact", "Ref"].join("")]: "artifact:legacy-review",
        status: "resolved",
        outcome: "approved",
        reviewedAt: "2026-06-30T00:00:00.000Z",
      }),
    );

    const index = await rebuildSubjectReviewIndex(reviewDir);
    assert.equal(index.reviews[0]?.evidenceRef, "evidence:legacy-review");
    assert.deepEqual(index.skipped, [
      {
        path: "legacy-artifact.json",
        reason: "legacy_artifact_review_not_promoted",
        legacyArtifactRef: "artifact:legacy-review",
      },
    ]);
    const persisted = await readFile(join(reviewDir, "index.json"), "utf8");
    assert.match(persisted, /"evidenceRef": "evidence:legacy-review"/);
    for (const legacyField of fixture.legacyFieldNames) {
      assert.doesNotMatch(persisted, quotedJsonField(legacyField));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subject review rebuild rejects controlled mixed canonical and legacy Evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-subject-review-mixed-evidence-"));
  try {
    const fixture = await loadLegacyEvidenceFixture<LegacyEvidenceFixture<Record<string, unknown>>>(
      "subject-review-mixed-v1.json",
    );
    const reviewDir = join(dir, "reviews");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "mixed.json"), JSON.stringify(fixture.value));
    await assert.rejects(
      () => rebuildSubjectReviewIndex(reviewDir),
      /must not contain both evidenceRef and legacy/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace review migration quarantines legacy Artifact reviews without promoting them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-subject-review-workspace-mixed-"));
  try {
    const reviewDir = join(
      dir,
      ".spark",
      "projects",
      "proj-current",
      "tasks",
      "task-current",
      "reviews",
    );
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      join(reviewDir, "evidence-current.json"),
      JSON.stringify({
        version: 1,
        subjectKind: "task",
        subjectRef: "task:current",
        evidenceRef: "evidence:current-review",
        status: "resolved",
        outcome: "approved",
        reviewedAt: "2026-07-02T00:00:00.000Z",
      }),
    );
    const sourcePath = join(reviewDir, "artifact-legacy.json");
    await writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        subjectKind: "task",
        subjectRef: "task:legacy",
        [["artifact", "Ref"].join("")]: "artifact:legacy-review",
        status: "resolved",
        outcome: "needs_changes",
        reviewedAt: "2026-07-01T00:00:00.000Z",
      }),
    );

    const dryRun = await quarantineLegacyArtifactSubjectReviews(dir, { apply: false });
    assert.equal(dryRun.applied, false);
    assert.deepEqual(dryRun.entries, [
      {
        sourcePath: ".spark/projects/proj-current/tasks/task-current/reviews/artifact-legacy.json",
        quarantinePath:
          ".spark/reviews/legacy-artifact-records/projects/proj-current/tasks/task-current/reviews/artifact-legacy.json",
        legacyArtifactRef: "artifact:legacy-review",
      },
    ]);
    assert.equal(existsSync(sourcePath), true);

    const migration = await quarantineLegacyArtifactSubjectReviews(dir, { apply: true });
    assert.equal(migration.applied, true);
    assert.equal(existsSync(sourcePath), false);
    assert.equal(existsSync(join(dir, migration.entries[0]!.quarantinePath)), true);
    assert.match(
      await readFile(join(dir, migration.manifestPath), "utf8"),
      /"legacyArtifactRef": "artifact:legacy-review"/,
    );

    const index = await rebuildWorkspaceReviewIndex(dir);
    assert.deepEqual(
      index.reviews.map((review) => review.evidenceRef),
      ["evidence:current-review"],
    );
    assert.deepEqual(index.skipped, []);
    const repeated = await quarantineLegacyArtifactSubjectReviews(dir, { apply: true });
    assert.equal(repeated.applied, true);
    assert.deepEqual(repeated.entries, migration.entries);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session goal reads a controlled legacy review fixture and writes only Evidence names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-goal-legacy-evidence-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const fixture = await loadLegacyEvidenceFixture<LegacyEvidenceFixture<Record<string, unknown>>>(
      "session-goal-v1.json",
      { SESSION_ID: ctx.sessionId },
    );
    const path = sessionGoalStorePath(dir, ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(fixture.value));

    const loaded = await loadSessionGoal(dir, ctx);
    assert.equal(loaded?.lastReviewEvidenceRef, "evidence:legacy-review");
    await updateSessionGoalStatus(dir, ctx, "active", { reason: "rewrite canonical schema" });
    const persisted = await readFile(path, "utf8");
    assert.match(persisted, /"lastReviewEvidenceRef": "evidence:legacy-review"/);
    for (const legacyField of fixture.legacyFieldNames) {
      assert.doesNotMatch(persisted, quotedJsonField(legacyField));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session goal rejects controlled mixed canonical and legacy review Evidence", async () => {
  const fixture = await loadLegacyEvidenceFixture<{
    legacyFieldNames: string[];
    cases: Array<{ name: string; fields: Record<string, unknown> }>;
  }>("session-goal-mixed-v1.json");
  for (const testCase of fixture.cases) {
    const dir = await mkdtemp(join(tmpdir(), `spark-session-goal-mixed-${testCase.name}-`));
    try {
      const ctx = testSparkContext(dir, "main");
      const path = sessionGoalStorePath(dir, ctx);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          goal: {
            version: 1,
            goalId: `mixed-${testCase.name}`,
            sessionKey: ctx.sessionId,
            originalObjective: "Reject ambiguous persisted evidence",
            objective: "Reject ambiguous persisted evidence",
            status: "active",
            source: "explicit",
            ...testCase.fields,
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        }),
      );
      await assert.rejects(
        () => loadSessionGoal(dir, ctx),
        /must not contain multiple canonical or legacy review evidence fields/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("spark_goal start with objective bootstraps when no project exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-bootstrap-no-project-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const started = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Ship autonomous goal bootstrap behavior",
    });

    assert.match(toolText(started), /Spark session goal active/);
    assert.match(toolText(started), /No current Spark project is selected/);
    assert.match(
      toolText(started),
      /task_write\(\{ action: "project_use", title, description \}\)/,
    );
    assert.match(toolText(started), /task_write\(\{ action: "plan" \}\)/);
    assert.notEqual((started.details as { error?: string }).error, "no_inferable_goal");
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.objective, "Ship autonomous goal bootstrap behavior");
    assert.equal(goal?.status, "active");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal start ignores legacy session-scoped TODO snapshots when inferring goals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-goal-ignore-legacy-todos-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    await defaultTaskGraphStore(dir).save(new TaskGraph());
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const emptyStart = await executeSparkTool(tools, "goal", ctx, { action: "start" });
    assert.match(toolText(emptyStart), /No Spark project\/task state is available to infer/);
    assert.equal((emptyStart.details as { found?: boolean; error?: string }).found, false);
    assert.equal(
      (emptyStart.details as { found?: boolean; error?: string }).error,
      "no_inferable_goal",
    );
    assert.equal(await loadSessionGoal(dir, ctx), undefined);

    await saveIndependentTodos(dir, ctx, [
      { id: "todo-1", content: "Resolve session blocker", status: "pending" },
    ]);
    const todoStart = await executeSparkTool(tools, "goal", ctx, { action: "start" });
    assert.match(toolText(todoStart), /No Spark project\/task state is available to infer/);
    assert.equal((todoStart.details as { found?: boolean; error?: string }).found, false);
    assert.equal(
      (todoStart.details as { found?: boolean; error?: string }).error,
      "no_inferable_goal",
    );
    assert.equal(await loadSessionGoal(dir, ctx), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal inference describes substantive project outcomes instead of task completion", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Alignment precision",
    description: "Deliver complete alignment across generated reports.",
    purpose: "Complete alignment of precision-sensitive report generation",
    outputLanguage: "en",
  });
  graph.createTask({
    projectRef: project.ref,
    title: "Implement alignment checks",
    description: "Add deterministic checks.",
    status: "ready",
    plan: executionReadyPlan("Add deterministic checks."),
  });

  const objective = inferSessionGoalObjective(graph, project);

  assert.equal(
    objective,
    "Achieve the intended project outcome: Complete alignment of precision-sensitive report generation.",
  );
  assert.doesNotMatch(objective ?? "", /Advance project|to completion|unfinished|ready/i);
});

test("native Pi session context starts goal and repro daemon loops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-pi-loops-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "native-pi");
    const piSessionId = "pi-native-session-uuid";
    (ctx as { sessionId?: string }).sessionId = undefined;
    ctx.sessionManager.getSessionId = () => piSessionId;
    const run = registerSparkToolsForTest();

    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler("Finish from native Pi", ctx);
    assert.deepEqual(run.loopControl.ensuredOwners, [{ sessionId: piSessionId, cwd: dir }]);
    assert.equal(activeTestLoop(run, "goal")?.ownerSessionId, piSessionId);
    assert.equal((await loadSessionGoal(dir, ctx))?.sessionKey, `session:${piSessionId}`);

    await executeSparkTool(run.tools, "repro", ctx, {
      action: "start",
      objective: "Reproduce from native Pi",
    });
    assert.deepEqual(run.loopControl.ensuredOwners, [
      { sessionId: piSessionId, cwd: dir },
      { sessionId: piSessionId, cwd: dir },
    ]);
    assert.equal(activeTestLoop(run, "repro")?.ownerSessionId, piSessionId);
    assert.equal((await readSessionRepro(dir, ctx))?.sessionKey, `session:${piSessionId}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native Pi /repro waits for daemon owner readiness before persisting active state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-pi-repro-readiness-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "native-pi-readiness");
    (ctx as { sessionId?: string }).sessionId = undefined;
    ctx.sessionManager.getSessionId = () => "pi-readiness-session-uuid";
    const run = registerSparkToolsForTest();
    run.loopControl.ensureOwnerSession = async () => {
      throw new Error("daemon failed to start");
    };
    const reproCommand = run.commands.get("repro");
    assert.ok(reproCommand, "missing /repro command");

    await assert.rejects(
      async () => await reproCommand.handler("start must not fake activation", ctx),
      /daemon failed to start/u,
    );

    assert.equal(await readSessionRepro(dir, ctx), undefined);
    assert.equal(activeTestLoop(run, "repro"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/repro rolls back newly persisted active state when driver start fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-start-rollback-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "repro-start-rollback");
    const run = registerSparkToolsForTest();
    run.loopControl.start = async () => {
      throw new Error("driver start failed");
    };
    const reproCommand = run.commands.get("repro");
    assert.ok(reproCommand, "missing /repro command");

    await assert.rejects(
      async () => await reproCommand.handler("start rollback probe", ctx),
      /driver start failed/u,
    );

    assert.equal(await readSessionRepro(dir, ctx), undefined);
    assert.deepEqual(ctx.sparkActiveMode, { mode: "plan" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repro tool reports driver startup failure and clears new active state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-tool-start-rollback-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "repro-tool-start-rollback");
    const run = registerSparkToolsForTest();
    run.loopControl.start = async () => {
      throw new Error("tool driver start failed");
    };
    await setSessionGoal(dir, ctx, {
      objective: "Preserve the previous reviewed Goal",
      source: "explicit",
    });
    await updateSessionGoalStatus(dir, ctx, "complete", {
      reason: "previous Goal completed",
      review: {
        achieved: true,
        reason: "reviewed before Repro activation",
        blockers: [],
        reviewRef: "review:previous-goal",
        evidenceRef: "evidence:previous-goal-review" as EvidenceRef,
        reviewedAt: "2026-08-04T00:00:00.000Z",
      },
    });
    const previousGoal = await loadSessionGoal(dir, ctx);
    assert.ok(previousGoal);

    const result = await executeSparkTool(run.tools, "repro", ctx, {
      action: "start",
      objective: "tool rollback probe",
    });

    assert.equal(result.isError, true);
    assert.match(toolText(result), /Repro did not start: tool driver start failed/u);
    assert.equal(await readSessionRepro(dir, ctx), undefined);
    assert.deepEqual(await loadSessionGoal(dir, ctx), previousGoal);
    assert.deepEqual(ctx.sparkActiveMode, { mode: "plan" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native Pi ephemeral sessions cannot start durable goal or repro loops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-pi-ephemeral-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "native-pi-ephemeral");
    (ctx as { sessionId?: string }).sessionId = undefined;
    ctx.sessionManager.getSessionId = () => "pi-ephemeral-session-uuid";
    ctx.sessionManager.getSessionFile = () => undefined;
    const run = registerSparkToolsForTest();

    await assert.rejects(
      executeSparkTool(run.tools, "goal", ctx, {
        action: "start",
        objective: "Must remain durable",
      }),
      /persistent Pi session/u,
    );
    await assert.rejects(
      executeSparkTool(run.tools, "repro", ctx, {
        action: "start",
        objective: "Must remain durable",
      }),
      /persistent Pi session/u,
    );
    assert.deepEqual(run.loopControl.ensuredOwners, []);
    assert.equal(await loadSessionGoal(dir, ctx), undefined);
    assert.equal(await readSessionRepro(dir, ctx), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal tool sets and updates durable session goals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-goal-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: createApprovingReviewerRunner(),
    });
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Tool persistence" });

    const started = await executeSparkTool(tools, "goal", ctx, {
      action: "set",
      objective: "Finish the durable goal slice",
    });
    const startedText = toolText(started);
    assert.match(startedText, /Spark session goal active\./);
    assert.doesNotMatch(startedText, /Token budget/);
    assert.doesNotMatch(startedText, /Finish the durable goal slice/);
    assert.equal(
      (started.details as { goal?: { objective?: string; status?: string } } | undefined)?.goal
        ?.objective,
      "Finish the durable goal slice",
    );
    assert.equal(
      (started.details as { goal?: { objective?: string; status?: string } } | undefined)?.goal
        ?.status,
      "active",
    );
    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    assert.match(toolText(status), /Session goal: active \| Finish the durable goal slice/);
    assert.doesNotMatch(toolText(status), /tokens/);
    assert.equal(
      (status.details as { sessionGoal?: { objective?: string } } | undefined)?.sessionGoal
        ?.objective,
      "Finish the durable goal slice",
    );

    const paused = await executeSparkTool(tools, "goal", ctx, {
      action: "pause",
      reason: "waiting",
    });
    assert.match(toolText(paused), /Spark session goal paused/);
    assert.match(toolText(paused), /Reason: waiting/);
    const pausedGoal = await loadSessionGoal(dir, ctx);
    assert.ok(pausedGoal);

    const resumed = await executeSparkTool(tools, "goal", ctx, { action: "resume" });
    assert.match(toolText(resumed), /Spark session goal active/);
    assert.equal((await loadSessionGoal(dir, ctx))?.goalId, pausedGoal.goalId);
    assert.equal((await loadSessionGoal(dir, ctx))?.pauseReason, undefined);

    const edited = await executeSparkTool(tools, "goal", ctx, {
      action: "edit",
      objective: "Finish the edited durable goal slice",
      reason: "correct stale description wording without reducing scope",
    });
    assert.match(toolText(edited), /Finish the edited durable goal slice/);
    const editedGoal = await loadSessionGoal(dir, ctx);
    assert.equal(editedGoal?.goalId, pausedGoal.goalId);
    assert.equal(editedGoal?.objective, "Finish the edited durable goal slice");
    assert.equal(editedGoal?.originalObjective, "Finish the durable goal slice");
    assert.equal(editedGoal?.lastReviewRef, undefined);
    assert.equal(editedGoal?.lastReviewEvidenceRef, undefined);
    assert.equal(editedGoal?.lastReviewedAt, undefined);

    const completionEvidence = await defaultEvidenceStore(dir).put({
      kind: "trace",
      title: "Durable goal slice completion",
      format: "text",
      body: "The durable goal lifecycle slice was exercised successfully.",
      provenance: { producer: "spark" },
    });
    const completed = await executeSparkTool(tools, "goal", ctx, {
      action: "complete",
      reason: "review passed",
      requirements: [
        {
          id: "durable-goal-slice",
          description: "The durable goal lifecycle slice is complete",
          status: "verified",
          evidenceRefs: [completionEvidence.ref],
        },
      ],
      validationRuns: ["goal lifecycle test passed"],
      unresolved: [],
    });
    assert.equal(
      (completed.details as { goal?: { status?: string } } | undefined)?.goal?.status,
      "complete",
    );
    assert.equal((await loadSessionGoal(dir, ctx))?.status, "complete");

    await executeSparkTool(tools, "goal", ctx, { action: "clear" });
    assert.equal(await loadSessionGoal(dir, ctx), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal complete uses deterministic blocker before reviewer when work remains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-complete-blocker-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await saveCurrentProjectRef(dir, ctx, project.ref);
      const doneTask = graph.createTask({
        projectRef: project.ref,
        name: "completed-evidence-does-not-bypass",
        title: "Completed evidence must not bypass unfinished work",
        description: "Provides global evidence while another required task remains unfinished.",
        status: "done",
        plan: executionReadyPlan("Completed evidence must not bypass unfinished work"),
      });
      const evidence = await defaultEvidenceStore(dir).put({
        kind: "trace",
        title: "Partial completion evidence",
        format: "text",
        body: "One completed task has evidence, but the project still has unfinished work.",
        provenance: { producer: "task", projectRef: project.ref, taskRef: doneTask.ref },
      });
      graph.attachOutputEvidence(doneTask.ref, evidence.ref);
      graph.createTask({
        projectRef: project.ref,
        name: "unfinished-complete-blocker",
        title: "Unfinished complete blocker",
        description: "Pending task blocks goal completion requests before reviewer calls.",
        status: "pending",
        plan: executionReadyPlan("Unfinished complete blocker"),
      });
    });
    await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Finish all complete blocker work",
    });

    const completed = await executeSparkTool(tools, "goal", ctx, { action: "complete" });

    assert.equal(reviewerCalls, 0);
    assert.equal(
      (completed.details as { error?: string } | undefined)?.error,
      "goal_completion_needs_changes",
    );
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.ok(goal?.lastReviewedAt);
    assert.equal(goal?.lastReviewEvidenceRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal complete requires explicit evidence and objective reviewer gates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-explicit-review-gates-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          assert.equal(input.targetKind, "goal");
          return {
            record: {
              runRef: "run:missing-goal-gates",
              roleRef: "role:reviewer",
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
            verdict: {
              targetKind: "goal",
              goalId: input.targetKind === "goal" ? input.goalId : "unexpected",
              achieved: true,
              outcome: "approved",
              confidence: "high",
              summary: "claimed complete without explicit evidence gates",
              remainingWork: "",
              blockers: [],
            },
          } as unknown as ReviewerRunResult;
        },
      },
    });
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Tool persistence" });
    await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Finish the explicit reviewer gate slice",
    });
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "trace",
      title: "Explicit reviewer gate evidence",
      format: "text",
      body: "Evidence supplied so the request reaches the reviewer semantic gates.",
      provenance: { producer: "spark" },
    });

    const completed = await executeSparkTool(tools, "goal", ctx, {
      action: "complete",
      requirements: [
        {
          id: "review-gate-slice",
          description: "The explicit reviewer gate slice is complete",
          status: "verified",
          evidenceRefs: [evidence.ref],
        },
      ],
      unresolved: [],
    });

    assert.equal(
      (completed.details as { error?: string } | undefined)?.error,
      "goal_completion_needs_changes",
    );
    assert.equal((await loadSessionGoal(dir, ctx))?.status, "active");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal complete allows an explicitly evidenced narrow goal after reviewer audit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-complete-unrelated-backlog-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    let completionEvidenceRef: EvidenceRef | undefined;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          assert.equal(input.targetKind, "goal");
          if (input.targetKind === "goal") {
            assert.equal(input.evidenceRefs.length, 1);
            assert.equal(input.projectStatus?.taskCounts.unfinished, 1);
            assert.deepEqual(input.unresolved, []);
            assert.equal(input.requirements?.[0]?.id, "loop-stop-lifecycle");
          }
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await saveCurrentProjectRef(dir, ctx, project.ref);
      const doneTask = graph.createTask({
        projectRef: project.ref,
        name: "loop-stop-validation-docs",
        title: "Update docs and run final validation for plain loop stop lifecycle",
        description: "Completed evidence for the active loop stop lifecycle goal.",
        status: "done",
        plan: executionReadyPlan(
          "Update docs and run final validation for plain loop stop lifecycle",
        ),
      });
      const evidence = await defaultEvidenceStore(dir).put({
        kind: "trace",
        title: "Loop stop lifecycle validation",
        format: "text",
        body: "tsc, lint, boundaries, and tests passed for plain loop stop lifecycle.",
        provenance: { producer: "task", projectRef: project.ref, taskRef: doneTask.ref },
      });
      completionEvidenceRef = evidence.ref;
      graph.attachOutputEvidence(doneTask.ref, evidence.ref);
      graph.createTask({
        projectRef: project.ref,
        name: "role-tui-observability-backlog",
        title: "Build role TUI observability backlog",
        description:
          "Unrelated future role TUI work must not block the narrow loop lifecycle goal.",
        status: "pending",
        plan: executionReadyPlan("Build role TUI observability backlog"),
      });
    });
    await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective:
        "将 Spark 的 plain /loop stop 语义统一为 clear/removal，并完成持久前台驱动、/goal 互斥、widget 展示、文档与验证对齐。",
    });

    assert.ok(completionEvidenceRef);
    await executeSparkTool(tools, "goal", ctx, {
      action: "complete",
      reason: "The remaining role-TUI task is outside the explicitly scoped loop-stop goal.",
      requirements: [
        {
          id: "loop-stop-lifecycle",
          description: "Plain loop stop lifecycle is implemented and validated",
          status: "verified",
          evidenceRefs: [completionEvidenceRef],
        },
      ],
      validationRuns: ["tsc, lint, boundaries, and loop lifecycle tests passed"],
      unresolved: [],
    });

    assert.equal(reviewerCalls, 1);
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "complete");
    assert.ok(goal?.lastReviewEvidenceRef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("goal reviewer failures stay unavailable across complete, edit, and pause", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-reviewer-unavailable-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const reviewerRunner: ReviewerRunner = {
      async review(input): Promise<ReviewerRunResult> {
        assert.equal(input.targetKind, "goal");
        const timestamp = new Date().toISOString();
        return {
          verdict: {
            targetKind: "goal",
            goalId: input.targetKind === "goal" ? input.goalId : "unexpected",
            achieved: false,
            outcome: "blocked",
            summary: "reviewer runtime unavailable",
            remainingWork: "retry reviewer",
            findings: [],
            blockers: ["transport unavailable"],
            confidence: "low",
          },
          record: {
            roleRef: "role:builtin-reviewer",
            startedAt: timestamp,
            finishedAt: timestamp,
          },
          failure: {
            kind: "runtime_error",
            reason: "transport unavailable",
            retryable: true,
          },
        };
      },
    };
    const { tools } = registerSparkToolsForTest({ reviewerRunner });
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Tool persistence" });
    await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Keep goal review failures out of semantic history",
    });
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "trace",
      title: "Goal completion candidate",
      format: "text",
      body: "Candidate evidence reaches the reviewer boundary.",
      provenance: { producer: "spark" },
    });

    const completed = await executeSparkTool(tools, "goal", ctx, {
      action: "complete",
      requirements: [
        {
          id: "reviewer-boundary",
          description: "Reviewer boundary remains available",
          status: "verified",
          evidenceRefs: [evidence.ref],
        },
      ],
      unresolved: [],
    });
    assert.equal(
      (completed.details as { error?: string }).error,
      "goal_completion_reviewer_unavailable",
    );

    const edited = await executeSparkTool(tools, "goal", ctx, {
      action: "edit",
      objective: "Keep all goal review failures out of semantic history",
      reason: "correct wording without lowering scope",
    });
    assert.equal((edited.details as { error?: string }).error, "goal_edit_reviewer_unavailable");

    const paused = await executeSparkTool(tools, "goal", ctx, {
      action: "pause",
      reason: "exercise unavailable reviewer boundary",
    });
    assert.equal((paused.details as { error?: string }).error, "goal_pause_reviewer_unavailable");
    assert.match(toolText(paused), /not a semantic goal rejection/u);

    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.lastReviewEvidenceRef, undefined);
    assert.equal((await defaultEvidenceStore(dir).list({ kind: "record" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal pause requires reviewer approval and preserves active goal on rejection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-pause-review-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: createRejectingReviewerRunner("pause reason is not justified"),
    });
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Pause review" });

    await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Keep working until blocker is real",
    });
    const rejected = await executeSparkTool(tools, "goal", ctx, {
      action: "pause",
      reason: "maybe stop",
    });

    assert.equal((rejected.details as { error?: string }).error, "goal_pause_review_failed");
    assert.match(toolText(rejected), /Goal pause blocked by reviewer/);
    assert.match(toolText(rejected), /pause reason is not justified/);
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal((await defaultEvidenceStore(dir).list({ kind: "record" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal rejects autonomous pause and keeps blocker resolution guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-autonomous-pause-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: createApprovingReviewerRunner(),
    });
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Autonomous pause" });
    const started = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Resolve blockers without lowering the goal",
    });
    const goalId = (started.details as { goal?: { goalId?: string } }).goal?.goalId;
    assert.ok(goalId);
    (ctx as SparkToolContext).sparkAutonomousGoalTurn = { goalId };

    const rejected = await executeSparkTool(tools, "goal", ctx, {
      action: "pause",
      reason: "blocked by hard work",
    });

    assert.equal((rejected.details as { error?: string }).error, "autonomous_goal_pause_forbidden");
    assert.match(toolText(rejected), /Autonomous goal pause is not allowed/);
    assert.match(toolText(rejected), /resolve the blocker first/);
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal((await defaultEvidenceStore(dir).list({ kind: "record" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal start updates the active session goal in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-session-update-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, {
      project: "Tool persistence",
    });

    const started = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Finish the session-scoped slice",
    });
    const startedText = toolText(started);
    assert.match(startedText, /Spark session goal active\./);
    assert.doesNotMatch(startedText, /Finish the session-scoped slice/);
    const firstGoalId = (started.details as { goal?: { goalId?: string } } | undefined)?.goal
      ?.goalId;
    assert.ok(firstGoalId);

    const updated = await executeSparkTool(tools, "goal", ctx, {
      action: "set",
      objective: "Finish the updated session slice",
    });
    assert.match(toolText(updated), /Spark session goal active\./);
    const updatedGoal = await loadSessionGoal(dir, ctx);
    assert.equal(updatedGoal?.goalId, firstGoalId);
    assert.equal(updatedGoal?.objective, "Finish the updated session slice");

    const status = await executeSparkTool(tools, "goal", ctx, { action: "status" });
    assert.match(toolText(status), /Spark session goal active/);
    assert.match(toolText(status), /Goal: Finish the updated session slice/);
    assert.doesNotMatch(toolText(status), /Project\(/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/implement canonical ask uses UI instead of reviewer auto-answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-implement-ask-ui-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let answerAskCalls = 0;
    ctx.ui.select = async (_title, options) => {
      assert.ok(options.includes("Safe path"));
      return "Safe path";
    };
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          return createTaskApprovingGoalUnmetReviewerRunner().review(input);
        },
        async answerAsk() {
          answerAskCalls += 1;
          return { blocked: true, reason: "should not auto-answer outside active goal mode" };
        },
      },
    });
    await useOnlySparkProject(run.tools, ctx);

    const implementCommand = run.commands.get("execute");
    assert.ok(implementCommand, "missing /execute command");
    await implementCommand.handler("work until a human decision is needed", ctx);
    assert.deepEqual(ctx.sparkActiveMode, {
      mode: "execute",
    });

    const asked = await executeSparkTool(run.tools, "ask", ctx, {
      title: "Choose path",
      mode: "decision",
      questions: [
        {
          id: "mode",
          label: "Mode",
          prompt: "Which path should implement mode take?",
          type: "single",
          options: [{ label: "Safe path", value: "safe_mode" }],
        },
      ],
    });

    assert.equal(answerAskCalls, 0);
    assert.notEqual((asked.details as { autoAnswered?: boolean }).autoAnswered, true);
    assert.equal(
      (asked.details as { result?: { answers?: { mode?: { values?: string[] } } } }).result?.answers
        ?.mode?.values?.[0],
      "safe_mode",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("active goal remains async-only inside manual implement mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-implement-ask-active-goal-async-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let interactionCalls = 0;
    let answerAskCalls = 0;
    let capturedRequest: Record<string, unknown> | undefined;
    ctx.ui.interaction = async (request) => {
      interactionCalls += 1;
      capturedRequest = request as unknown as Record<string, unknown>;
      return {
        kind: "askFlow",
        requestId: request.requestId,
        status: "pending",
        humanRequestId: "hreq_goal_async",
        answers: {},
      };
    };
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          return createTaskApprovingGoalUnmetReviewerRunner().review(input);
        },
        async answerAsk() {
          answerAskCalls += 1;
          return { blocked: true, reason: "reviewer fallback must remain disabled" };
        },
      },
    });
    await executeSparkTool(run.tools, "impl_use_project", ctx, {
      project: "Implement ask active goal",
    });
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Keep a goal active before manual implement mode",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) await handler({}, ctx);
    assert.equal(ctx.askAutoAnswer, undefined);
    assert.equal(ctx.sparkAutonomousAsk?.modeScope, "goal");
    assert.equal(ctx.askWaitTimeoutMs, 15 * 60_000);

    const executeCommand = run.commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("manual execution keeps autonomous asks detached", ctx);
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) await handler({}, ctx);
    assert.equal(ctx.sparkAutonomousAsk?.modeScope, "goal");

    await assert.rejects(
      () =>
        executeSparkTool(run.tools, "ask", ctx, {
          title: "Choose path",
          mode: "decision",
          questions: [
            {
              id: "mode",
              prompt: "Which path should manual implement mode take?",
              type: "single",
              options: [{ label: "Safe path", value: "safe_mode" }],
            },
          ],
        }),
      /AUTONOMOUS_ASYNC_ONLY/u,
    );
    assert.equal(interactionCalls, 0);

    const asked = await executeSparkTool(run.tools, "ask", ctx, {
      delivery: "async",
      title: "Choose path",
      mode: "decision",
      questions: [
        {
          id: "mode",
          prompt: "Which path should manual implement mode take?",
          type: "single",
          options: [{ label: "Safe path", value: "safe_mode" }],
        },
      ],
    });
    assert.equal(answerAskCalls, 0);
    assert.equal(interactionCalls, 1);
    assert.equal((asked.details as { result?: { status?: string } }).result?.status, "pending");
    assert.match(String(capturedRequest?.requestId), /^ask_async:[a-f0-9]{64}$/u);
    assert.deepEqual(capturedRequest?.evidenceRequest, {
      schema: "spark.evidence-request/v1",
      askRef: `ask:${String(capturedRequest?.requestId).slice("ask_async:".length)}`,
      ownerSessionId: ctx.sessionId,
      goalOrReproId: ctx.sparkAutonomousAsk?.goalOrReproId,
      modeScope: "goal",
      planRevision: 1,
      ownerStepOrUnresolvedId: (
        capturedRequest?.evidenceRequest as { ownerStepOrUnresolvedId?: string }
      )?.ownerStepOrUnresolvedId,
      stepDefinitionDigest: (capturedRequest?.evidenceRequest as { stepDefinitionDigest?: string })
        ?.stepDefinitionDigest,
      requestHash: String(capturedRequest?.requestId).slice("ask_async:".length),
      ownerQuestionId: "mode",
      expectedAnswerKind: "single",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("goal start rejects same-turn reviewer auto-answer before UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-same-turn-async-only-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let interactionCalls = 0;
    let answerAskCalls = 0;
    ctx.ui.interaction = async () => {
      interactionCalls += 1;
      throw new Error("autonomous guard must run before UI");
    };
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          return createTaskApprovingGoalUnmetReviewerRunner().review(input);
        },
        async answerAsk() {
          answerAskCalls += 1;
          return { answers: { mode: { values: ["safe_mode"] } } };
        },
      },
    });

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Require detached user evidence",
    });
    assert.equal(ctx.askAutoAnswer, undefined);
    assert.equal(ctx.askAutoAnswerResolver, undefined);
    assert.equal(ctx.sparkAutonomousAsk?.modeScope, "goal");

    await assert.rejects(
      () =>
        executeSparkTool(run.tools, "ask", ctx, {
          action: "ask",
          autoAnswer: true,
          delivery: "async",
          title: "Choose path",
          mode: "decision",
          questions: [
            {
              id: "mode",
              prompt: "Which path should goal mode take?",
              type: "single",
              options: [{ label: "Safe path", value: "safe_mode" }],
            },
          ],
        }),
      /AUTONOMOUS_ASYNC_ONLY.*autoAnswer/u,
    );
    assert.equal(answerAskCalls, 0);
    assert.equal(interactionCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("active goal exposes no raw Ask alias capable of bypassing canonical binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-ask-alias-guard-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let interactionCalls = 0;
    ctx.ui.interaction = async () => {
      interactionCalls += 1;
      throw new Error("raw alias guard must run before UI");
    };
    const run = registerSparkToolsForTest();
    await executeSparkTool(run.tools, "impl_use_project", ctx, { project: "Goal ask" });
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Use only canonical detached asks",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) await handler({}, ctx);

    assert.equal(run.tools.has("ask_user"), false);
    assert.equal(run.tools.has("ask_flow"), false);
    assert.equal(interactionCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("active goal rejects omitted and explicit blocking delivery before broker invocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-blocking-ask-guard-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let interactionCalls = 0;
    let answerAskCalls = 0;
    ctx.ui.interaction = async () => {
      interactionCalls += 1;
      throw new Error("guard must precede broker invocation");
    };
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          return createTaskApprovingGoalUnmetReviewerRunner().review(input);
        },
        async answerAsk() {
          answerAskCalls += 1;
          return { blocked: true, reason: "must not run" };
        },
      },
    });
    await executeSparkTool(run.tools, "impl_use_project", ctx, { project: "Goal ask blocker" });
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Reject blocking autonomous asks",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) await handler({}, ctx);

    const base = {
      title: "Choose path",
      mode: "decision",
      questions: [
        {
          id: "mode",
          prompt: "Which path should goal mode take?",
          type: "single",
          options: [{ label: "Safe path", value: "safe_mode" }],
        },
      ],
    };
    await assert.rejects(
      () => executeSparkTool(run.tools, "ask", ctx, base),
      /AUTONOMOUS_ASYNC_ONLY/u,
    );
    await assert.rejects(
      () => executeSparkTool(run.tools, "ask", ctx, { ...base, delivery: "blocking" }),
      /AUTONOMOUS_ASYNC_ONLY/u,
    );
    assert.equal(interactionCalls, 0);
    assert.equal(answerAskCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("active session goal keeps canonical ask but disables raw ask tools before agent turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-disable-asks-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await executeSparkTool(run.tools, "impl_use_project", ctx, { project: "Tool persistence" });
    assert.ok(run.getActiveToolNames().includes("ask"));
    assert.ok(!run.getActiveToolNames().includes("ask_user"));
    assert.ok(!run.getActiveToolNames().includes("ask_flow"));
    assert.ok(!run.getActiveToolNames().some((name) => name.startsWith("spark_")));

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Run without interactive asks",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
      await handler({}, ctx);
    }

    assert.ok(run.getActiveToolNames().includes("ask"));
    assert.equal((ctx as SparkToolContext).askAutoAnswer, undefined);
    assert.equal(ctx.sparkAutonomousAsk?.modeScope, "goal");
    assert.equal(ctx.askWaitTimeoutMs, 15 * 60_000);
    assert.ok(!run.getActiveToolNames().includes("ask_user"));
    assert.ok(!run.getActiveToolNames().includes("ask_flow"));
    assert.ok(run.getActiveToolNames().includes("goal"));
    assert.ok(!run.getActiveToolNames().includes("task"));
    assert.ok(run.getActiveToolNames().includes("task_read"));
    assert.ok(run.getActiveToolNames().includes("task_write"));
    assert.ok(run.getActiveToolNames().includes("assign"));

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "pause",
      reason: "waiting",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
      await handler({}, ctx);
    }

    assert.ok(run.getActiveToolNames().includes("ask"));
    assert.ok(!run.getActiveToolNames().includes("ask_user"));
    assert.ok(!run.getActiveToolNames().includes("ask_flow"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lens is registered internally and remains inactive by default", () => {
  const run = registerSparkToolsForTest();

  assert.ok(run.tools.has("lens"));
  assert.ok(!run.getActiveToolNames().includes("lens"));
});

test("active session goal preserves tools disabled by other extensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-preserve-disabled-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await executeSparkTool(run.tools, "impl_use_project", ctx, { project: "Preserve disabled" });

    // Simulate another extension (spark-cue) that registers `bash` and then
    // deactivates it at session start, leaving it registered-but-inactive.
    run.registerActiveTool("bash");
    run.setActiveTools(run.getActiveToolNames().filter((name) => name !== "bash"));
    assert.ok(!run.getActiveToolNames().includes("bash"), "bash starts disabled");

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Run without re-enabling bash",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
      await handler({}, ctx);
    }
    assert.ok(
      !run.getActiveToolNames().includes("bash"),
      "goal activation must not re-enable an externally disabled tool",
    );

    await executeSparkTool(run.tools, "goal", ctx, { action: "pause", reason: "waiting" });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
      await handler({}, ctx);
    }
    assert.ok(
      !run.getActiveToolNames().includes("bash"),
      "goal deactivation must not re-enable an externally disabled tool",
    );
    assert.ok(run.getActiveToolNames().includes("ask"), "ask is restored after goal ends");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark project tools reject invalid explicit parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    assert.match(JSON.stringify(tools.get("impl_use_project")?.parameters), /purpose/);
    assert.match(JSON.stringify(tools.get("task_write")?.parameters), /Project purpose/);

    await assert.rejects(
      () => executeSparkTool(tools, "impl_project_mutation", ctx, { intent: "rename", title: "" }),
      /title must be a non-empty string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_project_mutation", ctx, {
          intent: "rename",
          project: 42,
          title: "Next",
        }),
      /project must be a string/,
    );
    const statusOnly = await executeSparkTool(tools, "impl_project_mutation", ctx, {
      intent: "metadata_update",
      status: "archived",
    });
    assert.equal(statusOnly.isError, true);
    assert.equal((statusOnly.details as { error?: string }).error, "project_status_removed");
    await assert.rejects(
      () => executeSparkTool(tools, "impl_use_project", ctx, { project: "" }),
      /project must be a non-empty string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_use_project", ctx, { title: "New", outputLanguage: "jp" }),
      /outputLanguage must be zh or en/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark extension exposes canonical tools instead of removed spark_* tools", () => {
  const run = registerSparkToolsForTest();
  assert.equal(run.tools.has("task"), false);
  assert.ok(run.tools.has("task_read"));
  assert.ok(run.tools.has("task_write"));
  assert.ok(run.tools.has("assign"));
  assert.ok(run.tools.has("memory"));
  assert.equal(run.tools.has("learning"), false);
  assert.ok(run.tools.has("ask"));
  assert.ok(run.tools.has("role"));
  assert.ok(run.tools.has("session"));
  assert.ok(run.tools.has("goal"));
  assert.ok(run.tools.has("loop"));
  assert.ok(run.tools.has("repro"));
  assert.ok(run.tools.has("workflow"));
  assert.equal(run.tools.has("workflow_run"), false);
  assert.equal(run.tools.has("drive"), false);
  assert.equal(run.tools.has("driver"), false);
  assert.ok(run.tools.has("mode"));
  assert.equal(run.tools.has("phase"), false);
  assert.deepEqual(
    run
      .getActiveToolNames()
      .filter((name) => name.startsWith("spark_"))
      .sort(),
    [],
  );
});

test("mode tool returns requirements and persists session mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-mode-tool-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Tool persistence" });

    const switched = await executeSparkTool(tools, "mode", ctx, {
      action: "plan",
      focus: "tighten task graph",
    });
    assert.deepEqual(switched.details, { mode: "plan", statusOnly: false });
    assert.match(toolText(switched), /Mode set to: plan/);
    assert.deepEqual(await loadSparkMode(dir, ctx), { mode: "plan" });

    const status = await executeSparkTool(tools, "mode", ctx, { action: "status" });
    assert.deepEqual(status.details, { mode: "plan", statusOnly: true });
    assert.match(toolText(status), /Current mode: plan/);

    await assert.rejects(
      () => executeSparkTool(tools, "mode", ctx, { action: "research" }),
      /mode action must be one of: plan, execute, status/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("active Repro binds detached Ask to its current step revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-async-evidence-binding-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let interactionCalls = 0;
    let answerAskCalls = 0;
    let capturedRequest: ExtensionInteractionRequest | undefined;
    ctx.ui.interaction = async (request) => {
      interactionCalls += 1;
      capturedRequest = request;
      return {
        kind: "askFlow",
        requestId: request.requestId,
        status: "pending",
        humanRequestId: "hreq_repro_async",
        answers: {},
      };
    };
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          return createTaskApprovingGoalUnmetReviewerRunner().review(input);
        },
        async answerAsk() {
          answerAskCalls += 1;
          return { blocked: true, reason: "reviewer fallback must remain disabled" };
        },
      },
    });
    const reproCommand = run.commands.get("repro");
    assert.ok(reproCommand, "missing /repro command");
    await reproCommand.handler("start", ctx);
    const initial = await readSessionRepro(dir, ctx);
    assert.ok(initial);
    const stepId = initial.plan.steps[0]?.id;
    assert.ok(stepId);
    await executeSparkTool(run.tools, "repro", ctx, {
      action: "plan",
      reason: "Require a current detached decision binding",
      steps: initial.plan.steps.map((step) => ({
        id: step.id,
        stage: step.stage,
        goal: step.goal,
        doneWhen: step.doneWhen,
        evidenceRequired: step.evidenceRequired,
        authority: step.id === stepId ? "ask_decision" : step.authority,
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
      })),
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) await handler({}, ctx);
    const repro = await readSessionRepro(dir, ctx);
    assert.ok(repro);
    assert.equal(ctx.sparkAutonomousAsk?.modeScope, "repro");

    const base = {
      delivery: "async",
      title: "Choose reference",
      mode: "decision",
      questions: [
        {
          id: "reference",
          prompt: "Which reference should be used?",
          type: "single",
          options: [
            { label: "Official", value: "official" },
            { label: "Stop", value: "stop" },
          ],
        },
      ],
    };
    await assert.rejects(
      () => executeSparkTool(run.tools, "ask", ctx, base),
      /AUTONOMOUS_EVIDENCE_BINDING_REQUIRED/u,
    );
    assert.equal(interactionCalls, 0);

    const step = repro.plan.steps.find((candidate) => candidate.id === stepId);
    assert.ok(step);
    const stepBinding = createReproStepAskBinding(repro, step);
    const bound = {
      ...base,
      context: encodeReproStepAskBinding(stepBinding),
    };
    const { delivery: _delivery, ...omittedDelivery } = bound;
    for (const rejected of [
      omittedDelivery,
      { ...bound, delivery: "blocking" },
      { ...bound, autoAnswer: true },
    ]) {
      await assert.rejects(
        () => executeSparkTool(run.tools, "ask", ctx, rejected),
        /AUTONOMOUS_ASYNC_ONLY/u,
      );
    }
    assert.ok(!run.getActiveToolNames().includes("ask_user"));
    assert.ok(!run.getActiveToolNames().includes("ask_flow"));
    assert.equal(answerAskCalls, 0);
    assert.equal(interactionCalls, 0);

    await assert.rejects(
      () =>
        executeSparkTool(run.tools, "ask", ctx, {
          ...base,
          context: encodeReproStepAskBinding({
            ...stepBinding,
            planRevision: stepBinding.planRevision - 1,
          }),
        }),
      /must match the current plan revision/u,
    );
    await assert.rejects(
      () =>
        executeSparkTool(run.tools, "ask", ctx, {
          ...base,
          mode: "approval",
          context: encodeReproStepAskBinding(stepBinding),
        }),
      /must match the current plan revision/u,
    );
    assert.equal(interactionCalls, 0);

    const asked = await executeSparkTool(run.tools, "ask", ctx, bound);
    assert.equal((asked.details as { result?: { status?: string } }).result?.status, "pending");
    assert.equal(interactionCalls, 1);
    assert.equal(
      capturedRequest?.kind === "askFlow" ? capturedRequest.toolCallId : undefined,
      "call-ask",
    );
    const evidenceRequest =
      capturedRequest?.kind === "askFlow" ? capturedRequest.evidenceRequest : undefined;
    assert.deepEqual(evidenceRequest, {
      schema: "spark.evidence-request/v1",
      askRef: `ask:${evidenceRequest?.requestHash}`,
      ownerSessionId: ctx.sessionId,
      goalOrReproId: repro.reproId,
      modeScope: "repro",
      planRevision: stepBinding.planRevision,
      ownerStepOrUnresolvedId: stepBinding.stepId,
      stepDefinitionDigest: stepBinding.definitionDigest,
      requestHash: evidenceRequest?.requestHash,
      ownerQuestionId: "reference",
      expectedAnswerKind: "single",
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("/repro command starts, reports, and stops the Repro", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-command-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const reproCommand = run.commands.get("repro");
    assert.ok(reproCommand, "missing /repro command");

    await reproCommand.handler("start", ctx);
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
      await handler({}, ctx);
    }
    const repro = await readSessionRepro(dir, ctx);
    assert.equal(repro?.status, "active");
    assert.deepEqual(ctx.sparkActiveMode, { mode: "plan" });
    assert.equal(ctx.askWaitTimeoutMs, 15 * 60_000);
    assert.equal(ctx.askAutoAnswer, undefined);
    const driver = activeTestLoop(run, "repro");
    assert.equal(driver?.loopId, repro?.reproId);
    assert.equal(driver?.status, "scheduled");

    await reproCommand.handler("status", ctx);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark repro scheduled/);

    await reproCommand.handler("stop", ctx);
    assert.equal(await readSessionRepro(dir, ctx), undefined);
    assert.deepEqual(ctx.sparkActiveMode, { mode: "plan" });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("/repro command treats non-action text as the repro objective", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-command-objective-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const reproCommand = run.commands.get("repro");
    assert.ok(reproCommand, "missing /repro command");

    const objective = "你来进行正经的复现对齐工作";
    await reproCommand.handler(objective, ctx);

    const repro = await readSessionRepro(dir, ctx);
    assert.equal(repro?.status, "active");
    assert.equal(repro?.objective, objective);
    assert.deepEqual(ctx.sparkActiveMode, { mode: "plan" });
    assert.equal(activeTestLoop(run, "repro")?.loopId, repro?.reproId);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark repro active:/);
    assert.match(ctx.notifications.at(-1)?.message ?? "", new RegExp(objective));

    const updatedObjective = "重新对齐复现验收证据";
    await reproCommand.handler(`start ${updatedObjective}`, ctx);
    const updated = await readSessionRepro(dir, ctx);
    assert.equal(updated?.reproId, repro?.reproId);
    assert.equal(updated?.objective, updatedObjective);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro record without an active drive returns an actionable recovery hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-inactive-recovery-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const status = await executeSparkTool(tools, "repro", ctx, { action: "status" });
    assert.match(toolText(status), /No Repro is active\./);
    assert.match(toolText(status), /repro\(\{ action: "start" \}\)/);
    assert.equal((status.details as { active?: boolean }).active, false);
    assert.equal((status.details as { recovery?: string }).recovery, 'repro({ action: "start" })');

    const record = await executeSparkTool(tools, "repro", ctx, {
      action: "record",
      requirementId: "repro-contract-frozen",
      proof: { kind: "evidence", evidenceRefs: ["evidence:00000000-0000-4000-8000-000000000000"] },
    });
    assert.match(toolText(record), /No active Repro\./);
    assert.match(toolText(record), /repro\(\{ action: "start" \}\)/);
    assert.match(toolText(record), /evidence refs stay valid/);
    assert.equal((record.details as { active?: boolean }).active, false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro start binds an explicit Bench run id as the accounting scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-explicit-id-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "repro", ctx, {
      action: "start",
      reproId: "bench-run-42",
    });
    const repro = await readSessionRepro(dir, ctx);
    assert.equal(repro?.reproId, "bench-run-42");

    await assert.rejects(
      () =>
        executeSparkTool(tools, "repro", ctx, {
          action: "start",
          reproId: "another-run",
        }),
      /active Repro id bench-run-42 does not match requested reproId another-run/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro sync_report reuses its per-run Artifact ref without mutating Repro truth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-sync-report-action-"));
  try {
    await writeEmptySparkProject(dir);
    await mkdir(join(dir, "outputs"), { recursive: true });
    await writeFile(join(dir, "outputs", "report.md"), "# Repro report\n", "utf8");
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      usageControl: {
        async summary() {
          throw new Error("usage intentionally unavailable");
        },
      },
    });
    const repro = createSparkSessionRepro(ctx.sessionId);
    await writeSessionRepro(dir, repro, ctx);
    const before = await readSessionRepro(dir, ctx);
    for (const id of ["contract", "reference", "target"]) {
      await defaultEvidenceStore(dir).put({
        ref: `evidence:${id}` as EvidenceRef,
        kind: "record",
        title: id,
        format: "json",
        body: { passed: true },
        provenance: { producer: "spark" },
      });
    }
    await executeSparkTool(tools, "repro", ctx, {
      action: "project_report",
      workSummary: canonicalReportWorkInput(repro.reproId),
    });

    const first = await executeSparkTool(tools, "repro", ctx, { action: "sync_report" });
    const second = await executeSparkTool(tools, "repro", ctx, { action: "sync_report" });
    const firstDetails = first.details as {
      changed?: boolean;
      status?: string;
      progressPercent?: number;
      refs?: { reportArtifactRef?: ArtifactRef };
      artifact?: { revision?: number };
    };
    const secondDetails = second.details as {
      changed?: boolean;
      refs?: { reportArtifactRef?: ArtifactRef };
      artifact?: { revision?: number };
    };
    assert.equal(firstDetails.changed, true);
    assert.equal(firstDetails.status, "active");
    assert.equal(firstDetails.progressPercent, undefined);
    assert.equal(secondDetails.changed, false);
    assert.ok(firstDetails.refs?.reportArtifactRef);
    assert.equal(secondDetails.refs?.reportArtifactRef, firstDetails.refs.reportArtifactRef);
    assert.equal(firstDetails.artifact?.revision, 1);
    assert.equal(secondDetails.artifact?.revision, 1);

    const stored = await defaultArtifactStore(dir).get(firstDetails.refs.reportArtifactRef);
    assert.equal(stored.kind, "document");
    assert.equal(stored.body.kind, "document");
    if (stored.body.kind !== "document") throw new Error("expected report Document");
    assert.equal(stored.body.content, await readFile(join(dir, "outputs", "report.md"), "utf8"));
    assert.match(stored.body.content, /^# Spark Reproduction Report\n/u);
    assert.deepEqual(await readSessionRepro(dir, ctx), before);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro project_report writes canonical work plus daemon usage without mutating Repro truth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-project-report-action-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const repro = createSparkSessionRepro(ctx.sessionId);
    await writeSessionRepro(dir, repro, ctx);
    const before = await readSessionRepro(dir, ctx);
    for (const id of ["contract", "reference", "target"]) {
      await defaultEvidenceStore(dir).put({
        ref: `evidence:${id}` as EvidenceRef,
        kind: "record",
        title: id,
        format: "json",
        body: { passed: true },
        provenance: { producer: "spark" },
      });
    }
    const run = registerSparkToolsForTest({
      usageControl: {
        async summary(input) {
          assert.deepEqual(input, { scope: { kind: "repro", reproId: repro.reproId } });
          const reported = {
            inputTokens: 11,
            outputTokens: 7,
            cacheReadTokens: 2,
            cacheWriteTokens: 0,
            totalTokens: 20,
          };
          const zero = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
          };
          return {
            scope: input.scope,
            reported,
            estimated: zero,
            totalTokens: 20,
            responseCount: 1,
            missingResponseCount: 0,
            activeExecutionCount: 0,
            quality: "exact",
            byExecutionKind: { root_session: reported },
            byModel: { "provider/model": reported },
            asOf: "2026-08-03T12:00:00.000Z",
          };
        },
      },
    });

    const result = await executeSparkTool(run.tools, "repro", ctx, {
      action: "project_report",
      workSummary: canonicalReportWorkInput(repro.reproId),
    });
    assert.match(
      toolText(result),
      /Projected outputs\/spark-summary\.json and outputs\/report\.md with exact token usage/u,
    );
    const stored = JSON.parse(
      await readFile(join(dir, "outputs", "spark-summary.json"), "utf8"),
    ) as {
      format?: string;
      work?: {
        reproId?: string;
        status?: string;
        progress?: { quantified?: boolean; percent?: number | null };
      };
      tokenUsage?: { totalTokens?: number };
    };
    assert.equal(stored.format, "spark-repro-summary/v1");
    assert.equal(stored.work?.reproId, repro.reproId);
    assert.equal(stored.work?.status, "active");
    assert.equal(stored.work?.progress?.percent, undefined);
    assert.equal(stored.work?.progress?.quantified, false);
    assert.equal(stored.tokenUsage?.totalTokens, 20);
    assert.match(
      await readFile(join(dir, "outputs", "report.md"), "utf8"),
      /^# Spark Reproduction Report\n/u,
    );
    assert.deepEqual(await readSessionRepro(dir, ctx), before);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro record accepts only receipt-backed ask decisions with matching values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-proof-validation-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, { action: "start" });

    await assert.rejects(
      () =>
        executeSparkTool(tools, "repro", ctx, {
          action: "record",
          requirementId: "repro-contract-frozen",
          proof: { kind: "evidence", evidenceRefs: ["artifact:product-proof"] },
        }),
      /must be an evidence: ref/u,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "repro", ctx, {
          action: "record",
          requirementId: "repro-contract-frozen",
          proof: { kind: "evidence", evidenceRefs: ["evidence:missing"] },
        }),
      /proof evidence not found/u,
    );

    ctx.selected = "Reuse";
    const canonicalAsk = await executeSparkTool(tools, "ask", ctx, {
      action: "ask",
      delivery: "blocking",
      recordAsEvidence: true,
      title: "Choose implementation strategy",
      mode: "decision",
      questions: [
        {
          id: "strategy",
          prompt: "Reuse or implement anew?",
          type: "single",
          options: [
            { value: "reuse", label: "Reuse" },
            { value: "new", label: "New implementation" },
          ],
        },
      ],
    });
    const canonicalDecisionRef = canonicalAsk.details?.askEvidenceRef;
    assert.equal(typeof canonicalDecisionRef, "string");
    assert.match(canonicalDecisionRef as string, /^evidence:/u);
    const canonicalEvidence = await defaultEvidenceStore(dir).get(
      canonicalDecisionRef as EvidenceRef,
    );

    const forgedDecision = await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Forged canonical ask",
      format: "json",
      body: canonicalEvidence.body,
      provenance: { producer: "ask" },
    });
    await assert.rejects(
      () =>
        executeSparkTool(tools, "repro", ctx, {
          action: "record",
          requirementId: "implementation-strategy-approved",
          proof: {
            kind: "decision",
            decisionRef: forgedDecision.ref,
            selectedValue: "reuse",
          },
        }),
      /canonical ask evidence with a valid receipt/u,
    );

    await assert.rejects(
      () =>
        executeSparkTool(tools, "repro", ctx, {
          action: "record",
          requirementId: "implementation-strategy-approved",
          proof: {
            kind: "decision",
            decisionRef: canonicalDecisionRef,
            selectedValue: "new",
          },
        }),
      /selectedValue does not match the canonical ask answer/u,
    );

    const recorded = await executeSparkTool(tools, "repro", ctx, {
      action: "record",
      requirementId: "implementation-strategy-approved",
      proof: {
        kind: "decision",
        decisionRef: canonicalDecisionRef,
        selectedValue: "reuse",
      },
    });
    assert.match(recorded.content[0]?.text ?? "", /Recorded decision proof/u);

    const reviewerDecision = await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Reviewer decision is not user evidence",
      format: "json",
      body: {
        schema: "spark.ask.evidence/v2",
        request: { questions: [{ id: "strategy", prompt: "Choose strategy" }] },
        result: {
          status: "answered",
          answerSource: "reviewer",
          answers: { strategy: { values: ["reuse"] } },
        },
        answerSource: "reviewer",
        autoAnswered: true,
        recordedAt: new Date().toISOString(),
      },
      provenance: { producer: "ask" },
    });
    await assert.rejects(
      () =>
        executeSparkTool(tools, "repro", ctx, {
          action: "record",
          requirementId: "implementation-strategy-approved",
          proof: {
            kind: "decision",
            decisionRef: reviewerDecision.ref,
            selectedValue: "reuse",
          },
        }),
      /canonical ask evidence with a valid receipt/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro approval Steps require a current bound approving Ask receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-step-approval-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, { action: "start" });
    const initial = await readSessionRepro(dir, ctx);
    if (!initial) throw new Error("missing active repro");
    const stepId = "freeze-source-model-weight-data-contract";
    await executeSparkTool(tools, "repro", ctx, {
      action: "plan",
      reason: "Require explicit contract approval",
      steps: initial.plan.steps.map((step) => ({
        id: step.id,
        stage: step.stage,
        goal: step.goal,
        doneWhen: step.doneWhen,
        evidenceRequired: step.evidenceRequired,
        authority: step.id === stepId ? "ask_approval" : step.authority,
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
      })),
    });
    const repro = await readSessionRepro(dir, ctx);
    const step = repro?.plan.steps.find((candidate) => candidate.id === stepId);
    if (!repro || !step) throw new Error("missing approval step");
    const askContext = encodeReproStepAskBinding(createReproStepAskBinding(repro, step));
    const ask = async (selected: "Approve" | "Reject", context = askContext) => {
      ctx.selected = selected;
      return await executeSparkTool(tools, "ask", ctx, {
        action: "ask",
        delivery: "blocking",
        recordAsEvidence: true,
        title: "Approve contract freeze",
        mode: "approval",
        context,
        questions: [
          {
            id: "approval",
            prompt: "Approve this exact Step definition?",
            type: "single",
            required: true,
            options: [
              { value: "approve", label: "Approve" },
              { value: "reject", label: "Reject" },
            ],
          },
        ],
      });
    };

    const rejectedAsk = await ask("Reject");
    const rejectedRef = rejectedAsk.details?.askEvidenceRef;
    assert.equal(typeof rejectedRef, "string");
    const rejected = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId,
      stepStatus: "done",
      stepEvidenceRefs: [rejectedRef],
    });
    assert.equal(rejected.isError, true);
    assert.match(toolText(rejected), /selected value "approve"/u);

    const staleBinding = encodeReproStepAskBinding({
      ...createReproStepAskBinding(repro, step),
      planRevision: repro.plan.currentRevision - 1,
    });
    const staleAsk = await ask("Approve", staleBinding);
    const staleRef = staleAsk.details?.askEvidenceRef;
    assert.equal(typeof staleRef, "string");
    const stale = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId,
      stepStatus: "done",
      stepEvidenceRefs: [staleRef],
    });
    assert.equal(stale.isError, true);
    assert.match(toolText(stale), /bound canonical Ask/u);

    const approvedAsk = await ask("Approve");
    const approvedRef = approvedAsk.details?.askEvidenceRef;
    assert.equal(typeof approvedRef, "string");
    const approved = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId,
      stepStatus: "done",
      stepEvidenceRefs: [approvedRef],
    });
    assert.match(toolText(approved), /updated to done/u);
    assert.deepEqual(
      (await readSessionRepro(dir, ctx))?.plan.steps.find((candidate) => candidate.id === stepId)
        ?.verification?.selectedValues,
      ["approve"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro approval Step accepts only current direct-user AnswerEvent Evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-step-answer-event-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, { action: "start" });
    const initial = await readSessionRepro(dir, ctx);
    if (!initial) throw new Error("missing active repro");
    const stepId = "freeze-source-model-weight-data-contract";
    await executeSparkTool(tools, "repro", ctx, {
      action: "plan",
      reason: "Require a detached approval AnswerEvent",
      steps: initial.plan.steps.map((step) => ({
        id: step.id,
        stage: step.stage,
        goal: step.goal,
        doneWhen: step.doneWhen,
        evidenceRequired: step.evidenceRequired,
        authority: step.id === stepId ? "ask_approval" : step.authority,
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
      })),
    });
    const repro = await readSessionRepro(dir, ctx);
    const step = repro?.plan.steps.find((candidate) => candidate.id === stepId);
    if (!repro || !step) throw new Error("missing approval step");
    const binding = createReproStepAskBinding(repro, step);
    const eventBody = (input: {
      response: string;
      revision?: number;
      provenance?: string;
      expectedAnswerKind?: "single" | "approval";
    }) => {
      const requestHash = "a".repeat(64);
      return {
        schema: "spark.evidence-answer-event/v1" as const,
        answerEventId: `answer-event:${input.response}`,
        humanRequestId: `hreq-${input.response}`,
        interactionRequestId: `ask_async:${requestHash}`,
        humanResponseId: `hres-${input.response}`,
        provenance: input.provenance ?? "direct_user",
        binding: {
          schema: "spark.evidence-request/v1" as const,
          askRef: `ask:${requestHash}`,
          ownerSessionId: repro.sessionKey,
          goalOrReproId: repro.reproId,
          modeScope: "repro" as const,
          planRevision: input.revision ?? binding.planRevision,
          ownerStepOrUnresolvedId: binding.stepId,
          stepDefinitionDigest: binding.definitionDigest,
          requestHash,
          ownerQuestionId: "approval",
          expectedAnswerKind: input.expectedAnswerKind ?? "approval",
        },
        answers: { approval: { questionId: "approval", values: ["approve"] } },
        acceptedAt: new Date().toISOString(),
      };
    };
    const store = defaultEvidenceStore(dir);
    const staleBody = eventBody({ response: "stale", revision: binding.planRevision - 1 });
    const stale = await store.put({
      ref: `evidence:${staleBody.answerEventId}` as EvidenceRef,
      kind: "record",
      title: "Stale AnswerEvent",
      format: "json",
      body: staleBody,
      provenance: { producer: "ask" },
      links: [{ to: staleBody.binding.askRef as AskRef, relation: "answer-to" as const }],
    });
    await recordCanonicalAnswerEventEvidenceReceipt(
      dir,
      stale,
      sparkEvidenceAnswerEventSchema.parse(staleBody),
    );
    const staleResult = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId,
      stepStatus: "done",
      stepEvidenceRefs: [stale.ref],
    });
    assert.equal(staleResult.isError, true);

    const wrongKindBody = eventBody({ response: "wrong-kind", expectedAnswerKind: "single" });
    const wrongKind = await store.put({
      ref: `evidence:${wrongKindBody.answerEventId}` as EvidenceRef,
      kind: "record",
      title: "Wrong-kind AnswerEvent",
      format: "json",
      body: wrongKindBody,
      provenance: { producer: "ask" },
      links: [{ to: wrongKindBody.binding.askRef as AskRef, relation: "answer-to" as const }],
    });
    await recordCanonicalAnswerEventEvidenceReceipt(
      dir,
      wrongKind,
      sparkEvidenceAnswerEventSchema.parse(wrongKindBody),
    );
    const wrongKindResult = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId,
      stepStatus: "done",
      stepEvidenceRefs: [wrongKind.ref],
    });
    assert.equal(wrongKindResult.isError, true);

    const synthetic = await store.put({
      kind: "record",
      title: "Synthetic AnswerEvent",
      format: "json",
      body: eventBody({ response: "synthetic", provenance: "system" }),
      provenance: { producer: "review" },
    });
    const syntheticResult = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId,
      stepStatus: "done",
      stepEvidenceRefs: [synthetic.ref],
    });
    assert.equal(syntheticResult.isError, true);

    const sideAnswerBody = {
      ...eventBody({ response: "side-answer" }),
      answers: { notes: { questionId: "notes", values: ["approve"] } },
    };
    const sideAnswer = await store.put({
      ref: `evidence:${sideAnswerBody.answerEventId}` as EvidenceRef,
      kind: "record",
      title: "Side-question AnswerEvent",
      format: "json",
      body: sideAnswerBody,
      provenance: { producer: "ask" },
      links: [{ to: sideAnswerBody.binding.askRef as AskRef, relation: "answer-to" as const }],
    });
    const sideAnswerResult = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId,
      stepStatus: "done",
      stepEvidenceRefs: [sideAnswer.ref],
    });
    assert.equal(sideAnswerResult.isError, true);

    const wrongCardinalityBody = {
      ...eventBody({ response: "wrong-cardinality" }),
      answers: {
        approval: { questionId: "approval", values: ["approve", "reject"] },
      },
    };
    const wrongCardinality = await store.put({
      ref: `evidence:${wrongCardinalityBody.answerEventId}` as EvidenceRef,
      kind: "record",
      title: "Wrong-cardinality AnswerEvent",
      format: "json",
      body: wrongCardinalityBody,
      provenance: { producer: "ask" },
      links: [
        { to: wrongCardinalityBody.binding.askRef as AskRef, relation: "answer-to" as const },
      ],
    });
    const wrongCardinalityResult = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId,
      stepStatus: "done",
      stepEvidenceRefs: [wrongCardinality.ref],
    });
    assert.equal(wrongCardinalityResult.isError, true);

    const directBody = eventBody({ response: "direct" });
    const direct = await store.put({
      ref: `evidence:${directBody.answerEventId}` as EvidenceRef,
      kind: "record",
      title: "Direct user AnswerEvent",
      format: "json",
      body: directBody,
      provenance: { producer: "ask" },
      links: [{ to: directBody.binding.askRef as AskRef, relation: "answer-to" as const }],
    });
    await recordCanonicalAnswerEventEvidenceReceipt(
      dir,
      direct,
      sparkEvidenceAnswerEventSchema.parse(directBody),
    );
    const approved = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId,
      stepStatus: "done",
      stepEvidenceRefs: [direct.ref],
    });
    assert.match(toolText(approved), /updated to done/u);
    assert.deepEqual(
      (await readSessionRepro(dir, ctx))?.plan.steps.find((candidate) => candidate.id === stepId)
        ?.verification?.selectedValues,
      ["approve"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("reading a v4 done Step without verifier provenance reopens it fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-v4-migration-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const repro = createSparkSessionRepro(ctx.sessionId);
    const [firstStep, ...otherSteps] = repro.plan.steps;
    if (!firstStep) throw new Error("missing seeded repro step");
    const stored = {
      ...repro,
      plan: {
        ...repro.plan,
        steps: [
          { ...firstStep, status: "done" as const, evidenceRefs: ["evidence:legacy"] },
          ...otherSteps,
        ],
      },
    };
    const path = sessionReproStorePath(dir, ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 4, repro: stored }), "utf8");
    const restored = await readSessionRepro(dir, ctx);
    assert.equal(restored?.plan.steps[0]?.status, "pending");
    assert.deepEqual(restored?.plan.steps[0]?.evidenceRefs, ["evidence:legacy"]);
    assert.equal(restored?.plan.steps[0]?.verification, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro plan, step, and settle enforce the typed protocol and bounded continuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-v4-tool-protocol-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, {
      action: "start",
      objective: "Reproduce target logits",
    });

    const planned = await executeSparkTool(tools, "repro", ctx, {
      action: "plan",
      reason: "Freeze a precise evidence contract",
      difficulty: 10,
      goalContract: {
        objective: "Reproduce target logits for 20 steps",
        constraints: ["Use official weights"],
        nonGoals: ["Performance tuning"],
        successCriteria: ["20-step outputs are bitwise equal"],
        evidenceRequired: ["Captured command output"],
      },
    });
    assert.match(toolText(planned), /Goal Contract: draft/u);
    assert.equal(
      (await readSessionRepro(dir, ctx))?.goalContract.objective,
      "Reproduce target logits for 20 steps",
    );
    assert.equal((await readSessionRepro(dir, ctx))?.plan.difficulty, 10);

    const reproBeforeStep = await readSessionRepro(dir, ctx);
    const contractStep = reproBeforeStep?.plan.steps.find(
      (step) => step.id === "freeze-source-model-weight-data-contract",
    );
    if (!reproBeforeStep || !contractStep) throw new Error("missing seeded repro contract step");
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Reviewed reproduction contract",
      format: "json",
      body: {
        schema: "spark.repro.step-proof/v1",
        planRevision: reproStepPlanRevision(reproBeforeStep, contractStep.id),
        stepId: contractStep.id,
        definitionDigest: stepDefinitionDigest(contractStep),
        proofKind: "evidence",
        doneWhen: contractStep.doneWhen,
        passed: true,
      },
      provenance: { producer: "spark" },
    });
    const stepped = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId: "freeze-source-model-weight-data-contract",
      stepStatus: "done",
      stepEvidenceRefs: [evidence.ref],
    });
    assert.match(toolText(stepped), /updated to done/u);

    const forgedEvidence = await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Unbound proof",
      format: "text",
      body: "ordinary evidence is not a StepVerifier proof",
      provenance: { producer: "spark" },
    });
    const unbound = await executeSparkTool(tools, "repro", ctx, {
      action: "step",
      stepId: "competitor-baseline-availability-researched",
      stepStatus: "done",
      stepEvidenceRefs: [forgedEvidence.ref],
    });
    assert.equal(unbound.isError, true);
    assert.match(toolText(unbound), /StepVerifier|step-proof/u);

    const scheduled: Array<{ delayMs?: number; prompt?: string; reason?: string }> = [];
    const stopped: Array<{ reason?: string } | undefined> = [];
    const loop: SparkHostLoopContext = {
      loopId: "repro-driver",
      binding: { reproId: "repro-driver" },
      generation: 1,
      ownerSessionId: ctx.sessionId,
      stateOwnerSessionId: ctx.sessionId,
      async schedule(input) {
        scheduled.push(input);
        return input;
      },
      async stop(input) {
        stopped.push(input);
        return input;
      },
    };
    (ctx as TestSparkContext & { loop: SparkHostLoopContext }).loop = loop;

    for (let index = 0; index < 3; index += 1) {
      const settled = await executeSparkTool(tools, "repro", ctx, {
        action: "settle",
        reason: `settlement ${index + 1}`,
      });
      assert.match(toolText(settled), /next tick scheduled/u);
    }
    const recover = await executeSparkTool(tools, "repro", ctx, {
      action: "settle",
      reason: "settlement 4",
    });
    assert.match(toolText(recover), /Recover Ask required/u);
    assert.equal(scheduled.length, 3);
    assert.equal(scheduled[0]?.delayMs, 30_000);
    assert.deepEqual(stopped, []);
    assert.equal((await readSessionRepro(dir, ctx))?.stopGuard.decision, "ask");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("foreground driver slash commands share status, stop, and restart grammar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-foreground-command-grammar-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    const loopCommand = run.commands.get("loop");
    assert.ok(goalCommand, "missing /goal command");
    assert.ok(loopCommand, "missing /loop command");

    await goalCommand.handler("Unify foreground goal grammar", ctx);
    assert.equal((await loadSessionGoal(dir, ctx))?.objective, "Unify foreground goal grammar");
    await goalCommand.handler("status", ctx);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark goal scheduled: Unify/);
    await goalCommand.handler("restart Replace foreground goal grammar", ctx);
    assert.equal((await loadSessionGoal(dir, ctx))?.objective, "Replace foreground goal grammar");
    await goalCommand.handler("stop", ctx);
    assert.equal(await loadSessionGoal(dir, ctx), undefined);
    assert.deepEqual(ctx.sparkActiveMode, { mode: "plan" });

    await loopCommand.handler("Unify foreground loop grammar", ctx);
    assert.equal((await loadSessionLoop(dir, ctx))?.objective, "Unify foreground loop grammar");
    assert.equal(activeTestLoop(run, "loop")?.continuity, "session");
    await loopCommand.handler("status", ctx);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark loop scheduled: Unify/);
    await loopCommand.handler("fresh Isolate every loop tick", ctx);
    assert.equal((await loadSessionLoop(dir, ctx))?.objective, "Isolate every loop tick");
    assert.equal(activeTestLoop(run, "loop")?.continuity, "fresh");
    await loopCommand.handler("start --fresh Isolate the explicit start form", ctx);
    assert.equal((await loadSessionLoop(dir, ctx))?.objective, "Isolate the explicit start form");
    assert.equal(activeTestLoop(run, "loop")?.continuity, "fresh");
    await loopCommand.handler("restart Replace foreground loop grammar", ctx);
    assert.equal((await loadSessionLoop(dir, ctx))?.objective, "Replace foreground loop grammar");
    await loopCommand.handler("stop", ctx);
    assert.equal(await loadSessionLoop(dir, ctx), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("impl_plan_tasks describes the public spark-tasks readiness contract", () => {
  const { tools } = registerSparkToolsForTest();
  const planTool = tools.get("impl_plan_tasks");
  assert.ok(planTool);
  assert.match(planTool.description, /Readiness rules:/);
  assert.ok(planTool.description.includes(renderTaskPlanReadinessRules()));
  assert.match(planTool.description, /dependsOn resolution is active-project scoped/);
});

test("impl_list_projects returns compact text with structured project details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-list-projects-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [activeProject] = graph.projects();
    assert.ok(activeProject);
    const doneProject = graph.createProject({
      title: "Finished project",
      description: "Project with only finished work.",
    });
    graph.createTask({
      projectRef: activeProject.ref,
      name: "active-work",
      title: "Active work",
      description: "Active work item.",
      status: "pending",
    });
    graph.createTask({
      projectRef: activeProject.ref,
      name: "finished-work",
      title: "Finished work",
      description: "Finished work item.",
      status: "done",
    });
    graph.createTask({
      projectRef: activeProject.ref,
      name: "cancelled-work",
      title: "Cancelled work",
      description: "Cancelled work item.",
      status: "cancelled",
    });
    graph.createTask({
      projectRef: doneProject.ref,
      name: "done-project-work",
      title: "Done project work",
      description: "Done project work item.",
      status: "done",
    });
    await store.save(graph);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: activeProject.ref });

    const result = await executeSparkTool(tools, "impl_list_projects", ctx, {});
    assert.match(toolText(result), /Spark projects: 2/);
    assert.match(toolText(result), new RegExp(`\\* ${activeProject.ref}`));
    assert.doesNotMatch(toolText(result), /^\[/);
    const projects = (result.details?.projects ?? []) as Array<{
      ref: string;
      currentForSession: boolean;
      kind: string;
      kindDisplay: { kind: string; title: string; panels: unknown[] };
      taskCounts: { total: number; active: number; done: number; cancelled: number };
    }>;
    assert.deepEqual(
      projects.map((project) => project.ref),
      [activeProject.ref, doneProject.ref],
    );
    assert.equal(projects[0]?.currentForSession, true);
    assert.equal(projects[1]?.currentForSession, false);
    assert.equal(projects[0]?.kind, "generic");
    assert.deepEqual(projects[0]?.kindDisplay, { kind: "generic", title: "generic", panels: [] });
    assert.deepEqual(projects[0]?.taskCounts, { total: 3, active: 1, done: 1, cancelled: 1 });
    assert.deepEqual(projects[1]?.taskCounts, { total: 1, active: 0, done: 1, cancelled: 0 });
    assert.equal(Object.hasOwn(projects[0] ?? {}, "status"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("structured status and list facades default to compact text summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-compact-status-surfaces-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const projectUse = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      title: "Compact summary project",
      description: "Project used to validate compact tool summaries.",
    });
    assertToolTextIsCompactSummary(projectUse);
    assert.match(toolText(projectUse), /(?:Created new|Using) Spark project/);
    assert.ok(projectUse.details);

    const projectStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
      view: "active",
      format: "text",
      limit: 5,
    });
    assertToolTextIsCompactSummary(projectStatus);
    assert.match(toolText(projectStatus), /Spark project status/);
    assert.ok(projectStatus.details);

    const loopStatus = await executeSparkTool(tools, "loop", ctx, { action: "status" });
    assertToolTextIsCompactSummary(loopStatus);
    assert.match(toolText(loopStatus), /No active Spark loop|Spark loop/);
    assert.ok(loopStatus.details);

    const modeStatus = await executeSparkTool(tools, "mode", ctx, { action: "status" });
    assertToolTextIsCompactSummary(modeStatus);
    assert.match(toolText(modeStatus), /Current mode:/);
    assert.ok(modeStatus.details);

    const runStatusList = await executeSparkTool(tools, "task_read", ctx, {
      action: "run_status",
      runAction: "list",
      limit: 5,
    });
    assertToolTextIsCompactSummary(runStatusList);
    assert.match(
      toolText(runStatusList),
      /workflow run|No Spark workflow runs|Spark workflow runs/i,
    );
    assert.ok(runStatusList.details);

    const roleList = await executeSparkTool(tools, "role", ctx, { action: "list", limit: 5 });
    assertToolTextIsCompactSummary(roleList);
    assert.match(toolText(roleList), /\[builtin\]/);
    assert.ok(roleList.details);

    const workflowList = await executeSparkTool(tools, "workflow", ctx, {
      action: "list",
      limit: 5,
    });
    assertToolTextIsCompactSummary(workflowList);
    assert.match(toolText(workflowList), /Workflows:/);
    assert.ok(workflowList.details);

    const artifactList = await executeSparkTool(tools, "evidence", ctx, {
      action: "list",
      limit: 5,
      view: "summary",
    });
    assertToolTextIsCompactSummary(artifactList);
    assert.match(toolText(artifactList), /Evidence ledger:/);
    assert.ok(artifactList.details);

    const learningList = await executeSparkTool(tools, "memory", ctx, {
      kind: "learning",
      action: "list",
      limit: 5,
    });
    assertToolTextIsCompactSummary(learningList);
    assert.match(toolText(learningList), /Spark learnings:/);
    assert.ok(learningList.details);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project kind fields are preserved in metadata but no longer validated against registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-project-kind-tools-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const legacyProject = graph.createProject({
      title: "Legacy kind project",
      description: "Created before Spark kind validation.",
      kind: "legacy-import",
    });
    await store.save(graph);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const created = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      title: "Kinded generic project",
      description: "Created with explicit generic kind.",
      kind: "generic",
      kindState: { target: "generic" },
    });
    assert.equal((created.details as { project?: { kind?: string } }).project?.kind, "generic");
    assert.deepEqual(
      (created.details as { project?: { kindState?: unknown } }).project?.kindState,
      { target: "generic" },
    );

    // Unknown kinds are no longer rejected — requireKnownSparkProjectKind is a no-op
    const unknownKind = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      title: "Unknown kind project",
      description: "Should no longer fail kind validation.",
      kind: "unknown-kind",
    });
    assert.equal(
      (unknownKind.details as { project?: { kind?: string } }).project?.kind,
      "unknown-kind",
    );

    await executeSparkTool(tools, "impl_use_project", ctx, { project: legacyProject.ref });
    const metadata = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_metadata_update",
      kind: "generic",
      kindState: { migrated: true },
    });
    const metadataDetails = metadata.details as {
      changedFields?: string[];
      project?: { kind?: string; kindState?: unknown };
    };
    assert.deepEqual(metadataDetails.changedFields, ["kind", "kindState"]);
    assert.equal(metadataDetails.project?.kind, "generic");
    assert.deepEqual(metadataDetails.project?.kindState, { migrated: true });

    // Unknown kinds in metadata_update are also no longer rejected
    const unknownMetadata = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_metadata_update",
      kind: "unknown-kind",
    });
    assert.equal(
      (unknownMetadata.details as { project?: { kind?: string } }).project?.kind,
      "unknown-kind",
    );

    const status = await executeSparkTool(tools, "impl_status", ctx, {
      scope: "project",
      format: "json",
    });
    const details = status.details as {
      selectedProject?: { kind?: string; kindDisplay?: { kind?: string; panels?: unknown[] } };
    };
    assert.equal(details.selectedProject?.kind, "unknown-kind");
    // kindDisplay now always returns empty panels (no-op stub)
    assert.deepEqual(details.selectedProject?.kindDisplay, {
      kind: "unknown-kind",
      title: "unknown-kind",
      panels: [],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark_goal complete no longer blocks on reproduction project kind gate (deprecated)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reproduction-gate-complete-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalled = false;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(): Promise<ReviewerRunResult> {
          reviewerCalled = true;
          return {
            record: {
              runRef: "run:test-repro-gate",
              roleRef: "role:reviewer",
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
            verdict: {
              targetKind: "goal",
              goalId: "test",
              achieved: true,
              evidenceValid: true,
              objectiveSatisfied: true,
              outcome: "approved",
              confidence: "high",
              summary: "All done.",
              remainingWork: "",
              blockers: [],
            },
          } as unknown as ReviewerRunResult;
        },
      },
    });
    await useOnlySparkProject(tools, ctx);
    await executeSparkTool(tools, "task_write", ctx, {
      action: "project_metadata_update",
      kind: "reproduction",
      kindState: {
        target: { successMetrics: [{ id: "metric-a" }] },
        experiments: [{ status: "failed" }],
        findings: [],
      },
    });
    await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Finish reproduction project",
    });

    const result = await executeSparkTool(tools, "goal", ctx, { action: "complete" });

    // With project.kind gate removed, completion now reaches the reviewer
    // (may still be blocked by unfinished tasks, but NOT by kind gate)
    const details = result.details as { outcome?: string };
    // Reviewer was called (gate no longer blocks)
    assert.ok(reviewerCalled || details.outcome === "blocked");
    if (details.outcome === "blocked") {
      // If blocked, it should be due to unfinished tasks, not kind gate
      assert.doesNotMatch(toolText(result), /project kind gate/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("impl_status does not activate an arbitrary project for the Pi session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-no-auto-project-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "status-no-auto");
    const { tools } = registerSparkToolsForTest();

    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const statusText = toolText(status);

    assert.doesNotMatch(statusText, /\[current\]/);
    assert.match(statusText, /Spark available: no project selected/);
    assert.doesNotMatch(statusText, /Project Tool persistence/);
    const summary = await executeSparkTool(tools, "impl_status", ctx, { view: "summary" });
    assert.match(toolText(summary), /Tool persistence/);
    const statusDetails = status.details as { activeProjectRef?: string } | undefined;
    assert.equal(statusDetails?.activeProjectRef, undefined);
    await assert.rejects(() => readFile(currentProjectStatePath(dir, ctx), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_status surfaces corrupt current project state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-corrupt-sessions-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "status-corrupt-sessions");
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });
    await writeFile(currentProjectStatePath(dir, ctx), "{not-json", "utf8");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_status", ctx, {}),
      (error) =>
        error instanceof JsonStoreFormatError &&
        /not valid JSON/.test(error.message) &&
        /sessions/.test(error.filePath),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_status rejects non-object current project state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-non-object-sessions-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "status-non-object-sessions");
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });
    await writeFile(currentProjectStatePath(dir, ctx), "[]\n", "utf8");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_status", ctx, {}),
      (error) =>
        error instanceof JsonStoreFormatError &&
        /JSON root must be an object/.test(error.message) &&
        /sessions/.test(error.filePath),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session cache stores write JSON atomically without tmp leftovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-cache-atomic-"));
  try {
    const ctx = testSparkContext(dir, "cache-atomic");
    await saveCurrentProjectRef(dir, ctx, newRef("proj", "cache-atomic-project"));
    await saveIndependentTodos(dir, ctx, [
      { id: "todo-one", content: "One", status: "in_progress" },
    ]);
    const displayNumbers = await loadTodoDisplayNumberState(dir, ctx);
    assert.equal(assignTodoDisplayNumber(displayNumbers, "todo:one"), 1);
    await saveTodoDisplayNumberState(dir, ctx, displayNumbers);

    assert.deepEqual(
      (await readdir(join(dir, ".spark", "sessions"))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
    assert.deepEqual(
      (await readdir(join(dir, ".spark", "todos"))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
    assert.deepEqual(
      (await readdir(sessionDirectoryPath(dir, ctx))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("current project store ignores legacy mode and run control blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-sessions-invalid-"));
  try {
    const ctx = testSparkContext(dir, "sessions-invalid");
    const stateFile = currentProjectStatePath(dir, ctx);
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });

    await writeFile(stateFile, `${JSON.stringify({ projectRef: "proj:legacy" })}\n`, "utf8");
    assert.deepEqual(await loadCurrentProjectState(dir, ctx), {
      version: 2,
      projectRef: "proj:legacy",
    });

    await writeFile(
      stateFile,
      `${JSON.stringify({ version: 2, projectRef: "proj:demo", mode: "plan" })}\n`,
      "utf8",
    );
    assert.deepEqual(await loadCurrentProjectState(dir, ctx), {
      version: 2,
      projectRef: "proj:demo",
      mode: "plan",
    });

    await writeFile(
      stateFile,
      `${JSON.stringify({ version: 3, projectRef: "proj:demo" })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadCurrentProjectState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === stateFile &&
        /version must be 2/.test(error.message),
    );

    await writeFile(stateFile, `${JSON.stringify({ version: 1, projectRef: 42 })}\n`, "utf8");
    await assert.rejects(
      () => loadCurrentProjectState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === stateFile &&
        /projectRef must be a string/.test(error.message),
    );

    await writeFile(
      stateFile,
      `${JSON.stringify({
        version: 1,
        projectRef: "proj:demo",
        planningMode: { version: 1, projectRef: "proj:demo", source: "direct" },
        executionMode: {
          version: 1,
          projectRef: "proj:demo",
          kind: "single_task",
          enteredAt: "2026-05-28T00:00:00.000Z",
        },
      })}\n`,
      "utf8",
    );
    assert.deepEqual(await loadCurrentProjectState(dir, ctx), {
      version: 2,
      projectRef: "proj:demo",
    });

    await writeFile(
      stateFile,
      `${JSON.stringify({
        version: 1,
        projectRef: "proj:demo",
        runMode: {
          version: 1,
          runRef: "run:demo",
          projectRef: "proj:demo",
          status: "waiting",
          enteredAt: "2026-05-28T00:00:00.000Z",
        },
      })}\n`,
      "utf8",
    );
    const runControlState = await loadCurrentProjectState(dir, ctx);
    assert.deepEqual(runControlState, { version: 2, projectRef: "proj:demo" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permanent projects remain visible as current selection without lifecycle reactivation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-permanent-project-current-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const doneProject = graph.createProject({
      title: "Completed workflow",
      description: "Should remain current for history visibility.",
    });
    graph.createProject({
      title: "Next workflow",
      description: "Should not become current automatically.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "impl_use_project", ctx, { project: doneProject.ref });
    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const statusDetails = status.details as { activeProjectRef?: string } | undefined;
    assert.equal(statusDetails?.activeProjectRef, doneProject.ref);
    assert.doesNotMatch(toolText(status), /Spark available: no project selected/);
    assert.doesNotMatch(toolText(status), /Next workflow \[current\]/);
    assert.match(toolText(status), /Completed workflow \[current\]/);
    assert.doesNotMatch(toolText(status), /\[done\]/);
    const summary = await executeSparkTool(tools, "impl_status", ctx, { view: "summary" });
    assert.match(toolText(summary), /Completed workflow \[current\]/);
    assert.doesNotMatch(toolText(summary), /\[done\]/);

    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, doneProject.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_status includes persisted Spark orchestrator status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultWorkflowRunStore(dir);
    const dagRun = await dagStore.startRun({
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 3,
      timeoutMs: 456,
    });
    await dagStore.finishRun(dagRun.ref, { scheduled: 2, completed: 1, timedOut: true });
    const staleRun = await dagStore.startRun({
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });

    const { tools } = registerSparkToolsForTest();
    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const text = toolText(status);

    assert.match(text, /Spark workflow runs: idle actionable=run:/);
    assert.match(text, /actionable=2/);
    assert.doesNotMatch(text, /stale=1/);
    assert.doesNotMatch(text, /timed_out=1/);
    assert.match(
      text,
      new RegExp(
        `Actionable workflow run: ${staleRun.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[stale\\]`,
      ),
    );
    assert.match(text, /Next steps \(stale\):/);
    assert.match(text, /stale: run task_read\(\{ action: "run_status"/);
    const workflowRunDetails = status.details as {
      workflowRunStatus?: {
        stale?: number;
        timedOut?: number;
        nextSteps?: Array<{ status: string; nextActions: string[] }>;
      };
    };
    assert.equal(workflowRunDetails.workflowRunStatus?.stale, 1);
    assert.equal(workflowRunDetails.workflowRunStatus?.timedOut, 1);
    assert.equal(workflowRunDetails.workflowRunStatus?.nextSteps?.[0]?.status, "stale");
    assert.match(
      workflowRunDetails.workflowRunStatus?.nextSteps?.[0]?.nextActions.join("\n") ?? "",
      /stale:/,
    );
    assert.deepEqual(
      workflowRunDetails.workflowRunStatus?.nextSteps?.map((step) => step.status),
      ["stale", "timed_out"],
    );
    assert.match(
      workflowRunDetails.workflowRunStatus?.nextSteps?.[1]?.nextActions.join("\n") ?? "",
      /timed_out: historical foreground timeout record/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_status reconciles DAG runs with current workspace active children only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-status-cwd-"));
  const otherDir = await mkdtemp(join(tmpdir(), "spark-tool-dag-status-other-cwd-"));
  let otherRunRef: RunRef | undefined;
  let otherRunPromise: Promise<unknown> | undefined;
  try {
    await writeEmptySparkProject(dir);
    await defaultProjectRoleModelSettingsStore(otherDir).save("implementation", "test/model");
    const ctx = testSparkContext(dir, "main");
    const otherGraph = new TaskGraph();
    const otherProject = otherGraph.createProject({
      title: "Other workspace",
      description: "Owns an unrelated active child process.",
    });
    const otherTask = otherGraph.createTask({
      projectRef: otherProject.ref,
      name: "other-child",
      title: "Other child",
      description: "Keep an unrelated role-run active in another workspace.",
      kind: "implement",
      roleRef: "role:builtin-worker" as RoleRef,
      status: "pending",
      plan: executionReadyPlan("Other child"),
    });
    otherRunPromise = runSparkTask({
      graph: otherGraph,
      taskRef: otherTask.ref,
      registry: new RoleRegistry(),
      cwd: otherDir,
      dryRun: false,
      timeoutMs: 10_000,
      roleExecutor: createTestRoleRunner({ waitForCancel: true, inputControl: false }),
      claim: { sessionId: "session:other-workspace" },
    }).catch((error: unknown) => error);
    await waitFor(() => {
      const active = listActiveSparkRoleRunProcesses().find((process) => process.cwd === otherDir);
      otherRunRef = active?.runRef;
      return Boolean(active);
    }, 5_000);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir),
      false,
    );

    const currentDagRun = await defaultWorkflowRunStore(dir).startRun({
      ownerSessionId: ctxSessionKey(ctx),
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const text = toolText(status);
    assert.match(
      text,
      new RegExp(
        `Actionable workflow run: ${currentDagRun.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[stale\\]`,
      ),
    );
    assert.doesNotMatch(text, new RegExp(`Active workflow run: ${currentDagRun.ref}`));
    const dagStatus = await defaultWorkflowRunStore(dir).status();
    assert.equal(dagStatus.running, 0);
    assert.equal(dagStatus.stale, 1);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.runRef === otherRunRef),
      true,
    );
  } finally {
    if (otherRunRef)
      await killActiveSparkRoleRunProcesses({
        runRef: otherRunRef,
        forceAfterMs: 0,
        waitMs: 1_000,
      });
    await otherRunPromise?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(otherDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("impl_workflow_runs kill_active only targets current workspace role-runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-run-kill-active-cwd-"));
  const otherDir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-run-kill-active-other-cwd-"));
  let otherRunRef: RunRef | undefined;
  let otherRunPromise: Promise<unknown> | undefined;
  try {
    await writeEmptySparkProject(dir);
    await defaultProjectRoleModelSettingsStore(otherDir).save("implementation", "test/model");
    const ctx = testSparkContext(dir, "main");
    const otherGraph = new TaskGraph();
    const otherProject = otherGraph.createProject({
      title: "Other workspace",
      description: "Owns an unrelated active child process.",
    });
    const otherTask = otherGraph.createTask({
      projectRef: otherProject.ref,
      name: "other-child",
      title: "Other child",
      description: "Keep an unrelated role-run active in another workspace.",
      kind: "implement",
      roleRef: "role:builtin-worker" as RoleRef,
      status: "pending",
      plan: executionReadyPlan("Other child"),
    });
    otherRunPromise = runSparkTask({
      graph: otherGraph,
      taskRef: otherTask.ref,
      registry: new RoleRegistry(),
      cwd: otherDir,
      dryRun: false,
      timeoutMs: 10_000,
      roleExecutor: createTestRoleRunner({ waitForCancel: true, inputControl: false }),
      claim: { sessionId: "session:other-workspace" },
    }).catch((error: unknown) => error);
    await waitFor(() => {
      const active = listActiveSparkRoleRunProcesses().find((process) => process.cwd === otherDir);
      otherRunRef = active?.runRef;
      return Boolean(active);
    }, 5_000);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir),
      false,
    );

    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "kill_active",
    });

    assert.match(toolText(result), /Stopped background child runs: 0/);
    assert.equal(((result.details as { killed?: unknown[] }).killed ?? []).length, 0);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.runRef === otherRunRef),
      true,
    );
  } finally {
    if (otherRunRef)
      await killActiveSparkRoleRunProcesses({
        runRef: otherRunRef,
        forceAfterMs: 0,
        waitMs: 1_000,
      });
    await otherRunPromise?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(otherDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("impl_status includes active dynamic workflow snapshot projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-status-dynamic-workflow-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const runRef = "run:abcdef12-status" as const;
    await store.startRun({
      runRef,
      source: { kind: "inline", label: "inline workflow" },
      script:
        "export const meta = { name: 'status live', description: 'status live workflow' }\nreturn 'ok'",
      meta: { name: "status live", description: "status live workflow" },
      options: {},
      now: "2026-06-23T00:00:00.000Z",
    });
    await store.appendEvent(runRef, {
      type: "stage_started",
      nodeId: "stage:Watch",
      parentId: "run",
      nodeKind: "stage",
      title: "Watch",
      stage: "Watch",
      timestamp: "2026-06-23T00:00:01.000Z",
    });
    const resultRun = await store.start({
      source: { kind: "inline", label: "completed inline workflow" },
      script:
        "export const meta = { name: 'status result', description: 'status result workflow' }\nreturn 'ok'",
      meta: { name: "status result", description: "status result workflow" },
      options: {},
      now: "2026-06-23T00:00:02.000Z",
    });
    await store.finish(resultRun.ref, {
      meta: { name: "status result", description: "status result workflow" },
      result: { report: "ready" },
      stages: [],
      phases: [],
      agentCount: 0,
      journal: [],
    });

    const status = await executeSparkTool(tools, "impl_status", ctx, { scope: "workspace" });
    const text = toolText(status);
    assert.match(text, /Dynamic workflow runs: running=1/);
    assert.match(text, /Dynamic workflow result inbox: 1 undelivered/);
    assert.ok(
      text.includes(`Result: ${resultRun.ref} [succeeded] status result · {"report":"ready"}`),
    );
    assert.match(
      text,
      new RegExp(`Active dynamic workflow: ${runRef} \\[running\\] status live nodes=0/2`),
    );
    const details = status.details as {
      dynamicWorkflowRuns?: {
        active?: Array<{ ref?: string; completedNodes?: number; totalNodes?: number }>;
        resultInbox?: Array<{ runRef?: string; status?: string; resultPreview?: string }>;
      };
    };
    assert.equal(details.dynamicWorkflowRuns?.active?.[0]?.ref, runRef);
    assert.equal(details.dynamicWorkflowRuns?.active?.[0]?.completedNodes, 0);
    assert.equal(details.dynamicWorkflowRuns?.active?.[0]?.totalNodes, 2);
    assert.equal(details.dynamicWorkflowRuns?.resultInbox?.[0]?.runRef, resultRun.ref);
    assert.equal(
      details.dynamicWorkflowRuns?.resultInbox?.[0]?.resultPreview,
      '{"report":"ready"}',
    );

    await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "ack",
      runRef: resultRun.ref,
    });
    const acknowledgedStatus = await executeSparkTool(tools, "impl_status", ctx, {
      scope: "workspace",
    });
    assert.doesNotMatch(toolText(acknowledgedStatus), /Dynamic workflow result inbox/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_workflow_runs renders and controls dynamic workflow_run records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dynamic-workflow-runs-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Dynamic workflows", description: "demo" });
    await defaultTaskGraphStore(dir).save(graph);
    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });
    const dynamicStore = defaultSparkDynamicWorkflowEventStore(dir);
    const script =
      "export const meta = { name: 'control', description: 'control workflow' }\nreturn 'ok'";
    const meta = { name: "control", description: "control workflow" };

    const failedRun = await dynamicStore.start({
      source: { kind: "inline", label: "failed control workflow" },
      script,
      meta,
      options: {},
    });
    await dynamicStore.recordJournal(failedRun.ref, {
      index: 0,
      hash: "failedabc123",
      result: "partial child output",
    });
    await dynamicStore.fail(failedRun.ref, new Error("agent boom"));

    const staleRun = await dynamicStore.start({
      source: { kind: "inline", label: "stale control workflow" },
      script,
      meta,
      options: {},
      now: "2000-01-01T00:00:00.000Z",
    });
    await dynamicStore.reconcileStale({ now: "2000-01-01T01:00:00.000Z", staleAfterMs: 1_000 });

    const completedRun = await dynamicStore.start({
      source: { kind: "inline", label: "completed control workflow" },
      script,
      meta,
      options: {},
    });
    const completedStages = [
      {
        title: "Synthesis",
        status: "success" as const,
        startedAt: "2026-06-22T00:00:00.000Z",
        finishedAt: "2026-06-22T00:00:02.000Z",
      },
    ];
    await dynamicStore.finish(completedRun.ref, {
      meta,
      result: { report: "delivered" },
      stages: completedStages,
      phases: completedStages,
      agentCount: 1,
      journal: [{ index: 0, hash: "doneabc12345", result: "compact child output" }],
    });

    const pausedRun = await dynamicStore.start({
      source: { kind: "inline", label: "paused control workflow" },
      script,
      meta,
      options: {},
    });
    await dynamicStore.pause(pausedRun.ref);

    const run = await dynamicStore.start({
      source: { kind: "inline", label: "running control workflow" },
      script,
      meta,
      options: { concurrency: 2 },
      base: {
        baseRef: "graft:test",
        baseState: "state:test",
        baseTree: "tree:test",
        capturedAt: "2026-06-22T00:00:00.000Z",
      },
    });
    await dynamicStore.recordPhase(run.ref, {
      title: "Plan",
      status: "success",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:00:01.000Z",
    });
    await dynamicStore.recordJournal(run.ref, { index: 0, hash: "abc123def456", result: "ok" });

    const status = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "status",
      includeHistory: true,
    });
    const statusText = toolText(status);
    assert.match(
      statusText,
      /Dynamic workflow runs: runs=5 running=1 paused=1 failed=1 stale=1 stopped=0 succeeded=1 acknowledged=0/,
    );
    assert.match(statusText, /running control workflow/);
    assert.match(statusText, /failed control workflow/);
    assert.match(statusText, /stale control workflow/);
    assert.match(statusText, /paused control workflow/);
    assert.match(statusText, /completed control workflow/);
    assert.match(statusText, /Spark dynamic workflow dashboard \(status\)/);
    assert.match(statusText, /Tree:/);
    assert.match(statusText, /Event tail:/);
    assert.doesNotMatch(statusText, /Agent journal tail/);
    const statusDetails = status.details as {
      dynamicWorkflowRuns?: {
        dashboard?: {
          runs?: Array<{
            ref?: string;
            controls?: string[];
            tree?: unknown[];
            eventTail?: unknown[];
          }>;
        };
      };
    };
    const dashboardRun = statusDetails.dynamicWorkflowRuns?.dashboard?.runs?.find(
      (candidate) => candidate.ref === run.ref,
    );
    assert.ok(dashboardRun, "expected dynamic workflow dashboard view-model for running run");
    assert.deepEqual(dashboardRun.controls, ["inspect", "pause", "stop", "save"]);
    assert.ok((dashboardRun.tree?.length ?? 0) > 0);
    assert.ok((dashboardRun.eventTail?.length ?? 0) > 0);

    const inspectedRun = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef: run.ref,
    });
    const inspectedRunText = toolText(inspectedRun);
    assert.match(inspectedRunText, /Plan: success/);
    assert.match(inspectedRunText, /Timeline: ✓ Plan/);
    assert.match(inspectedRunText, /Controls: inspect runRef=.* · pause · stop/);
    assert.match(inspectedRunText, /Base: ref=graft:test state=state:test tree=tree:test/);
    assert.match(inspectedRunText, /result=ok/);

    const inspectedFailedRun = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef: failedRun.ref,
    });
    assert.match(toolText(inspectedFailedRun), /Error: agent boom/);

    const inspectedCompletedRun = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef: completedRun.ref,
    });
    assert.match(toolText(inspectedCompletedRun), /Controls: inspect runRef=.* · save · ack/);
    assert.match(toolText(inspectedCompletedRun), /Result: \{"report":"delivered"\}/);
    assert.match(toolText(inspectedCompletedRun), /result=compact child output/);

    const paused = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "pause",
      runRef: run.ref,
    });
    assert.match(toolText(paused), new RegExp(`Dynamic workflow pause: ${run.ref} -> paused`));
    assert.equal((await dynamicStore.get(run.ref))?.status, "paused");

    const resumed = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "resume",
      runRef: run.ref,
    });
    assert.match(toolText(resumed), new RegExp(`Dynamic workflow resume: ${run.ref} -> running`));
    assert.equal((await dynamicStore.get(run.ref))?.status, "running");

    const stopped = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "stop",
      runRef: run.ref,
    });
    assert.match(toolText(stopped), new RegExp(`Dynamic workflow stop: ${run.ref} -> stopped`));
    assert.equal((await dynamicStore.get(run.ref))?.status, "stopped");

    const restarted = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "restart",
      runRef: run.ref,
    });
    assert.match(toolText(restarted), /resume the managed WorkflowRun/u);
    const restartedRecord = await dynamicStore.get(run.ref);
    assert.equal(restartedRecord?.status, "running");
    assert.equal(restartedRecord?.journal.length, 0);
    assert.equal(restartedRecord?.phases.length, 0);

    const failedRestart = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "restart",
      runRef: failedRun.ref,
    });
    assert.match(
      toolText(failedRestart),
      new RegExp(`Dynamic workflow restart: ${failedRun.ref} -> running`),
    );
    assert.equal((await dynamicStore.get(failedRun.ref))?.status, "running");

    const staleResume = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "resume",
      runRef: staleRun.ref,
    });
    assert.match(
      toolText(staleResume),
      new RegExp(`Dynamic workflow resume: ${staleRun.ref} -> running`),
    );
    assert.equal((await dynamicStore.get(staleRun.ref))?.status, "running");

    const saved = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "save",
      runRef: completedRun.ref,
      workflowId: "completed-control",
    });
    assert.match(toolText(saved), /Dynamic workflow save:/);
    assert.match(toolText(saved), /workspace:completed-control/);
    assert.equal(
      existsSync(join(dir, ".agents", "workflows", "completed-control", "WORKFLOW.md")),
      true,
    );
    assert.equal(
      (await dynamicStore.get(completedRun.ref))?.savedWorkflow?.selector,
      "workspace:completed-control",
    );

    const acknowledged = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "ack",
      runRef: completedRun.ref,
    });
    assert.match(toolText(acknowledged), /Dynamic workflow ack: acknowledged=1/);
    assert.ok((await dynamicStore.get(completedRun.ref))?.acknowledgedAt);

    const compactStatus = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "status",
    });
    assert.doesNotMatch(toolText(compactStatus), new RegExp(completedRun.ref));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflow run slash commands expose direct dashboard controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-run-slash-controls-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { commands } = registerSparkToolsForTest();
    const dynamicStore = defaultSparkDynamicWorkflowEventStore(dir);
    const script =
      "export const meta = { name: 'slash control', description: 'slash command workflow controls' }\nreturn 'ok'";
    const run = await dynamicStore.start({
      source: { kind: "inline", label: "slash control workflow" },
      script,
      meta: { name: "slash control", description: "slash command workflow controls" },
      options: {},
    });

    const publishedViews: unknown[] = [];
    (ctx.ui as typeof ctx.ui & { publishView: (event: unknown) => void }).publishView = (event) => {
      publishedViews.push(event);
    };

    const workflow = commands.get("workflow");
    const dashboard = commands.get("workflow-runs");
    const inspect = commands.get("workflow-inspect");
    const pause = commands.get("workflow-pause");
    const resume = commands.get("workflow-resume");
    const stop = commands.get("workflow-stop");
    const restart = commands.get("workflow-restart");
    const save = commands.get("workflow-save");
    assert.ok(workflow, "missing /workflow");
    assert.ok(dashboard, "missing /workflow-runs");
    assert.ok(inspect, "missing /workflow-inspect");
    assert.ok(pause, "missing /workflow-pause");
    assert.ok(resume, "missing /workflow-resume");
    assert.ok(stop, "missing /workflow-stop");
    assert.ok(restart, "missing /workflow-restart");
    assert.ok(save, "missing /workflow-save");

    await workflow.handler(`runs ${run.ref}`, ctx);
    assert.match(JSON.stringify(publishedViews), new RegExp(run.ref));
    assert.match(JSON.stringify(publishedViews), /"dynamicStatus":"running"/);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark dynamic workflow dashboard/);
    assert.match(ctx.notifications.at(-1)?.message ?? "", new RegExp(run.ref));
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Actions: inspect, pause, stop, save/);

    await workflow.handler(`inspect ${run.ref}`, ctx);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Selected: run:/);

    await workflow.handler(`pause ${run.ref}`, ctx);
    assert.equal((await dynamicStore.get(run.ref))?.status, "paused");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Control: pause .* -> paused/);

    await resume.handler(run.ref, ctx);
    assert.equal((await dynamicStore.get(run.ref))?.status, "running");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Control: resume .* -> running/);

    await workflow.handler(`stop ${run.ref}`, ctx);
    assert.equal((await dynamicStore.get(run.ref))?.status, "stopped");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Control: stop .* -> stopped/);

    await restart.handler(run.ref, ctx);
    assert.equal((await dynamicStore.get(run.ref))?.status, "running");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Control: restart .* -> running/);

    await workflow.handler(`save ${run.ref}`, ctx);
    assert.match(
      ctx.notifications.at(-1)?.message ?? "",
      /Control: save .* -> workspace:slash-control/,
    );
    assert.match(
      (await dynamicStore.get(run.ref))?.savedWorkflow?.selector ?? "",
      /^workspace:slash-control/u,
    );

    await dashboard.handler(run.ref, ctx);
    await inspect.handler(run.ref, ctx);
    assert.match(JSON.stringify(publishedViews), new RegExp(run.ref));
    await assert.rejects(async () => pause.handler("", ctx), /\/workflow-pause requires a runRef/);
    await assert.rejects(
      async () => workflow.handler("pause", ctx),
      /\/workflow pause requires a runRef/,
    );
    await assert.rejects(
      async () => workflow.handler("runs task:not-a-run", ctx),
      /\/workflow runs requires a runRef/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_workflow_runs rejects invalid explicit control parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-runs-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_workflow_runs", ctx, { action: "acknowledge" }),
      /task_read run_status action must be status, list, inspect, pause, resume, stop, restart, save, kill, reply, steer, reconcile, ack, prune, clear_inactive, or kill_active/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_workflow_runs", ctx, { action: "ack", runRef: "task:one" }),
      /task_read run_status runRef must be a run ref/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "impl_workflow_runs", ctx, { action: "prune", dryRun: "true" }),
      /task_read run_status dryRun must be a boolean/,
    );

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_workflow_runs", ctx, {
          action: "prune",
          keepRecent: 1.5,
        }),
      /task_read run_status keepRecent must be a non-negative integer/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_workflow_runs reply and steer require one active visible role-run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-runs-reply-no-active-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update((graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      const task = graph.createTask({
        projectRef: project.ref,
        name: "waiting-role",
        title: "Waiting role",
        description: "Pretend a role is waiting but has no active process.",
        kind: "implement",
        status: "running",
        roleRef: "role:builtin-worker" as RoleRef,
        plan: executionReadyPlan("Waiting role"),
      });
      graph.recordRun({
        ref: "run:waiting-role" as RunRef,
        projectRef: project.ref,
        taskRef: task.ref,
        roleRef: "role:builtin-worker" as RoleRef,
        runName: "worker-waiting",
        ownerSessionId: "session:parent",
        status: "running",
        startedAt: new Date().toISOString(),
        outputEvidenceRefs: [],
      });
    });
    const { tools } = registerSparkToolsForTest();

    const reply = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reply",
      taskRef: "waiting-role",
      message: "continue",
    });
    assert.match(toolText(reply), /control_requires_active_target/);
    assert.match(toolText(reply), /No active background role-run process matched/);
    const details = reply.details as { background?: { error?: string; childRuns?: unknown[] } };
    assert.equal(details.background?.error, "control_requires_active_target");
    assert.equal(details.background?.childRuns?.length, 1);

    const steer = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "steer",
      message: "focus on tests",
    });
    assert.match(toolText(steer), /control_requires_active_target/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_workflow_runs reconciles and clears inactive records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-runs-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultWorkflowRunStore(dir);
    const finished = await dagStore.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await dagStore.finishRun(finished.ref, { scheduled: 0, completed: 0, timedOut: false });
    await dagStore.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });

    const { tools } = registerSparkToolsForTest();
    const reconciled = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reconcile",
    });
    assert.match(toolText(reconciled), /Reconciled workflow records changed: 1/);
    assert.match(toolText(reconciled), /Background work: stale/);
    assert.match(toolText(reconciled), /Next: reconcile with task runs and active processes/);
    const reconciledDetails = reconciled.details as {
      background?: {
        summary?: { state?: string };
        runs?: Array<{ status?: string; nextActions?: string[] }>;
      };
    };
    assert.equal(reconciledDetails.background?.summary?.state, "stale");
    assert.match(
      reconciledDetails.background?.runs?.[0]?.nextActions?.join("\n") ?? "",
      /reconcile with task runs and active processes/,
    );

    const acknowledged = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "ack",
    });
    assert.match(toolText(acknowledged), /Acknowledged background problem runs: 1 newly/);
    assert.doesNotMatch(toolText(acknowledged), /Next: reconcile with task runs/);
    const acknowledgedDetails = acknowledged.details as {
      background?: {
        acknowledged?: { acknowledged?: string[] };
        runs?: Array<{ acknowledgedBySession?: string }>;
      };
    };
    assert.equal(acknowledgedDetails.background?.acknowledged?.acknowledged?.length, 1);
    const ackSnapshot = await dagStore.load();
    assert.equal(
      ackSnapshot.runs.find((run) => run.acknowledgedBySession)?.acknowledgedBySession,
      ctxSessionKey(ctx),
    );

    const compactStatus = await executeSparkTool(tools, "impl_status", ctx, {});
    assert.doesNotMatch(toolText(compactStatus), /Spark workflow runs:/);
    assert.doesNotMatch(toolText(compactStatus), /stale=1/);

    const historicalRuns = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "list",
      includeHistory: true,
    });
    assert.match(toolText(historicalRuns), /Background work: idle/);
    assert.equal(
      (historicalRuns.details as { background?: { runs?: unknown[] } }).background?.runs?.length,
      2,
    );

    const cleared = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "clear_inactive",
    });
    assert.match(toolText(cleared), /Background work: idle/);
    assert.equal(
      (cleared.details as { background?: { runs?: unknown[] } }).background?.runs?.length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state workflow_run_prune defaults to dry-run and does not write workflow run store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-prune-dryrun-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultWorkflowRunStore(dir);
    const run = await dagStore.startRun({ dryRun: false, maxConcurrency: 1, timeoutMs: 100 });
    await dagStore.finishRun(run.ref, { scheduled: 0, completed: 0, timedOut: false });
    const before = await readFile(join(dir, ".spark", "workflow-runs.json"), "utf8");

    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_state", ctx, {
      action: "workflow_run_prune",
      olderThanDays: 0,
      keepRecent: 0,
      keepRecentPerProject: 0,
    });

    assert.match(toolText(result), /Spark workflow-run prune dry-run/);
    assert.match(toolText(result), /Candidates: 1; kept=0/);
    const prune = (result.details as { prune?: { dryRun?: boolean; candidates?: unknown[] } })
      .prune;
    assert.equal(prune?.dryRun, true);
    assert.equal(prune?.candidates?.length, 1);
    assert.equal(await readFile(join(dir, ".spark", "workflow-runs.json"), "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_workflow_runs reply records failed delivery without successful activity transition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-runs-reply-failed-delivery-"));
  const previousBindingHome = process.env.SPARK_HOME;
  let runPromise: Promise<unknown> | undefined;
  try {
    process.env.SPARK_HOME = dir;
    await writeEmptySparkProject(dir);
    await defaultProjectRoleModelSettingsStore(dir).save("implementation", "test/model");
    const ctx = testSparkContext(dir, "main");
    ctx.runRole = createTestRoleRunner({ waitForCancel: true, inputControl: false });
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "no-input-control-child",
      title: "No input-control child task",
      description: "Run a long-lived fake role-run without an input control channel.",
      kind: "implement",
      status: "pending",
      roleRef: "role:builtin-worker" as RoleRef,
      plan: executionReadyPlan("No input-control child task"),
    });
    await store.save(graph);
    ctx.inputValue = "test/model";

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    runPromise = runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      timeoutMs: 10_000,
      roleExecutor: ctx.runRole,
      claim: { sessionId: ctxSessionKey(ctx) },
    }).catch((error: unknown) => error);
    await waitFor(
      () => listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir),
      5_000,
    );
    const active = listActiveSparkRoleRunProcesses().find((process) => process.cwd === dir);
    assert.ok(active);
    assert.equal(active.inputControl, "none");
    const failedDeliveryMessage = "x".repeat(1024 * 1024);

    const replied = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reply",
      runRef: active.runRef,
      message: failedDeliveryMessage,
    });

    assert.match(
      toolText(replied),
      new RegExp(`Spark background role-run reply: not delivered to ${active.runRef}`),
    );
    assert.match(toolText(replied), /Control evidence: evidence:/);
    const details = replied.details as {
      controlEvidenceRef?: string;
      sent?: Array<{ delivered?: boolean; runRef?: string; inputControl?: string }>;
      background?: {
        roleRunRegistry?: {
          entries?: Array<{ runRef?: string; events?: Array<{ type?: string }> }>;
        };
      };
    };
    assert.match(details.controlEvidenceRef ?? "", /^evidence:/);
    assert.equal(details.sent?.[0]?.runRef, active.runRef);
    assert.equal(details.sent?.[0]?.delivered, false);
    assert.equal(details.sent?.[0]?.inputControl, "none");
    const controlEvidence = await defaultEvidenceStore(dir).get(
      details.controlEvidenceRef as EvidenceRef,
    );
    assert.equal(controlEvidence.provenance.runRef, active.runRef);
    const controlBody = controlEvidence.body as {
      sent?: Array<{
        delivered?: boolean;
        runRef?: string;
        inputControl?: string;
        errorMessage?: string;
      }>;
    };
    assert.equal(controlBody.sent?.[0]?.runRef, active.runRef);
    assert.equal(controlBody.sent?.[0]?.delivered, false);
    assert.equal(controlBody.sent?.[0]?.inputControl, "none");
    if (controlBody.sent?.[0]?.errorMessage)
      assert.match(controlBody.sent[0].errorMessage, /EPIPE|input control channel/i);
    const entry = details.background?.roleRunRegistry?.entries?.find(
      (candidate) => candidate.runRef === active.runRef,
    );
    assert.deepEqual(
      (entry?.events ?? [])
        .filter((event) => event.type === "waiting_for_user" || event.type === "replied")
        .map((event) => event.type),
      [],
    );

    await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "kill",
      runRef: active.runRef,
      forceAfterMs: 0,
    });
    await waitFor(
      () => !listActiveSparkRoleRunProcesses().some((process) => process.runRef === active.runRef),
      5_000,
    );
    await runPromise;
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await waitFor(
      () => !listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir),
      5_000,
    ).catch(() => undefined);
    await runPromise?.catch(() => undefined);
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("impl_workflow_runs reply delivers through native role-run input control", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-runs-reply-native-delivery-"));
  const previousBindingHome = process.env.SPARK_HOME;
  let runPromise: Promise<unknown> | undefined;
  try {
    process.env.SPARK_HOME = dir;
    await writeEmptySparkProject(dir);
    await defaultProjectRoleModelSettingsStore(dir).save("implementation", "test/model");
    const ctx = testSparkContext(dir, "main");
    ctx.runRole = createTestRoleRunner({ waitForCancel: true });
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "native-input-child",
      title: "Native input-control child task",
      description: "Run a long-lived daemon-native role-run with an input control channel.",
      kind: "implement",
      status: "pending",
      roleRef: "role:builtin-worker" as RoleRef,
      plan: executionReadyPlan("Native input-control child task"),
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    runPromise = runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      timeoutMs: 10_000,
      roleExecutor: ctx.runRole,
      claim: { sessionId: ctxSessionKey(ctx) },
    }).catch((error: unknown) => error);
    await waitFor(
      () =>
        listActiveSparkRoleRunProcesses().some(
          (process) => process.cwd === dir && process.inputControl === "native",
        ),
      5_000,
    );
    const active = listActiveSparkRoleRunProcesses().find((process) => process.cwd === dir);
    assert.ok(active);
    assert.equal(active.inputControl, "native");
    await store.update((current) => {
      current.mergeTaskProgressFrom(graph, [task.ref]);
    });

    const replied = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reply",
      runRef: active.runRef,
      message: "continue with native input",
    });

    assert.match(
      toolText(replied),
      new RegExp(`Spark background role-run reply: sent to ${active.runRef}`),
    );
    assert.match(toolText(replied), /Control evidence: evidence:/);
    const details = replied.details as {
      controlEvidenceRef?: string;
      sent?: Array<{ delivered?: boolean; runRef?: string; inputControl?: string }>;
      background?: {
        roleRunRegistry?: {
          entries?: Array<{
            runRef?: string;
            events?: Array<{ type?: string; message?: string; evidenceRefs?: string[] }>;
          }>;
        };
      };
    };
    assert.match(details.controlEvidenceRef ?? "", /^evidence:/);
    assert.equal(details.sent?.[0]?.runRef, active.runRef);
    assert.equal(details.sent?.[0]?.delivered, true);
    assert.equal(details.sent?.[0]?.inputControl, "native");
    const entry = details.background?.roleRunRegistry?.entries?.find(
      (candidate) => candidate.runRef === active.runRef,
    );
    assert.deepEqual(
      (entry?.events ?? [])
        .filter((event) => event.type === "waiting_for_user" || event.type === "replied")
        .map((event) => event.type),
      ["waiting_for_user", "replied"],
    );
    assert.deepEqual(
      (entry?.events ?? [])
        .filter((event) => event.type === "replied")
        .map((event) => event.message),
      ["continue with native input"],
    );
    assert.match(
      (entry?.events ?? [])
        .filter((event) => event.type === "replied")
        .flatMap((event) => event.evidenceRefs ?? [])
        .at(0) ?? "",
      /^evidence:/,
    );

    await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "kill",
      runRef: active.runRef,
      forceAfterMs: 0,
    });
    await waitFor(
      () => !listActiveSparkRoleRunProcesses().some((process) => process.runRef === active.runRef),
      5_000,
    );
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await runPromise?.catch(() => undefined);
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("impl_workflow_runs reports failed workflow run with stuck child as attention needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-background-failed-active-"));
  let runPromise: Promise<unknown> | undefined;
  try {
    await writeEmptySparkProject(dir);
    await defaultProjectRoleModelSettingsStore(dir).save("implementation", "test/model");
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "failed-stuck-child",
      title: "Failed stuck child",
      description: "Timeout child process that stays alive after runtime failure.",
      kind: "implement",
      roleRef: "role:builtin-worker" as RoleRef,
      status: "pending",
      plan: executionReadyPlan("Failed stuck child"),
    });
    runPromise = runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      timeoutMs: 10_000,
      roleExecutor: createTestRoleRunner({ waitForCancel: true, inputControl: false }),
      claim: { sessionId: ctxSessionKey(ctx) },
    }).catch((error: unknown) => error);
    await waitFor(() => listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir));
    const activeProcess = listActiveSparkRoleRunProcesses().find((process) => process.cwd === dir);
    assert.ok(activeProcess);

    const finishedAt = new Date().toISOString();
    const failedRun = {
      ref: activeProcess.runRef,
      projectRef: project.ref,
      taskRef: task.ref,
      roleRef: activeProcess.roleRef,
      runName: activeProcess.runName,
      ownerSessionId: ctxSessionKey(ctx),
      status: "failed" as const,
      failureKind: "runtime_error" as const,
      errorMessage: "role run failed while the child process was still active",
      startedAt: activeProcess.startedAt,
      finishedAt,
      outputEvidenceRefs: [],
      completionSummary: {
        runRef: activeProcess.runRef,
        taskRef: task.ref,
        roleRef: activeProcess.roleRef,
        runName: activeProcess.runName,
        status: "failed" as const,
        summary: "role run failed while the child process was still active",
        evidenceRefs: [],
        createdAt: finishedAt,
      },
    };
    graph.recordRun(failedRun);
    graph.setTaskStatus(task.ref, "failed");
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.runRef === activeProcess.runRef),
      true,
    );
    await store.save(graph);

    const dagRunStore = defaultWorkflowRunStore(dir);
    const dagRun = await dagRunStore.startRun({
      projectRef: project.ref,
      ownerSessionId: ctxSessionKey(ctx),
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 1_000,
    });
    await dagRunStore.recordSchedule(dagRun.ref, {
      taskRef: task.ref,
      runRef: activeProcess.runRef,
      scheduled: 1,
    });
    await dagRunStore.recordProgress(dagRun.ref, {
      taskRef: task.ref,
      run: failedRun,
      completed: 1,
    });
    await dagRunStore.finishRun(dagRun.ref, {
      scheduled: 1,
      completed: 1,
      timedOut: false,
      failed: 1,
      cancelled: 0,
      runs: [failedRun],
    });

    const { tools } = registerSparkToolsForTest();
    const status = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "status",
      projectRef: project.ref,
    });
    const statusText = toolText(status);
    assert.match(statusText, /Background work: needs attention/);
    assert.match(statusText, /Active children:/);
    assert.doesNotMatch(statusText, /Background work: running/);
    const background = (
      status.details as {
        background?: {
          summary?: { state?: string; activeChildren?: number; actionableProblems?: number };
          childRuns?: Array<{ runRef?: string; activeProcess?: boolean; status?: string }>;
        };
      }
    ).background;
    assert.equal(background?.summary?.state, "needs_attention");
    assert.equal(background?.summary?.activeChildren, 1);
    assert.equal(background?.summary?.actionableProblems, 1);
    assert.equal(
      background?.childRuns?.some(
        (child) =>
          child.runRef === activeProcess.runRef && child.activeProcess && child.status === "active",
      ),
      true,
    );
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await runPromise?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("impl_workflow_runs inspect/list use compact role-run summaries and tail refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-background-runs-role-summary-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const failedTask = graph.createTask({
      projectRef: project.ref,
      name: "compact-failed-role-run",
      title: "Compact failed role-run task",
      description: "Represents a failed role-run with compact summary evidence.",
      kind: "implement",
      status: "failed",
      plan: executionReadyPlan("Compact failed role-run task"),
    });
    const succeededTask = graph.createTask({
      projectRef: project.ref,
      name: "compact-succeeded-role-run",
      title: "Compact succeeded role-run task",
      description: "Represents a succeeded role-run with compact summary evidence.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Compact succeeded role-run task"),
    });
    const now = new Date().toISOString();
    const roleRef = "role:builtin-worker" as RoleRef;
    const failedRunRef = "run:compact-failed-role-run" as RunRef;
    const succeededRunRef = "run:compact-succeeded-role-run" as RunRef;
    const transcript = await defaultEvidenceStore(dir).put({
      kind: "trace",
      title: "Failed role-run transcript",
      format: "text",
      body: "transcript body is intentionally behind a ref",
      provenance: {
        producer: "task",
        projectRef: project.ref,
        taskRef: failedTask.ref,
        roleRef,
        runRef: failedRunRef,
      },
    });
    const failedArtifact = await defaultEvidenceStore(dir).put({
      kind: "trace",
      title: "Failed compact role-run result",
      format: "json",
      body: {
        schemaVersion: 1,
        runRef: failedRunRef,
        taskRef: failedTask.ref,
        roleRef,
        runName: "worker-compact-failed",
        status: "failed",
        startedAt: now,
        finishedAt: now,
        summary: "Failed compact summary: missing required evidence",
        transcriptRef: transcript.ref,
        record: {
          ref: failedRunRef,
          roleRef,
          runName: "worker-compact-failed",
          status: "failed",
          startedAt: now,
          finishedAt: now,
        },
        stdout: { bytes: 50_000, tail: "bounded stdout tail", tailBytes: 19, truncated: true },
        stderr: { bytes: 120, tail: "bounded stderr tail", tailBytes: 19, truncated: false },
        jsonEvents: { count: 42, tail: ['{"type":"error"}'], tailEventCount: 1, truncated: true },
      },
      provenance: {
        producer: "task",
        projectRef: project.ref,
        taskRef: failedTask.ref,
        roleRef,
        runRef: failedRunRef,
      },
    });
    const succeededArtifact = await defaultEvidenceStore(dir).put({
      kind: "trace",
      title: "Succeeded compact role-run result",
      format: "json",
      body: {
        schemaVersion: 1,
        runRef: succeededRunRef,
        taskRef: succeededTask.ref,
        roleRef,
        runName: "worker-compact-succeeded",
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
        summary: "Succeeded compact summary: docs updated",
        record: {
          ref: succeededRunRef,
          roleRef,
          runName: "worker-compact-succeeded",
          status: "succeeded",
          startedAt: now,
          finishedAt: now,
        },
        stdout: { bytes: 24, tail: "done", tailBytes: 4, truncated: false },
        stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
        jsonEvents: { count: 1, tail: ['{"type":"done"}'], tailEventCount: 1, truncated: false },
      },
      provenance: {
        producer: "task",
        projectRef: project.ref,
        taskRef: succeededTask.ref,
        roleRef,
        runRef: succeededRunRef,
      },
    });
    const failedRun = graph.recordRun({
      ref: failedRunRef,
      projectRef: project.ref,
      taskRef: failedTask.ref,
      roleRef,
      runName: "worker-compact-failed",
      status: "failed",
      errorMessage: "missing required evidence",
      startedAt: now,
      finishedAt: now,
      outputEvidenceRefs: [failedArtifact.ref],
      completionSummary: {
        runRef: failedRunRef,
        taskRef: failedTask.ref,
        roleRef,
        runName: "worker-compact-failed",
        status: "failed",
        summary: "Failed compact summary: missing required evidence",
        evidenceRefs: [failedArtifact.ref],
        createdAt: now,
      },
    });
    const succeededRun = graph.recordRun({
      ref: succeededRunRef,
      projectRef: project.ref,
      taskRef: succeededTask.ref,
      roleRef,
      runName: "worker-compact-succeeded",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      outputEvidenceRefs: [succeededArtifact.ref],
      completionSummary: {
        runRef: succeededRunRef,
        taskRef: succeededTask.ref,
        roleRef,
        runName: "worker-compact-succeeded",
        status: "succeeded",
        summary: "Succeeded compact summary: docs updated",
        evidenceRefs: [succeededArtifact.ref],
        createdAt: now,
      },
    });
    await store.save(graph);
    const dagStore = defaultWorkflowRunStore(dir);
    const dagRun = await dagStore.startRun({
      projectRef: project.ref,
      dryRun: false,
      maxConcurrency: 2,
      timeoutMs: 100,
    });
    await dagStore.recordSchedule(dagRun.ref, {
      taskRef: failedTask.ref,
      runRef: failedRunRef,
      scheduled: 1,
    });
    await dagStore.recordProgress(dagRun.ref, {
      taskRef: failedTask.ref,
      run: failedRun,
      completed: 1,
    });
    await dagStore.recordSchedule(dagRun.ref, {
      taskRef: succeededTask.ref,
      runRef: succeededRunRef,
      scheduled: 2,
    });
    await dagStore.recordProgress(dagRun.ref, {
      taskRef: succeededTask.ref,
      run: succeededRun,
      completed: 2,
    });
    await dagStore.finishRun(dagRun.ref, {
      scheduled: 2,
      completed: 2,
      timedOut: false,
      failed: 1,
      runs: [failedRun, succeededRun],
    });

    const inspect = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef: failedRunRef,
    });
    const inspectText = toolText(inspect);
    assert.match(inspectText, /Background child run: run:compact-failed-role-run failed/);
    assert.match(inspectText, /Summary: Failed compact summary: missing required evidence/);
    assert.match(inspectText, new RegExp(`Transcript: ${transcript.ref}`));
    assert.match(inspectText, /Stdout tail: 50000 bytes, showing last 19 bytes \(truncated\)/);
    const inspectDetails = inspect.details as {
      background?: {
        childRuns?: Array<{
          transcriptRef?: string;
          stdoutTail?: { tail?: string; truncated?: boolean };
          jsonEventsTail?: { count?: number; tailEventCount?: number };
        }>;
      };
    };
    assert.equal(inspectDetails.background?.childRuns?.[0]?.transcriptRef, transcript.ref);
    assert.equal(
      inspectDetails.background?.childRuns?.[0]?.stdoutTail?.tail,
      "bounded stdout tail",
    );
    assert.equal(inspectDetails.background?.childRuns?.[0]?.stdoutTail?.truncated, true);
    assert.equal(inspectDetails.background?.childRuns?.[0]?.jsonEventsTail?.count, 42);

    const list = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "list",
      includeHistory: true,
    });
    const listText = toolText(list);
    assert.match(listText, /Child runs:/);
    assert.match(listText, /run:compact-failed-role-run: failed .*Failed compact summary/);
    assert.match(listText, /run:compact-succeeded-role-run: succeeded .*Succeeded compact summary/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_workflow_runs inspect keeps legacy large role-run Evidence behind refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-background-runs-large-role-evidence-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "legacy-large-background-role-run",
      title: "Legacy large background role-run task",
      description: "Represents an old background role-run with a large Evidence body.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Legacy large background role-run task"),
    });
    const legacyBodyMarker = "BACKGROUND_LEGACY_ROLE_RUN_FULL_BODY_SENTINEL";
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "trace",
      title: "Legacy large background role-run Evidence",
      format: "text",
      body: legacyBodyMarker.repeat(4_000),
      provenance: { producer: "task", projectRef: project.ref, taskRef: task.ref },
    });
    const now = new Date().toISOString();
    const runRef = "run:legacy-large-background-role-run" as RunRef;
    const roleRef = "role:builtin-worker" as RoleRef;
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: task.ref,
      roleRef,
      runName: "worker-legacy-large-background",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      outputEvidenceRefs: [evidence.ref],
    });
    await store.save(graph);

    const inspect = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef,
    });
    const text = toolText(inspect);
    assert.match(text, /Background child run: run:legacy-large-background-role-run succeeded/);
    assert.match(text, new RegExp(evidence.ref));
    assert.match(text, /unsupported_role_run_body: evidence body not loaded/);
    assert.doesNotMatch(text, new RegExp(legacyBodyMarker));
    assert.doesNotMatch(JSON.stringify(inspect.details), new RegExp(legacyBodyMarker));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_workflow_runs reconciles, acks scoped problems, and renders historical timeouts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-background-runs-records-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const dagStore = defaultWorkflowRunStore(dir);
    const stale = await dagStore.startRun({
      projectRef: project.ref,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const legacy = await dagStore.startRun({
      projectRef: project.ref,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await dagStore.finishRun(legacy.ref, { scheduled: 1, completed: 0, timedOut: true });

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const reconciled = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reconcile",
    });
    assert.match(toolText(reconciled), /Reconciled workflow records changed: 1/);
    assert.doesNotMatch(toolText(reconciled), /Historical timeout record/);
    assert.doesNotMatch(toolText(reconciled), /Workflow run .*stale/);
    const reconcileDetails = reconciled.details as {
      background?: { runs?: Array<{ runRef: string; status: string; legacyTimedOut: boolean }> };
    };
    assert.equal(
      reconcileDetails.background?.runs?.some(
        (run) => run.runRef === stale.ref && run.status === "stale",
      ),
      true,
    );
    assert.equal(
      reconcileDetails.background?.runs?.some(
        (run) => run.runRef === legacy.ref && run.legacyTimedOut,
      ),
      true,
    );

    const acknowledged = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "ack",
    });
    assert.match(toolText(acknowledged), /Acknowledged background problem runs: 2 newly/);
    const ackDetails = acknowledged.details as {
      background?: { acknowledged?: { acknowledged?: string[] }; childRuns?: unknown[] };
    };
    assert.deepEqual(
      ackDetails.background?.acknowledged?.acknowledged?.sort(),
      [legacy.ref, stale.ref].sort(),
    );
    assert.equal(ackDetails.background?.childRuns?.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy /run commands are not registered", () => {
  const { commands } = registerSparkToolsForTest();
  assert.equal(commands.get("run"), undefined);
  assert.equal(commands.get("run-sequential"), undefined);
  assert.equal(commands.get("run-parallel"), undefined);
});

test("workflow-run manager preflights role models through the host catalog without pi", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-manager-model-catalog-"));
  const previousBindingHome = process.env.SPARK_HOME;
  try {
    process.env.SPARK_HOME = dir;
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.inputValue = "test/model";
    ctx.modelRegistry = {
      getAll: () => [{ provider: "test", id: "model" }],
      getAvailable: () => [{ provider: "test", id: "model" }],
    };
    ctx.runRole = createTestRoleRunner({
      stdout: `${JSON.stringify({ type: "done" })}\n`,
      jsonEvents: [{ type: "done" }],
    });
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "manager-configured-pi",
      title: "Manager configured Pi task",
      description: "Run scheduler preflight through the configured Pi command.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Manager configured Pi task"),
    });
    await store.save(graph);
    await saveCurrentProjectRef(dir, ctx, project.ref);
    await defaultWorkflowRunStore(dir).setControl({
      projectRef: project.ref,
      status: "running",
      policy: { maxConcurrency: 1, timeoutMs: 1_000 },
    });

    const manager = new SparkWorkflowRunManagerController({
      refreshSparkWidget: async () => undefined,
    });
    const result = await manager.runOnce(dir, ctx);

    assert.equal(result.continuePolling, false);
    const settingsFile = JSON.parse(
      await readFile(join(dir, "role-model-settings.json"), "utf8"),
    ) as { version: number; modelTypes: Record<string, string> };
    assert.equal(settingsFile.version, 2);
    assert.deepEqual(settingsFile.modelTypes, { implementation: "test/model" });
    const dagStatus = await defaultWorkflowRunStore(dir).status();
    assert.equal(dagStatus.succeeded, 1);
    assert.equal(dagStatus.lastRun?.projectRef, project.ref);
  } finally {
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("impl_status renders legacy large role-run Evidence by refs without loading its body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-status-large-role-run-evidence-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "legacy-large-role-run",
      title: "Legacy large role-run task",
      description: "Represents an old role-run with a large Evidence body.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Legacy large role-run task"),
    });
    const legacyBodyMarker = "LEGACY_ROLE_RUN_FULL_BODY_SENTINEL";
    const evidence = await defaultEvidenceStore(dir).put({
      kind: "trace",
      title: "Legacy large role-run Evidence",
      format: "text",
      body: legacyBodyMarker.repeat(3_000),
      provenance: { producer: "spark", projectRef: project.ref, taskRef: task.ref },
    });
    const now = new Date().toISOString();
    const runRef = "run:legacy-large-role-run" as RunRef;
    const roleRef = "role:builtin-worker" as RoleRef;
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: task.ref,
      roleRef,
      runName: "worker-legacy-large",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      outputEvidenceRefs: [evidence.ref],
      completionSummary: {
        runRef,
        taskRef: task.ref,
        roleRef,
        runName: "worker-legacy-large",
        status: "succeeded",
        summary: "Legacy compact summary only",
        evidenceRefs: [evidence.ref],
        createdAt: now,
      },
    });
    await store.save(graph);

    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const text = toolText(status);
    assert.match(text, /Recent role-run completions:/);
    assert.match(text, /Legacy compact summary only/);
    assert.match(text, new RegExp(evidence.ref));
    assert.doesNotMatch(text, new RegExp(legacyBodyMarker));
    assert.doesNotMatch(JSON.stringify(status.details), new RegExp(legacyBodyMarker));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("impl_status reports derived ready frontier for pending execution-ready tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-derived-ready-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "pending-derived-ready",
      title: "Pending derived ready task",
      description:
        "A pending task with an execution-ready plan should appear in the ready frontier.",
      kind: "research",
      status: "pending",
      plan: executionReadyPlan("A pending task with an execution-ready plan should appear ready."),
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
    });
    const details = status.details as {
      renderedProjects: Array<{
        current?: boolean;
        taskCounts?: { ready?: number; statusCounts?: Record<string, number> };
        tasks?: Array<{ name?: string; status?: string }>;
      }>;
      ready?: Array<{ name?: string }>;
    };
    const current = details.renderedProjects.find((projectDetail) => projectDetail.current);
    assert.equal(current?.taskCounts?.ready, 1);
    assert.equal(current?.taskCounts?.statusCounts?.pending, 1);
    assert.equal(current?.tasks?.[0]?.name, "pending-derived-ready");
    assert.equal(current?.tasks?.[0]?.status, "pending");

    const active = await executeSparkTool(tools, "task_read", ctx, { action: "project_status" });
    const activeText = toolText(active);
    assert.match(activeText, /ready_frontier=1/);
    assert.match(
      activeText,
      /\[pending\] @pending-derived-ready: Pending derived ready task .*ready_frontier=yes/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task status projects managed Session Goal and TaskRun evidence bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-task-managed-execution-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "owner");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "managed-execution",
      title: "Managed execution projection",
      description: "Expose the daemon-owned Task to Session Goal execution binding.",
      kind: "research",
      roleRef: "role:builtin-researcher" as RoleRef,
      status: "running",
      plan: executionReadyPlan("Expose managed execution projection"),
    });
    const evidenceRef = "evidence:managed-execution-evidence" as EvidenceRef;
    const runRef = "run:managed-execution" as RunRef;
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: task.ref,
      roleRef: "role:builtin-researcher" as RoleRef,
      runName: "managed-execution-attempt-2",
      status: "running",
      execution: {
        ownerSessionId: "owner",
        executionSessionId: "sess_task_projection",
        sessionGoalId: "goal-managed-projection",
        subgoalRef: "subgoal:managed-projection" as SubgoalRef,
        planRevision: 6,
        definitionDigest: "definition-digest",
        jobId: "job-managed-projection",
        attempt: 2,
        invocationId: "inv_managed_projection",
      },
      startedAt: "2026-07-29T00:00:00.000Z",
      outputEvidenceRefs: [evidenceRef],
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "task_status",
      taskRef: task.ref,
    });
    assert.match(
      toolText(status),
      /TaskRun=run:managed-execution \| status=running \| Session=sess_task_projection \| Goal=goal-managed-projection/u,
    );
    const taskRun = (
      status.details as {
        selectedTask?: {
          taskRun?: {
            runRef?: string;
            executionSessionId?: string;
            sessionGoalId?: string;
            subgoalRef?: string;
            attempt?: number;
            evidenceRefs?: string[];
          };
        };
      }
    ).selectedTask?.taskRun;
    assert.deepEqual(taskRun, {
      runRef,
      status: "running",
      roleRef: "role:builtin-researcher",
      executionSessionId: "sess_task_projection",
      sessionGoalId: "goal-managed-projection",
      subgoalRef: "subgoal:managed-projection",
      planRevision: 6,
      definitionDigest: "definition-digest",
      jobId: "job-managed-projection",
      attempt: 2,
      invocationId: "inv_managed_projection",
      evidenceRefs: [evidenceRef],
      failureKind: undefined,
      errorMessage: undefined,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_status defaults to active view, supports summary, limits, and state drill-down", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-views-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const otherCtx = testSparkContext(dir, "other");
    const sessionKey = ctxSessionKey(ctx);
    const otherSessionKey = ctxSessionKey(otherCtx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "mine",
      title: "Mine running task",
      description: "Visible unfinished work for the current session.",
      kind: "implement",
      status: "running",
      claim: {
        kind: "main",
        claimedBy: sessionKey,
        sessionId: sessionKey,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    });
    graph.createTask({
      projectRef: project.ref,
      name: "other",
      title: "Other pending task",
      description: "Visible unfinished work from another session.",
      kind: "review",
      status: "pending",
      claim: {
        kind: "main",
        claimedBy: otherSessionKey,
        sessionId: otherSessionKey,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    });
    graph.createTask({
      projectRef: project.ref,
      name: "finished",
      title: "Finished task history",
      description: "Hidden from active view; completed counts stay summarized.",
      kind: "generic",
      status: "done",
    });
    graph.createTask({
      projectRef: project.ref,
      name: "cancelled",
      title: "Cancelled task history",
      description: "Hidden from active view; completed counts stay summarized.",
      kind: "generic",
      status: "cancelled",
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const active = await executeSparkTool(tools, "impl_status", ctx, {});
    const activeText = toolText(active);
    assert.match(activeText, /Spark tasks \(active view, limit=8\):/);
    assert.match(activeText, /Tool persistence \[current\]/);
    assert.doesNotMatch(activeText, /Project status: active/);
    assert.match(activeText, /Active tasks:/);
    assert.match(activeText, /Mine running task/);
    assert.match(activeText, /Other pending task/);
    assert.doesNotMatch(activeText, /plan=present/);
    assert.doesNotMatch(activeText, /plan=/);
    assert.doesNotMatch(activeText, /missing-success|missing-evidence/);
    assert.doesNotMatch(activeText, /Finished task history/);
    assert.doesNotMatch(activeText, /Cancelled task history/);
    assert.doesNotMatch(activeText, /kind=implement/);
    assert.doesNotMatch(activeText, /claimed=session:/);
    assert.doesNotMatch(activeText, new RegExp(project.ref));
    assert.match(activeText, /Completed tasks: 2 total \| done=1 \| cancelled=1/);
    assert.equal(active.details?.view, "active");
    assert.equal(active.details?.limit, 8);
    assert.equal(active.details?.activeProjectRef, project.ref);
    assert.equal("tasks" in active.details!, false);
    assert.equal("dependencies" in active.details!, false);

    const json = await executeSparkTool(tools, "impl_status", ctx, { format: "json" });
    const jsonText = toolText(json);
    assert.doesNotMatch(jsonText, /Spark tasks \(/);
    const jsonStatus = JSON.parse(jsonText) as {
      found: boolean;
      compact: boolean;
      format: string;
      view: string;
      activeProject?: {
        ref: string;
        taskCounts: { total: number; claimedByCurrentSession: number };
      };
      currentClaim?: { name: string; title: string; claimedByCurrentSession: boolean };
      ready: unknown[];
      renderedProjects: Array<{
        ref: string;
        current: boolean;
        taskCounts: { total: number; claimedByCurrentSession: number };
        tasks?: unknown[];
      }>;
      projects?: unknown[];
      workflowRunStatus?: { recentRuns?: unknown[] };
      hints?: string[];
    };
    assert.equal(jsonStatus.found, true);
    assert.equal(jsonStatus.compact, true);
    assert.equal(jsonStatus.format, "json");
    assert.equal(jsonStatus.view, "active");
    assert.equal(jsonStatus.activeProject?.ref, project.ref);
    assert.equal(jsonStatus.activeProject?.taskCounts.total, 4);
    assert.equal(jsonStatus.activeProject?.taskCounts.claimedByCurrentSession, 1);
    assert.equal(jsonStatus.currentClaim?.name, "mine");
    assert.equal(jsonStatus.currentClaim?.claimedByCurrentSession, true);
    assert.deepEqual(jsonStatus.ready, []);
    assert.equal(jsonStatus.renderedProjects[0]?.ref, project.ref);
    assert.equal(jsonStatus.renderedProjects[0]?.current, true);
    assert.equal(jsonStatus.renderedProjects[0]?.taskCounts.total, 4);
    assert.equal(jsonStatus.renderedProjects[0]?.taskCounts.claimedByCurrentSession, 1);
    assert.equal(jsonStatus.renderedProjects[0]?.tasks, undefined);
    assert.equal(jsonStatus.projects, undefined);
    assert.equal(jsonStatus.workflowRunStatus?.recentRuns, undefined);
    assert.match(jsonStatus.hints?.join("\n") ?? "", /projectRef\/taskRef\/limit/);
    assert.equal(json.details?.format, "json");

    const limited = await executeSparkTool(tools, "impl_status", ctx, { limit: 1 });
    const limitedText = toolText(limited);
    assert.match(limitedText, /Spark tasks \(active view, limit=1\):/);
    assert.match(limitedText, /Hidden by limit: 1/);
    assert.equal((limitedText.match(/^ {2}- \[/gm) ?? []).length, 1);

    const summary = await executeSparkTool(tools, "impl_status", ctx, { view: "summary" });
    const summaryText = toolText(summary);
    assert.match(summaryText, /Spark tasks \(summary view\):/);
    assert.match(summaryText, /Tasks: 4 total/);
    assert.doesNotMatch(summaryText, /Active tasks:/);
    assert.doesNotMatch(summaryText, /^ {2}- \[/m);
    assert.equal(summary.details?.view, "summary");
    assert.equal(summary.details?.limit, undefined);

    await writeFile(join(dir, ".spark", "projects.json"), "{}\n", "utf8");
    await writeFile(join(dir, ".spark", "review-gate.json"), "{}\n", "utf8");

    const stateSummary = await executeSparkTool(tools, "impl_status", ctx, {
      includeStateSummary: true,
    });
    const stateSummaryText = toolText(stateSummary);
    assert.match(stateSummaryText, /Spark tasks \(active view, limit=8\):/);
    assert.match(stateSummaryText, /Active tasks:/);
    assert.doesNotMatch(stateSummaryText, /Finished task history/);
    assert.doesNotMatch(stateSummaryText, /Cancelled task history/);
    assert.match(stateSummaryText, /Completed tasks: 2 total \| done=1 \| cancelled=1/);
    assert.match(stateSummaryText, /Spark state cache:/);
    assert.match(stateSummaryText, /sessions: \d+ files/);
    assert.match(stateSummaryText, /V2 canonical stores \(protected\):/);
    assert.match(stateSummaryText, /project graph: \d+ files, .*\.spark\/projects/);
    assert.match(stateSummaryText, /Import-only paths: 2/);
    assert.match(stateSummaryText, /\.spark\/projects\.json/);
    assert.match(stateSummaryText, /\.spark\/review-gate\.json/);
    assert.doesNotMatch(stateSummaryText, /project graph: .*\.spark\/projects\.json/);
    assert.doesNotMatch(stateSummaryText, /Hidden finished tasks/);
    assert.equal(stateSummary.details?.view, "active");
    assert.equal(stateSummary.details?.limit, 8);
    const state = (
      stateSummary.details as
        | {
            state?: {
              caches: Array<{ kind: string; files: number }>;
              protectedStores: Array<{ reason: string; files: number }>;
              legacyImportOnly: string[];
            };
          }
        | undefined
    )?.state;
    assert.ok(state);
    assert.ok(state.caches.some((cache) => cache.kind === "sessions" && cache.files >= 1));
    assert.ok(
      state.protectedStores.some((store) => store.reason === "task-graph" && store.files >= 1),
    );

    await assert.rejects(
      () => executeSparkTool(tools, "impl_status", ctx, { view: "unsupported" }),
      /view must be active or summary/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state cache_cleanup previews and deletes only safe cache files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-cleanup-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const currentSessionScope = ctxSessionStoreScope(ctx);
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000);

    const currentProjectDir = join(dir, ".spark", "sessions");
    const taskTodoDir = join(dir, ".spark", "todos");
    const sessionTodoDir = join(dir, ".spark", "session-todos");
    const displayNumberDir = join(dir, ".spark", "todo-display-numbers");
    const artifactsDir = join(dir, ".spark", "artifacts");
    const evidenceDir = join(dir, ".spark", "evidence");
    const notesDir = join(dir, ".spark", "notes");
    const roleReportsDir = join(dir, ".spark", "role-reports");
    const reviewsDir = join(dir, ".spark", "reviews");
    await mkdir(currentProjectDir, { recursive: true });
    await mkdir(taskTodoDir, { recursive: true });
    await mkdir(sessionTodoDir, { recursive: true });
    await mkdir(displayNumberDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(evidenceDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });
    await mkdir(roleReportsDir, { recursive: true });
    await mkdir(reviewsDir, { recursive: true });

    const missingProjectFile = join(currentProjectDir, "old-owner.json");
    const emptyOtherTaskTodos = join(taskTodoDir, "other-session.json");
    const currentTaskTodos = join(taskTodoDir, `${currentSessionScope}.json`);
    const terminalOtherSessionTodos = join(sessionTodoDir, "other-session.json");
    const staleDisplayNumbers = join(displayNumberDir, "other-session.json");
    const protectedArtifact = join(artifactsDir, "keep.txt");
    const protectedEvidence = join(evidenceDir, "keep.txt");
    const protectedWorkflowRuns = join(dir, ".spark", "workflow-runs.json");
    const protectedReviewsIndex = join(reviewsDir, "index.json");
    const protectedNote = join(notesDir, "keep.md");
    const protectedRoleReport = join(roleReportsDir, "keep.md");

    await writeFile(missingProjectFile, JSON.stringify({ projectRef: "proj:missing" }), "utf8");
    await writeFile(emptyOtherTaskTodos, JSON.stringify({ version: 1, todos: [] }), "utf8");
    await writeFile(currentTaskTodos, JSON.stringify({ version: 1, todos: [] }), "utf8");
    await writeFile(
      terminalOtherSessionTodos,
      JSON.stringify({ version: 1, todos: [{ content: "done", status: "done" }] }),
      "utf8",
    );
    await writeFile(staleDisplayNumbers, JSON.stringify({ version: 1, entries: [] }), "utf8");
    await writeFile(protectedArtifact, "keep", "utf8");
    await writeFile(protectedEvidence, "keep", "utf8");
    await writeFile(
      protectedWorkflowRuns,
      JSON.stringify({
        version: 1,
        manager: { status: "idle", updatedAt: new Date().toISOString() },
        runs: [],
      }),
      "utf8",
    );
    await writeFile(protectedReviewsIndex, JSON.stringify({ version: 1, reviews: [] }), "utf8");
    await writeFile(protectedNote, "keep", "utf8");
    await writeFile(protectedRoleReport, "keep", "utf8");
    await utimes(terminalOtherSessionTodos, oldDate, oldDate);
    await utimes(staleDisplayNumbers, oldDate, oldDate);

    const dryRun = await executeSparkTool(tools, "impl_state", ctx, {
      action: "cache_cleanup",
      olderThanDays: 30,
    });
    const dryRunText = toolText(dryRun);
    assert.match(dryRunText, /Spark state cleanup dry-run: would delete 4 safe cache file\(s\)/);
    assert.match(dryRunText, /old-owner\.json/);
    assert.match(dryRunText, /other-session\.json/);
    assert.equal(existsSync(missingProjectFile), true);
    assert.equal(existsSync(emptyOtherTaskTodos), true);
    assert.equal(existsSync(terminalOtherSessionTodos), true);
    assert.equal(existsSync(staleDisplayNumbers), true);

    const apply = await executeSparkTool(tools, "impl_state", ctx, {
      action: "cache_cleanup",
      dryRun: false,
      olderThanDays: 30,
    });
    assert.match(toolText(apply), /Spark state cleanup apply: deleted 4 safe cache file\(s\)/);
    assert.equal(existsSync(missingProjectFile), false);
    assert.equal(existsSync(emptyOtherTaskTodos), false);
    assert.equal(existsSync(terminalOtherSessionTodos), false);
    assert.equal(existsSync(staleDisplayNumbers), false);
    assert.equal(existsSync(currentTaskTodos), true);
    assert.equal(existsSync(projectTreeIndexPath(dir)), true);
    assert.equal(existsSync(protectedArtifact), true);
    assert.equal(existsSync(protectedEvidence), true);
    assert.equal(existsSync(protectedWorkflowRuns), true);
    assert.equal(existsSync(protectedReviewsIndex), true);
    assert.equal(existsSync(protectedNote), true);
    assert.equal(existsSync(protectedRoleReport), true);

    const status = await executeSparkTool(tools, "impl_state", ctx, { action: "state_status" });
    assert.match(toolText(status), /Spark state status:/);
    assert.match(toolText(status), /V2 canonical stores \(protected\):/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state reports broken cache files without counting them safe by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-cleanup-broken-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const brokenCurrentProject = join(dir, ".spark", "sessions", "broken-owner.json");
    const brokenDisplayNumbers = join(dir, ".spark", "todo-display-numbers", "broken-display.json");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await mkdir(join(dir, ".spark", "todo-display-numbers"), { recursive: true });
    await writeFile(brokenCurrentProject, "{not-json", "utf8");
    await writeFile(brokenDisplayNumbers, "{not-json", "utf8");

    const status = await executeSparkTool(tools, "impl_state", ctx, { action: "state_status" });
    const caches = (
      status.details as {
        state?: {
          caches?: Array<{
            kind: string;
            brokenFiles: number;
            safeToDeleteFiles: number;
          }>;
        };
      }
    ).state?.caches;
    assert.ok(caches);
    assert.equal(caches.find((cache) => cache.kind === "sessions")?.brokenFiles, 1);
    assert.equal(caches.find((cache) => cache.kind === "sessions")?.safeToDeleteFiles, 0);
    assert.equal(caches.find((cache) => cache.kind === "todo-display-numbers")?.brokenFiles, 1);
    assert.equal(
      caches.find((cache) => cache.kind === "todo-display-numbers")?.safeToDeleteFiles,
      0,
    );

    const defaultCleanup = await executeSparkTool(tools, "impl_state", ctx, {
      action: "cache_cleanup",
      dryRun: false,
    });
    assert.match(toolText(defaultCleanup), /deleted 0 safe cache file\(s\)/);
    assert.equal(existsSync(brokenCurrentProject), true);
    assert.equal(existsSync(brokenDisplayNumbers), true);

    const explicitBrokenCleanup = await executeSparkTool(tools, "impl_state", ctx, {
      action: "cache_cleanup",
      dryRun: false,
      includeBroken: true,
    });
    assert.match(toolText(explicitBrokenCleanup), /deleted 2 safe cache file\(s\)/);
    assert.equal(existsSync(brokenCurrentProject), false);
    assert.equal(existsSync(brokenDisplayNumbers), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state state_doctor reports protected-store candidates without deleting files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-diagnostics-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const terminalProject = graph.createProject({
      title: "Completed diagnostics project",
      description: "Project with no unfinished work.",
    });
    const activeProject = graph.createProject({
      title: "Active diagnostics project",
      description: "Project with unfinished work.",
    });
    graph.createTask({
      projectRef: activeProject.ref,
      title: "Active task",
      description: "Keep this project out of terminal diagnostics.",
      status: "ready",
    });
    await defaultTaskGraphStore(dir).save(graph);

    const now = new Date().toISOString();
    await defaultWorkflowRunStore(dir).save({
      version: 1,
      manager: { status: "idle", updatedAt: now },
      runs: [
        {
          ref: "run:inactive-diagnostics",
          projectRef: terminalProject.ref,
          dryRun: true,
          maxConcurrency: 1,
          timeoutMs: 1_000,
          status: "succeeded",
          startedAt: now,
          updatedAt: now,
          finishedAt: now,
          scheduled: 1,
          completed: 1,
          timedOut: false,
          scheduledTaskRefs: [],
          completedTaskRefs: [],
          taskRunRefs: [],
          completionDigest: [],
        },
      ],
    });

    const evidence = await defaultEvidenceStore(dir).put({
      kind: "trace",
      title: "Large diagnostics evidence",
      format: "text",
      body: "x".repeat(70 * 1024),
      provenance: { producer: "spark", projectRef: terminalProject.ref },
    });
    const orphanBlob = join(dir, ".spark", "evidence", "blobs", "orphan-diagnostics.txt");
    const noteFile = join(dir, ".spark", "notes", "diagnostics-note.md");
    const roleReportFile = join(dir, ".spark", "role-reports", "diagnostics-report.md");
    const reviewsIndexFile = join(dir, ".spark", "reviews", "index.json");
    await mkdir(join(dir, ".spark", "evidence", "blobs"), { recursive: true });
    await mkdir(join(dir, ".spark", "notes"), { recursive: true });
    await mkdir(join(dir, ".spark", "role-reports"), { recursive: true });
    await mkdir(join(dir, ".spark", "reviews"), { recursive: true });
    await writeFile(orphanBlob, "orphan", "utf8");
    await writeFile(noteFile, "note", "utf8");
    await writeFile(roleReportFile, "role report", "utf8");
    await writeFile(reviewsIndexFile, JSON.stringify({ version: 1, reviews: [] }), "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const diagnostics = await executeSparkTool(tools, "impl_state", ctx, {
      action: "state_doctor",
    });
    const text = toolText(diagnostics);
    assert.match(text, /Spark state diagnostics \(read-only\):/);
    assert.match(text, /Terminal\/no-unfinished projects: 1/);
    assert.match(text, /Completed diagnostics project/);
    assert.doesNotMatch(text, /Active diagnostics project/);
    assert.match(text, /Inactive workflow runs: 1/);
    assert.match(text, /run:inactive-diagnostics/);
    assert.match(text, /Large evidence: 1/);
    assert.match(text, new RegExp(evidence.ref));
    assert.match(text, /Orphan evidence blobs: 1/);
    assert.match(text, /orphan-diagnostics\.txt/);
    assert.match(text, /notes: 1/);
    assert.match(text, /diagnostics-note\.md/);
    assert.match(text, /role reports: 1/);
    assert.match(text, /diagnostics-report\.md/);
    assert.doesNotMatch(text, /x{100}/);

    const details = diagnostics.details as {
      diagnostics?: {
        largeEvidence: { candidates: Array<Record<string, unknown>> };
        orphanBlobs: { candidates: Array<Record<string, unknown>> };
        terminalProjects: { candidates: Array<Record<string, unknown>> };
      };
    };
    assert.equal(details.diagnostics?.largeEvidence.candidates[0]?.ref, evidence.ref);
    assert.equal("body" in (details.diagnostics?.largeEvidence.candidates[0] ?? {}), false);
    assert.equal(
      details.diagnostics?.orphanBlobs.candidates[0]?.path,
      ".spark/evidence/blobs/orphan-diagnostics.txt",
    );
    assert.equal(details.diagnostics?.terminalProjects.candidates[0]?.ref, terminalProject.ref);

    assert.equal(existsSync(projectTreeIndexPath(dir)), true);
    assert.equal(existsSync(defaultEvidenceStore(dir).pathFor(evidence.ref)), true);
    assert.equal(existsSync(orphanBlob), true);
    assert.equal(existsSync(noteFile), true);
    assert.equal(existsSync(roleReportFile), true);
    assert.equal(existsSync(reviewsIndexFile), true);
    assert.equal(existsSync(join(dir, ".spark", "workflow-runs.json")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state state_doctor reports store-v2 migration diagnostics with stable codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-doctor-store-v2-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Doctor project", description: "doctor" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Doctor task",
      description: "doctor task",
    });
    await defaultTaskGraphStore(dir).save(graph);

    await writeFile(join(dir, ".spark", "projects.json"), "{}", "utf8");
    await writeFile(join(dir, ".spark", "review-gate.json"), "{}", "utf8");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "sessions", "legacy-owner.json"),
      `${JSON.stringify({ version: 1, projectRef: "proj:missing" })}\n`,
      "utf8",
    );
    await mkdir(join(dir, ".spark", "sessions", "dangling-session"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "sessions", "dangling-session", "state.json"),
      `${JSON.stringify({ version: 1, projectRef: "proj:missing", currentTaskRef: "task:missing" })}\n`,
      "utf8",
    );
    const reviewDir = join(
      dir,
      ".spark",
      "projects",
      storeDirNameForTest(project.ref),
      "tasks",
      storeDirNameForTest(task.ref),
      "reviews",
    );
    await mkdir(reviewDir, { recursive: true });
    const legacyReviewFixture = await loadLegacyEvidenceFixture<
      LegacyEvidenceFixture<Record<string, unknown>>
    >("subject-review-dangling-product-v1.json");
    await writeFile(
      join(reviewDir, "legacy-dangling-review.json"),
      `${JSON.stringify(legacyReviewFixture.value)}\n`,
      "utf8",
    );

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const doctor = await executeSparkTool(tools, "impl_state", ctx, { action: "state_doctor" });
    const text = toolText(doctor);
    assert.match(text, /Store V2 doctor findings:/);
    assert.match(text, /STORE_V2_LEGACY_IMPORT_ONLY_PRESENT/);
    assert.match(text, /\.spark\/sessions\/legacy-owner\.json/);
    assert.match(text, /STORE_V2_DANGLING_CURRENT_PROJECT_REF/);
    assert.match(text, /STORE_V2_DANGLING_CURRENT_TASK_REF/);
    assert.match(text, /STORE_V2_REVIEW_INDEX_MISSING/);
    assert.match(text, /STORE_V2_REVIEW_SUBJECT_MISSING_TASK/);
    const codes = new Set(
      (
        doctor.details as {
          diagnostics?: { doctor?: { findings?: Array<{ code?: string }> } };
        }
      ).diagnostics?.doctor?.findings?.map((finding) => finding.code),
    );
    assert.equal(codes.has("STORE_V2_LEGACY_IMPORT_ONLY_PRESENT"), true);
    assert.equal(codes.has("STORE_V2_DANGLING_CURRENT_PROJECT_REF"), true);
    assert.equal(codes.has("STORE_V2_DANGLING_CURRENT_TASK_REF"), true);
    assert.equal(codes.has("STORE_V2_REVIEW_INDEX_MISSING"), true);
    assert.equal(codes.has("STORE_V2_REVIEW_SUBJECT_MISSING_TASK"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state store_v2_migrate previews, backs up, applies legacy graph import idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-migrate-v2-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const legacyGraph = new TaskGraph();
    const project = legacyGraph.createProject({ title: "Legacy project", description: "legacy" });
    const task = legacyGraph.createTask({
      projectRef: project.ref,
      title: "Legacy task",
      description: "legacy task",
    });
    await new TaskGraphStore(join(dir, ".spark", "projects.json")).save(legacyGraph);
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await mkdir(join(dir, ".spark", "todos"), { recursive: true });
    await mkdir(join(dir, ".spark", "session-todos"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "sessions", "legacy-owner.json"),
      `${JSON.stringify({ version: 1, projectRef: project.ref, currentTaskRef: task.ref })}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".spark", "todos", "legacy-owner.json"),
      `${JSON.stringify({
        version: 1,
        todos: [
          {
            id: "todo-task-legacy",
            taskRef: task.ref,
            content: "Imported task plan item",
            status: "done",
          },
        ],
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".spark", "session-todos", "legacy-owner.json"),
      `${JSON.stringify({
        version: 1,
        todos: [{ id: "todo-session-legacy", content: "Imported legacy item", status: "pending" }],
      })}\n`,
      "utf8",
    );
    await writeFile(join(dir, ".spark", "review-gate.json"), "{}\n", "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const dryRun = await executeSparkTool(tools, "impl_state", ctx, {
      action: "store_v2_migrate",
      dryRun: true,
    });
    assert.match(toolText(dryRun), /Spark store V2 migration dry-run:/);
    assert.match(toolText(dryRun), /import-project-graph/);
    assert.match(toolText(dryRun), /import-session-state/);
    assert.match(toolText(dryRun), /import-task-todos/);
    assert.match(toolText(dryRun), /import-session-todos/);
    assert.match(toolText(dryRun), /record-cutover-marker/);
    assert.match(toolText(dryRun), /Import-only paths: \d+/);
    assert.match(toolText(dryRun), /\.spark\/projects\.json/);
    assert.match(toolText(dryRun), /\.spark\/sessions\/legacy-owner\.json/);
    assert.match(toolText(dryRun), /\.spark\/todos\/legacy-owner\.json/);
    assert.match(toolText(dryRun), /\.spark\/session-todos\/legacy-owner\.json/);
    assert.match(toolText(dryRun), /\.spark\/review-gate\.json/);
    await assert.rejects(() => readFile(projectTreeIndexPath(dir), "utf8"));

    const apply = await executeSparkTool(tools, "impl_state", ctx, {
      action: "store_v2_migrate",
      dryRun: false,
    });
    assert.match(toolText(apply), /Spark store V2 migration apply:/);
    const backupDir = (apply.details as { migration?: { backupDir?: string } }).migration
      ?.backupDir;
    assert.ok(backupDir);
    assert.equal(existsSync(join(dir, backupDir, "projects.json")), true);
    assert.equal(existsSync(join(dir, backupDir, "sessions", "legacy-owner.json")), true);
    assert.equal(existsSync(join(dir, backupDir, "todos", "legacy-owner.json")), true);
    assert.equal(existsSync(join(dir, backupDir, "session-todos", "legacy-owner.json")), true);
    assert.equal(existsSync(join(dir, backupDir, "review-gate.json")), true);
    const migrated = await defaultTaskGraphStore(dir).load();
    assert.equal(migrated?.getTask(task.ref).title, "Legacy task");
    assert.equal(existsSync(projectTreeIndexPath(dir)), true);
    assert.equal(existsSync(join(dir, ".spark", "sessions", "index.json")), true);
    assert.equal(existsSync(join(dir, ".spark", "reviews", "index.json")), true);
    assert.equal(existsSync(join(dir, ".spark", "sessions", "legacy-owner", "state.json")), true);
    assert.equal(
      (await defaultTaskTodoStore(dir, "migration").load())?.[0]?.id,
      "todo-task-legacy",
    );
    assert.equal(
      (await defaultTaskTodoStore(dir, "migration").loadSessionTodos("legacy-owner"))[0]?.id,
      "todo-session-legacy",
    );
    assert.equal(existsSync(join(dir, ".spark", "projects.json")), true);
    const marker = JSON.parse(
      await readFile(join(dir, ".spark", "store-v2-cutover.json"), "utf8"),
    ) as { version?: number; storeVersion?: string; status?: string };
    assert.deepEqual(
      { version: marker.version, storeVersion: marker.storeVersion, status: marker.status },
      { version: 1, storeVersion: "v2", status: "complete" },
    );
    const actionKinds = (
      apply.details as { migration?: { actions?: Array<{ kind: string; status: string }> } }
    ).migration?.actions?.map((action) => action.kind);
    assert.equal(actionKinds?.at(-1), "record-cutover-marker");
    assert.ok(
      actionKinds &&
        actionKinds.indexOf("validate-invariants") >= 0 &&
        actionKinds.indexOf("validate-invariants") < actionKinds.indexOf("record-cutover-marker"),
    );

    const secondApply = await executeSparkTool(tools, "impl_state", ctx, {
      action: "store_v2_migrate",
      dryRun: false,
    });
    assert.match(toolText(secondApply), /Spark store V2 migration apply:/);
    assert.equal((await defaultTaskGraphStore(dir).load())?.getTask(task.ref).title, "Legacy task");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state state_doctor surfaces evidence blob stat failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-diagnostics-stat-"));
  try {
    await writeEmptySparkProject(dir);
    const evidenceDir = join(dir, ".spark", "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      join(evidenceDir, "too-long-blob.json"),
      `${JSON.stringify(
        {
          ref: "evidence:diagnostics-stat-failure",
          kind: "trace",
          title: "Diagnostics stat failure",
          format: "text",
          blobPath: `blobs/${"x".repeat(4096)}/body.txt`,
          provenance: { producer: "spark" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await assert.rejects(
      () => executeSparkTool(tools, "impl_state", ctx, { action: "state_doctor" }),
      /ENAMETOOLONG|name too long/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state rejects invalid explicit action and path parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-invalid-action-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_state", ctx, { action: "repair" }),
      /action must be state_status, state_doctor, store_v2_migrate, cache_cleanup, workflow_run_prune, or role_run_evidence_compact/,
    );
    for (const oldAction of [
      "status",
      "diagnostics",
      "doctor",
      "migrate-v2",
      "cleanup",
      "prune",
      "compact-role-run-evidence",
    ]) {
      await assert.rejects(
        () => executeSparkTool(tools, "impl_state", ctx, { action: oldAction }),
        /action must be state_status, state_doctor, store_v2_migrate, cache_cleanup, workflow_run_prune, or role_run_evidence_compact/,
      );
    }
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "role_run_evidence_compact",
          exportDir: 42,
        }),
      /exportDir must be a string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "role_run_evidence_compact",
          exportDir: "",
        }),
      /exportDir must be a non-empty string/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state rejects invalid numeric parameters instead of using defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-invalid-numeric-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "role_run_evidence_compact",
          thresholdBytes: "1024",
        }),
      /thresholdBytes must be a finite number/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "role_run_evidence_compact",
          tailBytes: 0,
        }),
      /tailBytes must be a positive integer/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "workflow_run_prune",
          keepRecent: 1.5,
        }),
      /keepRecent must be a non-negative integer/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state rejects invalid boolean parameters instead of using defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-invalid-boolean-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, { action: "cache_cleanup", dryRun: "false" }),
      /dryRun must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "cache_cleanup",
          includeBroken: "true",
        }),
      /includeBroken must be a boolean/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state role_run_evidence_compact dry-run lists large role-run candidates and keeps non-role Evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-dry-run-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultEvidenceStore(dir);
    const roleRun = await store.put({
      kind: "trace",
      title: "Large historical role run",
      format: "json",
      body: largeLegacyRoleRunBody("run:large-retention-dry-run", "worker-large-dry-run", 8 * 1024),
      provenance: {
        producer: "task",
        projectRef: "proj:retention-dry-run" as ProjectRef,
        taskRef: "task:retention-dry-run" as TaskRef,
        roleRef: "role:builtin-worker" as RoleRef,
      },
    });
    const research = await store.put({
      kind: "document",
      title: "Large research evidence",
      format: "text",
      body: "research\n".repeat(2 * 1024),
      provenance: { producer: "spark" },
    });
    const roleRunMetadata = JSON.parse(await readFile(store.pathFor(roleRun.ref), "utf8")) as {
      blobPath: string;
    };
    const researchMetadata = JSON.parse(await readFile(store.pathFor(research.ref), "utf8")) as {
      blobPath: string;
    };
    const roleRunBlob = join(dir, ".spark", "evidence", roleRunMetadata.blobPath);
    const researchBlob = join(dir, ".spark", "evidence", researchMetadata.blobPath);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_state", ctx, {
      action: "role_run_evidence_compact",
      thresholdBytes: 1024,
      tailBytes: 80,
    });

    const text = toolText(result);
    assert.match(text, /Spark role-run evidence retention dry-run/);
    assert.match(text, new RegExp(roleRun.ref));
    assert.doesNotMatch(text, new RegExp(research.ref));
    assert.match(text, /non-role-run=1/);
    assert.equal(existsSync(roleRunBlob), true);
    assert.equal(existsSync(researchBlob), true);

    const details = result.details as {
      retention?: {
        dryRun: boolean;
        candidates: Array<{
          ref: string;
          taskRef?: string;
          runRef?: string;
          candidateReason: string;
          replacementSummary: string;
          transcriptTail?: { tail: string; tailBytes: number };
        }>;
        skipped: Array<{ ref?: string; reason: string }>;
        deleted: unknown[];
      };
    };
    assert.equal(details.retention?.dryRun, true);
    assert.equal(details.retention?.deleted.length, 0);
    assert.equal(details.retention?.candidates.length, 1);
    assert.equal(details.retention?.candidates[0]?.ref, roleRun.ref);
    assert.equal(
      details.retention?.candidates[0]?.candidateReason,
      "large_role-run_transcript_blob",
    );
    assert.equal(details.retention?.candidates[0]?.taskRef, "task:retention-dry-run");
    assert.equal(details.retention?.candidates[0]?.runRef, "run:large-retention-dry-run");
    assert.match(details.retention?.candidates[0]?.replacementSummary ?? "", /compacted from/);
    assert.match(details.retention?.candidates[0]?.transcriptTail?.tail ?? "", /tail-marker/);
    assert.equal(
      details.retention?.skipped.some(
        (entry) => entry.ref === research.ref && entry.reason === "not_role_run_evidence",
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state role_run_evidence_compact skips blob paths outside Evidence root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-boundary-"));
  const outsidePath = `${dir}-outside-role-run.json`;
  try {
    await writeEmptySparkProject(dir);
    const store = defaultEvidenceStore(dir);
    const roleRun = await store.put({
      kind: "trace",
      title: "External role run blob",
      format: "json",
      body: largeLegacyRoleRunBody("run:external-retention", "worker-external", 8 * 1024),
      provenance: {
        producer: "task",
        projectRef: "proj:retention-boundary" as ProjectRef,
        taskRef: "task:retention-boundary" as TaskRef,
        roleRef: "role:builtin-worker" as RoleRef,
      },
    });
    const metadataPath = store.pathFor(roleRun.ref);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { blobPath?: string };
    metadata.blobPath = outsidePath;
    await writeFile(outsidePath, "outside role-run transcript", "utf8");
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_state", ctx, {
      action: "role_run_evidence_compact",
      thresholdBytes: 1,
      tailBytes: 80,
    });

    assert.match(toolText(result), /invalid-blob-path=1/);
    assert.equal(existsSync(outsidePath), true);
    const details = result.details as {
      retention?: {
        candidates: unknown[];
        skipped: Array<{ ref?: string; reason: string }>;
      };
    };
    assert.equal(details.retention?.candidates.length, 0);
    assert.equal(
      details.retention?.skipped.some(
        (entry) => entry.ref === roleRun.ref && entry.reason === "invalid_blob_path",
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("impl_state role_run_evidence_compact reports invalid Evidence metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-invalid-json-"));
  try {
    await writeEmptySparkProject(dir);
    const metadataDir = join(dir, ".spark", "evidence");
    await mkdir(metadataDir, { recursive: true });
    await writeFile(join(metadataDir, "broken-role-run.json"), "{not-json", "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_state", ctx, {
      action: "role_run_evidence_compact",
      thresholdBytes: 1,
      tailBytes: 80,
    });

    assert.match(toolText(result), /invalid-json=1/);
    const details = result.details as {
      retention?: {
        candidates: unknown[];
        skipped: Array<{ path: string; reason: string; message?: string }>;
      };
    };
    assert.equal(details.retention?.candidates.length, 0);
    const skipped = details.retention?.skipped.find((entry) => entry.reason === "invalid_json");
    assert.ok(skipped);
    assert.match(skipped.path, /broken-role-run\.json$/);
    assert.match(skipped.message ?? "", /Expected property name|not valid JSON|Unexpected token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_state role_run_evidence_compact apply writes replacement summary before deleting blob", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-apply-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultEvidenceStore(dir);
    const roleRun = await store.put({
      kind: "trace",
      title: "Large historical role run apply",
      format: "json",
      body: largeLegacyRoleRunBody("run:large-retention-apply", "worker-large-apply", 8 * 1024),
      provenance: {
        producer: "task",
        projectRef: "proj:retention-apply" as ProjectRef,
        taskRef: "task:retention-apply" as TaskRef,
        roleRef: "role:builtin-worker" as RoleRef,
      },
    });
    const before = JSON.parse(await readFile(store.pathFor(roleRun.ref), "utf8")) as {
      blobPath: string;
    };
    const blob = join(dir, ".spark", "evidence", before.blobPath);
    assert.equal(existsSync(blob), true);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const applied = await executeSparkTool(tools, "impl_state", ctx, {
      action: "role_run_evidence_compact",
      dryRun: false,
      thresholdBytes: 1024,
      tailBytes: 80,
      exportDir: "exports/role-run-transcripts",
    });
    assert.match(toolText(applied), /Apply complete/);
    assert.equal(existsSync(blob), false);

    const after = JSON.parse(await readFile(store.pathFor(roleRun.ref), "utf8")) as {
      body: { summary: string; stdout: { tail: string } };
      bodyTruncated?: boolean;
      blobPath?: string;
      transcriptRetention?: {
        originalBlobPath?: string;
        replacementSummary?: string;
        exportPath?: string;
        fullTranscriptDeletedAt?: string;
      };
    };
    assert.equal(after.bodyTruncated, false);
    assert.equal(after.blobPath, undefined);
    assert.match(after.body.summary, /worker-large-apply/);
    assert.match(after.body.stdout.tail, /tail-marker/);
    assert.equal(after.transcriptRetention?.originalBlobPath, before.blobPath);
    assert.match(after.transcriptRetention?.replacementSummary ?? "", /compacted from/);
    assert.ok(after.transcriptRetention?.fullTranscriptDeletedAt);
    assert.ok(after.transcriptRetention?.exportPath);
    assert.equal(existsSync(join(dir, after.transcriptRetention.exportPath)), true);

    const fetched = await executeSparkTool(tools, "evidence", ctx, {
      action: "read",
      evidenceRef: roleRun.ref,
      maxChars: 4_000,
    });
    assert.match(toolText(fetched), /Historical role-run transcript worker-large-apply/);
    // Retention metadata lives on the store record, not in the compact body text agents read.
    assert.ok(after.transcriptRetention?.fullTranscriptDeletedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("impl_plan_tasks keeps large plan output bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-bounded-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: Array.from({ length: 8 }, (_, index) => ({
        name: `task-${index + 1}`,
        title: `Task ${index + 1}`,
        description: `Bounded output task ${index + 1}.`,
        plan: executionReadyPlan(`Bounded output task ${index + 1}.`),
      })),
    });
    const text = toolText(planned);

    assert.match(text, /Planned tasks: created=8 updated=0 dependencies=0/);
    assert.match(text, /… 3 more changed task\(s\)/);
    assert.equal((text.match(/^- created/gm) ?? []).length, 5);
    assert.doesNotMatch(text, /\(task:/);
    const details = planned.details as { result?: { created?: unknown[]; dependencies?: number } };
    assert.equal(details.result?.created?.length, 8);
    assert.equal(details.result?.dependencies, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session-bound todo implementation is registered as impl_todo", () => {
  const { tools } = registerSparkToolsForTest();
  assert.equal(tools.has("impl_update_todos"), false);
  assert.ok(tools.has("impl_todo"), "missing session-bound impl_todo tool");
  const todo = tools.get("todo");
  assert.ok(todo, "missing public todo tool");
  assert.doesNotMatch(todo.description ?? "", /action=list/);
  assert.doesNotMatch(JSON.stringify(todo.parameters), /list \| init/);
});

test("todo tool tracks session-bound checklist without list read roundtrips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todo-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const init = await executeSparkTool(run.tools, "todo", ctx, {
      action: "init",
      items: ["Draft the RFC", "Collect review feedback"],
    });
    assert.match(toolText(init), /Applied todo action=init; 2 active/);
    assert.doesNotMatch(toolText(init), /Draft the RFC/);

    const preview = await executeSparkTool(run.tools, "context", ctx, {
      action: "preview",
      providerIds: ["spark.todos"],
    });
    assert.match(toolText(preview), /Session TODOs: 2 active/);
    assert.match(toolText(preview), /\[in_progress\].*Draft the RFC/);
    assert.match(toolText(preview), /\[pending\].*Collect review feedback/);

    const firstHook = (await run.eventHandlers.get("before_agent_start")?.[0]?.({}, ctx)) as {
      messages?: Array<{ content?: string; details?: Record<string, unknown> }>;
    };
    const firstSnapshot = firstHook.messages?.find(
      (message) => message.details?.providerId === "spark.todos",
    );
    assert.match(firstSnapshot?.content ?? "", /Draft the RFC/);
    const unchangedHook = (await run.eventHandlers.get("before_agent_start")?.[0]?.({}, ctx)) as
      | { messages?: Array<{ details?: Record<string, unknown> }> }
      | undefined;
    assert.equal(
      unchangedHook?.messages?.some((message) => message.details?.providerId === "spark.todos") ??
        false,
      false,
    );

    await executeSparkTool(run.tools, "todo", ctx, { action: "done", item: "Draft the RFC" });
    const reloaded = await loadIndependentTodos(dir, ctx);
    assert.deepEqual(
      reloaded.map((todo) => [todo.content, todo.status]),
      [
        ["Draft the RFC", "done"],
        ["Collect review feedback", "in_progress"],
      ],
    );
    const changedHook = (await run.eventHandlers.get("before_agent_start")?.[0]?.({}, ctx)) as {
      messages?: Array<{ content?: string; details?: Record<string, unknown> }>;
    };
    const changedSnapshot = changedHook.messages?.find(
      (message) => message.details?.providerId === "spark.todos",
    );
    assert.match(changedSnapshot?.content ?? "", /\[in_progress\].*Collect review feedback/);

    await executeSparkTool(run.tools, "todo", ctx, {
      action: "done",
      item: "Collect review feedback",
    });
    const completed = await loadIndependentTodos(dir, ctx);
    assert.equal(completed.filter(isActiveSessionTodo).length, 0);
    const clearedHook = (await run.eventHandlers.get("before_agent_start")?.[0]?.({}, ctx)) as {
      messages?: Array<{ content?: string; details?: Record<string, unknown> }>;
    };
    const clearedSnapshot = clearedHook.messages?.find(
      (message) => message.details?.providerId === "spark.todos",
    );
    assert.equal(clearedSnapshot?.details?.cleared, true);
    assert.match(clearedSnapshot?.content ?? "", /0 active/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("todo start, block, and cancel mutations stay compact and match durable hook snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todo-mutation-matrix-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const items = ["Implement parser", "Wait for approval", "Archive fallback"];

    const assertHookMatchesDurableStore = async () => {
      const durable = await loadIndependentTodos(dir, ctx);
      const hook = (await run.eventHandlers.get("before_agent_start")?.[0]?.({}, ctx)) as
        | {
            messages?: Array<{ content?: string; details?: Record<string, unknown> }>;
          }
        | undefined;
      const snapshot = hook?.messages?.find(
        (message) => message.details?.providerId === "spark.todos",
      );
      assert.ok(snapshot, "expected changed spark.todos hook snapshot");
      const durableContext = renderSessionTodoContext(durable.filter(isActiveSessionTodo));
      assert.equal(snapshot.content?.endsWith(durableContext), true);
      return durable;
    };

    const initialized = await executeSparkTool(run.tools, "todo", ctx, {
      action: "init",
      items,
    });
    assert.match(toolText(initialized), /Applied todo action=init; 3 active/);
    for (const item of items) assert.equal(toolText(initialized).includes(item), false);
    let durable = await assertHookMatchesDurableStore();
    const [first, second, third] = durable;
    assert.ok(first?.id);
    assert.ok(second?.id);
    assert.ok(third?.id);
    const firstId = first.id;
    const secondId = second.id;
    const thirdId = third.id;

    const started = await executeSparkTool(run.tools, "todo", ctx, {
      action: "start",
      id: secondId,
    });
    const startedDetails = started.details as {
      action?: string;
      activeCount?: number;
      changedTodoIds?: string[];
    };
    assert.match(toolText(started), /Applied todo action=start; 3 active/);
    assert.doesNotMatch(toolText(started), /Session TODOs:/);
    for (const item of items) assert.equal(toolText(started).includes(item), false);
    assert.equal(startedDetails.action, "start");
    assert.equal(startedDetails.activeCount, 3);
    assert.deepEqual(new Set(startedDetails.changedTodoIds), new Set([firstId, secondId]));
    durable = await assertHookMatchesDurableStore();
    assert.equal(durable.find((todo) => todo.id === firstId)?.status, "pending");
    assert.equal(durable.find((todo) => todo.id === secondId)?.status, "in_progress");

    const blockedBy = ["ask:approval-window", "task:dependency"];
    const blocked = await executeSparkTool(run.tools, "todo", ctx, {
      action: "block",
      id: secondId,
      blockedBy,
    });
    const blockedDetails = blocked.details as {
      action?: string;
      activeCount?: number;
      changedTodoIds?: string[];
    };
    assert.match(toolText(blocked), /Applied todo action=block; 3 active/);
    assert.doesNotMatch(toolText(blocked), /Session TODOs:|blockedBy:/);
    for (const item of items) assert.equal(toolText(blocked).includes(item), false);
    assert.equal(blockedDetails.action, "block");
    assert.equal(blockedDetails.activeCount, 3);
    assert.deepEqual(new Set(blockedDetails.changedTodoIds), new Set([firstId, secondId]));
    durable = await assertHookMatchesDurableStore();
    assert.equal(durable.find((todo) => todo.id === firstId)?.status, "in_progress");
    assert.equal(durable.find((todo) => todo.id === secondId)?.status, "blocked");
    assert.deepEqual(durable.find((todo) => todo.id === secondId)?.blockedBy, blockedBy);

    const cancelled = await executeSparkTool(run.tools, "todo", ctx, {
      action: "cancel",
      id: firstId,
    });
    const cancelledDetails = cancelled.details as {
      action?: string;
      activeCount?: number;
      changedTodoIds?: string[];
    };
    assert.match(toolText(cancelled), /Applied todo action=cancel; 2 active/);
    assert.doesNotMatch(toolText(cancelled), /Session TODOs:/);
    for (const item of items) assert.equal(toolText(cancelled).includes(item), false);
    assert.equal(cancelledDetails.action, "cancel");
    assert.equal(cancelledDetails.activeCount, 2);
    assert.deepEqual(new Set(cancelledDetails.changedTodoIds), new Set([firstId, thirdId]));
    durable = await assertHookMatchesDurableStore();
    assert.equal(durable.find((todo) => todo.id === firstId)?.status, "cancelled");
    assert.equal(durable.find((todo) => todo.id === secondId)?.status, "blocked");
    assert.equal(durable.find((todo) => todo.id === thirdId)?.status, "in_progress");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark.todos preview exposes blockers, bounds, refs, and direct empty state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todo-context-details-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await saveIndependentTodos(dir, ctx, [
      {
        id: "todo-blocked",
        content: "Resolve deployment approval before releasing the production artifact",
        status: "blocked",
        blockedBy: ["ask:approval-window", "task:dependency"],
      },
      {
        id: "todo-pending",
        content: "Prepare a deliberately long follow-up item for bounded context rendering",
        status: "pending",
      },
    ]);

    const preview = await executeSparkTool(tools, "context", ctx, {
      action: "preview",
      providerIds: ["spark.todos"],
    });
    assert.match(
      toolText(preview),
      /- \[blocked\] todo-blocked: Resolve deployment approval before releasing the production artifact/,
    );
    assert.match(toolText(preview), /blockedBy: ask:approval-window, task:dependency/);
    const previewBundle = (
      preview.details as {
        bundles?: Array<{
          providerId?: string;
          budgetChars?: number;
          content?: string;
          truncated?: boolean;
          empty?: boolean;
          revision?: string;
          priority?: number;
          refs?: string[];
        }>;
      }
    ).bundles?.[0];
    assert.equal(previewBundle?.providerId, "spark.todos");
    assert.equal(previewBundle?.budgetChars, 2_000);
    assert.equal(previewBundle?.truncated, false);
    assert.equal(previewBundle?.empty, false);
    assert.match(previewBundle?.revision ?? "", /^[0-9a-f]{64}$/);
    assert.equal(previewBundle?.priority, 110);
    assert.deepEqual(previewBundle?.refs, [".spark/todos/todos.sqlite"]);

    const bounded = await executeSparkTool(tools, "context", ctx, {
      action: "preview",
      providerIds: ["spark.todos"],
      budgetChars: 80,
    });
    const boundedBundle = (
      bounded.details as {
        bundles?: Array<{ content?: string; budgetChars?: number; truncated?: boolean }>;
      }
    ).bundles?.[0];
    assert.equal(boundedBundle?.budgetChars, 80);
    assert.equal(boundedBundle?.truncated, true);
    assert.ok((boundedBundle?.content?.length ?? Number.POSITIVE_INFINITY) <= 80);
    assert.match(boundedBundle?.content ?? "", /…$/);

    await saveIndependentTodos(dir, ctx, []);
    const empty = await executeSparkTool(tools, "context", ctx, {
      action: "preview",
      providerIds: ["spark.todos"],
    });
    assert.match(
      toolText(empty),
      /Session TODOs: 0 active\. Earlier active snapshots are cleared\./,
    );
    const emptyBundle = (
      empty.details as {
        bundles?: Array<{
          providerId?: string;
          empty?: boolean;
          truncated?: boolean;
          refs?: string[];
        }>;
      }
    ).bundles?.[0];
    assert.equal(emptyBundle?.providerId, "spark.todos");
    assert.equal(emptyBundle?.empty, true);
    assert.equal(emptyBundle?.truncated, false);
    assert.deepEqual(emptyBundle?.refs, [".spark/todos/todos.sqlite"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("todo list remains a deprecated compatibility read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todo-list-compat-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const listed = await executeSparkTool(tools, "todo", ctx, { action: "list" });
    assert.match(toolText(listed), /Deprecated/);
    assert.equal(listed.details?.deprecated, true);
    assert.equal(listed.details?.replacementProviderId, "spark.todos");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("todo tool rejects unknown actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todo-invalid-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await assert.rejects(
      () => executeSparkTool(tools, "todo", ctx, { action: "finish" }),
      /todo\.action must be one of/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark todo tools reject invalid explicit ops without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-todos-invalid-ops-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    assert.equal(tools.has("impl_update_todos"), false);
    assert.equal(existsSync(sessionIndependentTodoPath(dir, ctx)), false);

    await useOnlySparkProject(tools, ctx);
    const claim = await planAndClaimTask(tools, ctx, {
      name: "todo-invalid",
      title: "Reject invalid plan item ops",
      description: "Invalid plan item ops must not alter task plan item state.",
      plan: executionReadyPlan("Reject invalid plan item ops."),
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
          ops: [{ op: "init", items: [42] }],
        }),
      /ops\[0\]\.items must be an array of strings/,
    );

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.equal(loaded?.getTask(taskRef).status, "running");
    const todoFile = sessionTaskTodoPath(dir, ctx);
    assert.equal(existsSync(todoFile), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy session-scoped snapshot import rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todos-invalid-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const todoFile = sessionIndependentTodoPath(dir, ctx);
    assert.deepEqual(await loadIndependentTodos(dir, ctx), []);
    await mkdir(join(dir, ".spark", "session-todos"), { recursive: true });

    await writeFile(todoFile, "[]\n", "utf8");
    await assert.rejects(
      () => importLegacyIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(todoFile, `${JSON.stringify({ version: 2, todos: [] })}\n`, "utf8");
    await assert.rejects(
      () => importLegacyIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /version must be 1/.test(error.message),
    );

    await writeFile(todoFile, `${JSON.stringify({ version: 1, todos: {} })}\n`, "utf8");
    await assert.rejects(
      () => importLegacyIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /todos must be an array/.test(error.message),
    );

    await writeFile(
      todoFile,
      `${JSON.stringify({
        version: 1,
        todos: [{ content: "Coordinate review", status: "unknown" }],
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => importLegacyIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /todos\[0\]\.status must be a valid status/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("todo display number store rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-display-numbers-invalid-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const displayNumberFile = todoDisplayNumberPath(dir, ctx);
    assert.deepEqual(await loadTodoDisplayNumberState(dir, ctx), {
      version: 1,
      next: 1,
      numbers: {},
    });
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });

    await writeFile(
      displayNumberFile,
      `${JSON.stringify({ version: 1, next: "2", numbers: { "todo:one": 1 } })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadTodoDisplayNumberState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === displayNumberFile &&
        /next must be a positive integer/.test(error.message),
    );

    await writeFile(
      displayNumberFile,
      `${JSON.stringify({ version: 1, next: 2, numbers: { "todo:one": "1" } })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadTodoDisplayNumberState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === displayNumberFile &&
        /numbers\.todo:one must be a positive integer/.test(error.message),
    );

    await writeFile(
      displayNumberFile,
      `${JSON.stringify({ version: 1, next: 2, numbers: { "todo:one": 2 } })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadTodoDisplayNumberState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === displayNumberFile &&
        /next must be greater than every display number/.test(error.message),
    );

    await writeFile(
      displayNumberFile,
      `${JSON.stringify({ version: 1, next: 3, numbers: { "todo:one": 2 } })}\n`,
      "utf8",
    );
    assert.deepEqual(await loadTodoDisplayNumberState(dir, ctx), {
      version: 1,
      next: 3,
      numbers: { "todo:one": 2 },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hidden role-run inbox store rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-hidden-inbox-invalid-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const inboxFile = hiddenRoleRunInboxPath(dir, ctx);
    assert.deepEqual(await loadHiddenRoleRunInboxState(dir, ctx), { version: 1, delivered: [] });
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });

    await writeFile(inboxFile, `${JSON.stringify({ deliveredRunRefs: ["run:legacy"] })}\n`, "utf8");
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /deliveredRunRefs is no longer supported/.test(error.message),
    );

    await writeFile(inboxFile, "[]\n", "utf8");
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(inboxFile, `${JSON.stringify({ version: 2, delivered: [] })}\n`, "utf8");
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /version must be 1/.test(error.message),
    );

    await writeFile(inboxFile, `${JSON.stringify({ version: 1, delivered: {} })}\n`, "utf8");
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /delivered must be an array/.test(error.message),
    );

    await writeFile(
      inboxFile,
      `${JSON.stringify({ version: 1, delivered: [{ runRef: "run:one" }] })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /delivered\[0\]\.deliveredAt must be a non-empty string/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeEmptySparkProject(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".spark"), { recursive: true });
  const graph = new TaskGraph();
  graph.createProject({ title: "Tool persistence", description: "Test Spark tool persistence." });
  await defaultTaskGraphStore(cwd).save(graph);
}

async function writeRoadmap(
  cwd: string,
  input: {
    activeItemRef?: string;
    items: Array<{
      ref: string;
      title?: string;
      objective: string;
      scope?: string;
      status?: string;
      successCriteria?: string[];
      evidenceRequired?: string[];
    }>;
  },
): Promise<void> {
  const store = defaultTaskGraphStore(cwd);
  const graph = (await store.load()) ?? new TaskGraph();
  const project =
    graph.projects()[0] ??
    graph.createProject({ title: "Tool persistence", description: "Test Spark tool persistence." });
  const now = new Date().toISOString();
  graph.replaceProjectRoadmap(project.ref, {
    ref: "roadmap:main",
    title: "Project roadmap",
    status: "active",
    activeItemRef: input.activeItemRef as `roadmap-item:${string}` | undefined,
    items: input.items.map((item) => ({
      ...item,
      ref: item.ref as `roadmap-item:${string}`,
      status: item.status as "active" | "pending" | "blocked" | "done" | undefined,
    })),
    createdAt: now,
    updatedAt: now,
  });
  await store.save(graph);
}

function createTaskApprovingGoalUnmetReviewerRunner(): ReviewerRunner {
  return {
    async review(input: ReviewInput): Promise<ReviewerRunResult> {
      switch (input.targetKind) {
        case "task":
        case "tool_approval":
          return createApprovingReviewerRunner().review(input);
        case "goal":
          if (input.requestedStatus === "paused")
            return createApprovingReviewerRunner().review(input);
          return createRejectingReviewerRunner("goal still has remaining work").review(input);
        default: {
          const _exhaustive: never = input;
          return _exhaustive;
        }
      }
    },
  };
}

function createApprovingReviewerRunner(): ReviewerRunner {
  return {
    async review(input: ReviewInput): Promise<ReviewerRunResult> {
      const timestamp = new Date().toISOString();
      const base = {
        outcome: "approved" as const,
        summary: "approved by test reviewer",
        findings: [],
        blockers: [],
        confidence: "high" as const,
      };
      const verdict = ((): ReviewerRunResult["verdict"] => {
        switch (input.targetKind) {
          case "task":
            return {
              ...base,
              targetKind: "task" as const,
              taskRef: input.task.ref,
              approved: true,
            };
          case "tool_approval":
            return {
              ...base,
              targetKind: "tool_approval" as const,
              toolName: input.toolName,
              approved: true,
            };
          case "goal":
            return {
              ...base,
              targetKind: "goal" as const,
              goalId: input.goalId,
              achieved: input.requestedStatus === "complete",
              evidenceValid: true,
              objectiveSatisfied: input.requestedStatus === "complete",
              remainingWork: "",
            };
          default: {
            const _exhaustive: never = input;
            return _exhaustive;
          }
        }
      })();
      return {
        verdict,
        record: {
          runRef: newRef("run"),
          roleRef: "role:builtin-reviewer" as RoleRef,
          runName: "test-reviewer",
          startedAt: timestamp,
          finishedAt: timestamp,
        },
      };
    },
  };
}

function createRejectingReviewerRunner(
  summary = "needs changes from test reviewer",
): ReviewerRunner {
  return {
    async review(input: ReviewInput): Promise<ReviewerRunResult> {
      const timestamp = new Date().toISOString();
      const verdict = ((): ReviewerRunResult["verdict"] => {
        switch (input.targetKind) {
          case "task":
            return {
              targetKind: "task" as const,
              taskRef: input.task.ref,
              approved: false,
              outcome: "needs_changes" as const,
              summary,
              findings: ["missing validation evidence"],
              blockers: ["run the focused tests"],
              confidence: "high" as const,
            };
          case "tool_approval":
            return {
              targetKind: "tool_approval" as const,
              toolName: input.toolName,
              approved: false,
              outcome: "needs_changes" as const,
              summary,
              findings: ["tool call rejected by test reviewer"],
              blockers: ["choose a safer tool call"],
              confidence: "high" as const,
            };
          case "goal":
            return {
              targetKind: "goal" as const,
              goalId: input.goalId,
              achieved: false,
              remainingWork: summary,
              outcome: "needs_changes" as const,
              summary,
              findings: ["goal remains incomplete"],
              blockers: ["finish remaining work"],
              confidence: "high" as const,
            };
          default: {
            const _exhaustive: never = input;
            return _exhaustive;
          }
        }
      })();
      return {
        verdict,
        record: {
          runRef: newRef("run"),
          roleRef: "role:builtin-reviewer" as RoleRef,
          runName: "test-reviewer",
          startedAt: timestamp,
          finishedAt: timestamp,
          stdout: "test reviewer raw stdout",
          stderr: "",
        },
      };
    },
  };
}

function createTestTaskClaimDaemonClient(
  options: {
    afterAcquire?: (ctx: SparkToolContext) => void | Promise<void>;
    afterRelease?: (ctx: SparkToolContext) => void | Promise<void>;
  } = {},
): SparkTaskClaimDaemonClient {
  return {
    async acquire(ctx, input) {
      const sessionKey = sparkSessionKey(ctx);
      const updated = await defaultTaskGraphStore(ctx.cwd).update((graph) => {
        const task = graph.getTask(input.taskRef as TaskRef);
        if (task.claim && task.claim.sessionId !== sessionKey) {
          if (!input.recovery) throw new Error(`task is already claimed: ${task.ref}`);
          graph.releaseTaskClaim(task.ref, task.claim.claimedBy);
        }
        return graph.claimTask(task.ref, {
          kind: "main",
          claimedBy: sessionKey,
          sessionId: sessionKey,
          status: input.status,
          roleRef: input.roleRef as RoleRef | undefined,
          leaseMs: 3 * 60 * 1_000,
        });
      });
      const task = updated.result;
      await options.afterAcquire?.(ctx);
      return {
        taskRef: task.ref,
        projectRef: task.projectRef,
        sessionId: sessionKey,
        outcome: "acquired",
        changed: true,
        observedAt: task.claim!.heartbeatAt,
        claim: {
          claimedAt: task.claim!.claimedAt,
          heartbeatAt: task.claim!.heartbeatAt,
          expiresAt: task.claim!.expiresAt,
        },
      };
    },
    async recover(ctx, input) {
      const sessionKey = sparkSessionKey(ctx);
      const updated = await defaultTaskGraphStore(ctx.cwd).update((graph) => {
        const task = graph.getTask(input.taskRef as TaskRef);
        return graph.releaseTaskClaim(task.ref, task.claim?.claimedBy);
      });
      return {
        taskRef: updated.result.ref,
        projectRef: updated.result.projectRef,
        sessionId: sessionKey,
        outcome: "recovered",
        changed: true,
        observedAt: updated.result.updatedAt,
      };
    },
    async release(ctx, input) {
      const sessionKey = sparkSessionKey(ctx);
      const updated = await defaultTaskGraphStore(ctx.cwd).update((graph) => {
        const task = graph.getTask(input.taskRef as TaskRef);
        return input.disposition === "release"
          ? graph.releaseTaskClaim(task.ref, task.claim?.claimedBy)
          : graph.setTaskStatus(task.ref, input.disposition);
      });
      await options.afterRelease?.(ctx);
      return {
        taskRef: updated.result.ref,
        projectRef: updated.result.projectRef,
        sessionId: sessionKey,
        outcome: "released",
        changed: true,
        observedAt: updated.result.updatedAt,
      };
    },
  };
}

function registerSparkToolsForTest(
  options: {
    reviewerRunner?: ReviewerRunner;
    taskClaimDaemonClient?: SparkTaskClaimDaemonClient;
    usageControl?: SparkDaemonUsageControl;
  } = {},
): {
  tools: Map<string, SparkToolConfig>;
  messages: string[];
  customMessages: Array<{
    customType: string;
    content: string;
    display?: boolean;
    details?: Record<string, unknown>;
    options?: { deliverAs?: string; triggerTurn?: boolean };
  }>;
  commands: Map<string, Parameters<SparkHostApiForTest["registerCommand"]>[1]>;
  shortcuts: Map<string, Parameters<NonNullable<SparkHostApiForTest["registerShortcut"]>>[1]>;
  eventHandlers: Map<string, Array<(event: unknown, ctx: TestSparkContext) => unknown>>;
  getActiveToolNames: () => string[];
  registerActiveTool: (name: string) => void;
  setActiveTools: (names: string[]) => void;
  loopControl: TestSparkDaemonLoopControl;
} {
  const tools = new Map<string, SparkToolConfig>();
  const activeToolNames = new Set<string>();
  const messages: string[] = [];
  const customMessages: Array<{
    customType: string;
    content: string;
    display?: boolean;
    details?: Record<string, unknown>;
    options?: { deliverAs?: string; triggerTurn?: boolean };
  }> = [];
  const commands = new Map<string, Parameters<SparkHostApiForTest["registerCommand"]>[1]>();
  const shortcuts = new Map<
    string,
    Parameters<NonNullable<SparkHostApiForTest["registerShortcut"]>>[1]
  >();
  const eventHandlers = new Map<
    string,
    Array<(event: unknown, ctx: TestSparkContext) => unknown>
  >();
  const loopControl = createTestDriverControl();
  const pi: SparkHostApiForTest & {
    loopControl: TestSparkDaemonLoopControl;
    usageControl?: SparkDaemonUsageControl;
    taskClaimDaemonClient: SparkTaskClaimDaemonClient;
    getActiveTools: () => string[];
    getAllTools: () => Array<{ name: string }>;
    setActiveTools: (names: string[]) => void;
    createReviewerRunner: NonNullable<SparkHostApiForTest["createReviewerRunner"]>;
  } = {
    loopControl,
    ...(options.usageControl ? { usageControl: options.usageControl } : {}),
    taskClaimDaemonClient: options.taskClaimDaemonClient ?? createTestTaskClaimDaemonClient(),
    registerCommand: (name, config) => {
      commands.set(name, config);
    },
    registerTool: (config) => {
      tools.set(config.name, config);
      activeToolNames.add(config.name);
    },
    registerInternalTool: (config) => {
      tools.set(config.name, config);
    },
    registerShortcut: (shortcut, options) => {
      shortcuts.set(shortcut, options);
    },
    on: (event, handler) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler as (event: unknown, ctx: TestSparkContext) => unknown);
      eventHandlers.set(event, handlers);
    },
    sendMessage: (message, options) => {
      customMessages.push({ ...message, options });
    },
    getActiveTools: () => [...activeToolNames],
    // Mirror the real host: getAllTools() reports every registered tool,
    // including ones that are currently inactive. getActiveTools() reports
    // only the active subset.
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools: (names) => {
      activeToolNames.clear();
      for (const name of names) {
        if (tools.has(name)) activeToolNames.add(name);
      }
    },
    createReviewerRunner: () =>
      options.reviewerRunner ?? createTaskApprovingGoalUnmetReviewerRunner(),
  };
  const registerExternalTool = (config: SparkToolConfig): void => {
    tools.set(config.name, config);
    activeToolNames.add(config.name);
  };
  registerSparkEvidenceTool({
    registerTool: (config) => registerExternalTool(config as SparkToolConfig),
  });
  registerSparkMemoryTool({
    registerTool: (config) => registerExternalTool(config as SparkToolConfig),
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
  });
  registerSparkRolesTools({
    registerTool: (config) => registerExternalTool(config as SparkToolConfig),
  });
  registerSparkSessionTool({
    registerTool: (config) => registerExternalTool(config as SparkToolConfig),
  });
  registerSparkWorkflowTool({
    registerTool: (config) => registerExternalTool(config as SparkToolConfig),
  });
  piAskExtension(pi as never);
  sparkExtension(pi);
  return {
    tools,
    messages,
    customMessages,
    commands,
    shortcuts,
    eventHandlers,
    getActiveToolNames: () => [...activeToolNames],
    // Register a no-op tool and mark it active, simulating a tool contributed
    // by another extension (e.g. spark-cue's `bash`) so tests can verify Spark
    // goal toggling never silently re-activates externally disabled tools.
    registerActiveTool: (name: string) => {
      tools.set(name, {
        name,
        description: `synthetic ${name}`,
        parameters: { type: "object" },
        async execute() {
          return { content: [{ type: "text" as const, text: "" }] };
        },
      } as SparkToolConfig);
      activeToolNames.add(name);
    },
    setActiveTools: (names: string[]) => pi.setActiveTools(names),
    loopControl,
  };
}

function canonicalReportWorkInput(reproId: string): SparkReproWorkSummaryInput {
  const profile = {
    id: "minimum-complete",
    model: "minimum_complete" as const,
    compute: "optimizer" as const,
    steps: { completed: 1, target: 10 },
    topology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
  };
  return {
    reproId,
    title: "Minimum-complete alignment",
    stage: "alignment",
    target: {
      model: "minimum_complete",
      requiredSteps: 10,
      referenceStrategies: [],
      validationTopology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
    },
    profile,
    gates: [
      {
        id: "contract",
        title: "contract",
        stage: "contract",
        evidenceClass: "formal",
        status: "accepted",
        weight: 1,
        evidenceRefs: ["evidence:contract" as EvidenceRef],
      },
      {
        id: "reference",
        title: "reference",
        stage: "reference",
        evidenceClass: "formal",
        status: "accepted",
        weight: 1,
        evidenceRefs: ["evidence:reference" as EvidenceRef],
        profile,
        establishes: ["reference_ready"],
      },
      {
        id: "target",
        title: "target",
        stage: "target",
        evidenceClass: "formal",
        status: "accepted",
        weight: 1,
        evidenceRefs: ["evidence:target" as EvidenceRef],
        profile,
        establishes: ["target_ready"],
      },
      {
        id: "alignment",
        title: "alignment",
        stage: "alignment",
        evidenceClass: "formal",
        status: "open",
        weight: 1,
        evidenceRefs: [],
        profile,
      },
      {
        id: "delivery",
        title: "delivery",
        stage: "delivery",
        evidenceClass: "formal",
        status: "open",
        weight: 1,
        evidenceRefs: [],
      },
    ],
  };
}

function activeTestLoop(
  run: ReturnType<typeof registerSparkToolsForTest>,
  domain: "goal" | "loop" | "repro" | "workflow",
) {
  return [...run.loopControl.loops.values()].find(
    (loop) =>
      loop.status !== "stopped" &&
      (domain === "goal"
        ? Boolean(loop.binding.goalId)
        : domain === "repro"
          ? Boolean(loop.binding.reproId)
          : domain === "workflow"
            ? Boolean(loop.binding.workflowRunId)
            : !loop.binding.goalId && !loop.binding.reproId && !loop.binding.workflowRunId),
  );
}

async function tryConsumeSparkModeContext(
  run: ReturnType<typeof registerSparkToolsForTest>,
  ctx: TestSparkContext,
): Promise<string | undefined> {
  return tryConsumeSparkRuntimeContext(run, ctx, "spark-phase-context");
}

async function tryConsumeSparkRuntimeContext(
  run: ReturnType<typeof registerSparkToolsForTest>,
  ctx: TestSparkContext,
  customType: "spark-phase-context" | "spark-role-run-inbox",
): Promise<string | undefined> {
  for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
    const result = (await handler({}, ctx)) as
      | {
          message?: { customType?: string; content?: string; display?: boolean };
          messages?: Array<{ customType?: string; content?: string; display?: boolean }>;
        }
      | undefined;
    const message =
      result?.messages?.find((candidate) => candidate.customType === customType) ??
      (result?.message?.customType === customType ? result.message : undefined);
    if (message) {
      assert.equal(message.display, false);
      assert.ok(message.content);
      return message.content;
    }
  }
  return undefined;
}

async function executeSparkTool(
  tools: Map<string, SparkToolConfig>,
  name: string,
  ctx: TestSparkContext,
  params: Record<string, unknown>,
): Promise<SparkToolResult> {
  const tool = tools.get(name);
  assert.ok(tool, `missing Spark tool: ${name}`);
  return tool.execute(`call-${name}`, params, new AbortController().signal, () => undefined, ctx);
}

async function useOnlySparkProject(
  tools: Map<string, SparkToolConfig>,
  ctx: TestSparkContext,
): Promise<void> {
  await executeSparkTool(tools, "impl_use_project", ctx, { project: "Tool persistence" });
}

async function planAndClaimTask(
  tools: Map<string, SparkToolConfig>,
  ctx: TestSparkContext,
  input: {
    [key: string]: unknown;
    name?: string;
    title: string;
    description: string;
    kind?: string;
    roleRef?: string;
    plan: TaskPlan;
  },
): Promise<SparkToolResult> {
  await executeSparkTool(tools, "impl_plan_tasks", ctx, {
    tasks: [
      {
        name: input.name,
        title: input.title,
        description: input.description,
        kind: input.kind,
        roleRef: input.roleRef,
        plan: input.plan,
      },
    ],
  });
  const graph = await defaultTaskGraphStore(ctx.cwd).load();
  const task = graph
    ?.tasks()
    .find((candidate) =>
      input.name ? candidate.name === input.name : candidate.title === input.title,
    );
  assert.ok(task, `planned task not found for claim: ${input.name ?? input.title}`);
  return executeSparkTool(tools, "impl_claim_task", ctx, { taskRef: task.ref });
}

async function useOnlySparkProjectInExplicitPlanMode(
  tools: Map<string, SparkToolConfig>,
  ctx: TestSparkContext,
): Promise<void> {
  await useOnlySparkProject(tools, ctx);
  const statePath = currentProjectStatePath(ctx.cwd, ctx);
  let state: { projectRef?: string };
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as { projectRef?: string };
  } catch (error) {
    assert.fail(`expected valid current-project state JSON: ${String(error)}`);
  }
  assert.ok(state.projectRef);
}

function storeDirNameForTest(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-");
}

function reproScheduleSpy(
  ownerSessionId: string,
  scheduled: Parameters<SparkHostLoopContext["schedule"]>[0][],
): SparkHostLoopContext {
  return {
    loopId: "repro-schedule-spy",
    binding: { reproId: "repro-schedule-spy" },
    generation: 1,
    ownerSessionId,
    stateOwnerSessionId: ownerSessionId,
    async schedule(input) {
      scheduled.push(input);
      return input;
    },
    async stop(input) {
      return input;
    },
  };
}

function testSparkContext(cwd: string, sessionName: string): TestSparkContext {
  const sessionFile = join(cwd, ".pi-sessions", `${sessionName}.json`);
  const context: TestSparkContext = {
    cwd,
    sessionId: `session:${stableId(sessionFile)}`,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getLeafId: () => `${sessionName}-leaf`,
    },
    hasUI: true,
    notifications: [],
    ui: {
      notify(message, level) {
        context.notifications.push({ message, level });
      },
      setWidget: () => undefined,
      setStatus: () => undefined,
      setEditorText: (text) => {
        context.editorText = text;
      },
      confirm: async () => true,
      input: async () => context.inputValue,
      select: async () => context.selected,
    },
  };
  return context;
}

function createTestDriverControl(): TestSparkDaemonLoopControl {
  const loops = new Map<string, Awaited<ReturnType<SparkDaemonLoopControl["start"]>>["loop"]>();
  const ensuredOwners: Array<{ sessionId: string; cwd: string }> = [];
  const startInputs: Parameters<SparkDaemonLoopControl["start"]>[0][] = [];
  const observedAt = () => new Date().toISOString();
  const requireLoop = (loopId: string) => {
    const loop = loops.get(loopId);
    assert.ok(loop, `missing test daemon loop ${loopId}`);
    return loop;
  };
  return {
    loops,
    ensuredOwners,
    startInputs,
    async ensureOwnerSession(input) {
      ensuredOwners.push(input);
    },
    async start(input) {
      startInputs.push(input);
      for (const [loopId, loop] of loops) {
        if (loop.ownerSessionId === input.ownerSessionId && loopId !== input.loopId) {
          loops.set(loopId, { ...loop, status: "stopped", dueAt: undefined });
        }
      }
      const loop = {
        loopId: input.loopId ?? `loop:${loops.size + 1}`,
        binding: input.binding ?? {},
        ownerSessionId: input.ownerSessionId,
        status: "scheduled" as const,
        sessionLifetime:
          input.sessionLifetime ?? (input.continuity === "fresh" ? "driver_tick" : "driver"),
        continuity:
          input.continuity ?? (input.sessionLifetime === "driver_tick" ? "fresh" : "session"),
        generation: 1,
        policy: sparkLoopPolicySchema.parse(input.policy ?? {}),
        counters: sparkLoopCountersSchema.parse({}),
        dueAt: input.dueAt ?? observedAt(),
        attempt: 0,
        reason: input.reason,
      };
      loops.set(loop.loopId, loop);
      return { loop, observedAt: observedAt() };
    },
    async list(input) {
      return {
        loops: [...loops.values()].filter(
          (loop) =>
            (!input.loopId || loop.loopId === input.loopId) &&
            (!input.ownerSessionId || loop.ownerSessionId === input.ownerSessionId) &&
            (input.includeTerminal || loop.status !== "stopped"),
        ),
        observedAt: observedAt(),
      };
    },
    async stop(input) {
      const current = requireLoop(input.loopId);
      const loop = {
        ...current,
        status: "stopped" as const,
        dueAt: undefined,
        reason: input.reason,
      };
      loops.set(loop.loopId, loop);
      return { loop, observedAt: observedAt() };
    },
    async restart(input) {
      const current = requireLoop(input.loopId);
      const loop = {
        ...current,
        status: "scheduled" as const,
        dueAt: observedAt(),
        attempt: 0,
        reason: input.reason,
      };
      loops.set(loop.loopId, loop);
      return { loop, observedAt: observedAt() };
    },
    async wake(input) {
      const current = requireLoop(input.loopId);
      const loop = {
        ...current,
        status: "scheduled" as const,
        dueAt: observedAt(),
        reason: input.reason,
      };
      loops.set(loop.loopId, loop);
      return { loop, observedAt: observedAt() };
    },
    async schedule(input) {
      const current = requireLoop(input.loopId);
      const loop = {
        ...current,
        status: "scheduled" as const,
        dueAt: input.dueAt ?? new Date(Date.now() + Math.max(0, input.delayMs ?? 0)).toISOString(),
        reason: input.reason,
      };
      loops.set(loop.loopId, loop);
      return { loop, observedAt: observedAt() };
    },
  };
}

function installTimedOutAskInteraction(ctx: TestSparkContext): void {
  ctx.askReviewerFallbackAfterMs = 5;
  ctx.ui.interaction = async (request) => ({
    kind: "askFlow",
    requestId: request.requestId,
    status: "cancelled",
    metadata: { timedOut: true },
  });
}

function createTestRoleRunner(
  options: {
    status?: ExtensionRoleRunStatus;
    stdout?: string;
    stderr?: string;
    jsonEvents?: unknown[];
    waitForCancel?: boolean;
    inputControl?: boolean;
    deliveredInputs?: string[];
  } = {},
): ExtensionRoleRunner {
  return async (request) => {
    const signal = request.signal;
    const unregister =
      options.inputControl === false
        ? undefined
        : request.inputControl?.register({
            send: async (text) => {
              options.deliveredInputs?.push(text);
            },
          });
    try {
      if (options.waitForCancel && signal && !signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return testExtensionRoleRunResult(request, {
        ...options,
        status: request.signal?.aborted ? "cancelled" : options.status,
      });
    } finally {
      unregister?.();
    }
  };
}

function testExtensionRoleRunResult(
  request: ExtensionRoleRunRequest,
  options: {
    status?: ExtensionRoleRunStatus;
    stdout?: string;
    stderr?: string;
    jsonEvents?: unknown[];
  } = {},
): ExtensionRoleRunResult {
  const status = options.status ?? "succeeded";
  const outcome =
    status === "succeeded"
      ? {
          kind: "completed" as const,
          code: "test_role_completed",
          reason: "Test role completed its assigned contract",
        }
      : status === "cancelled"
        ? {
            kind: "cancelled" as const,
            code: "test_role_cancelled",
            reason: "Test role was cancelled",
          }
        : status === "failed"
          ? {
              kind: "failed" as const,
              code: "test_role_failed",
              reason: "Test role failed",
            }
          : undefined;
  return {
    record: {
      ...request.record,
      status,
      outcome,
      finishedAt: new Date().toISOString(),
    },
    outcome,
    stdout: options.stdout ?? "",
    stderr: options.stderr ?? "",
    jsonEvents: options.jsonEvents ?? [],
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(await predicate(), "timed out waiting for condition");
}

function ctxSessionKey(ctx: TestSparkContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  return `session:${stableId(sessionFile)}`;
}

function ctxSessionStoreScope(ctx: TestSparkContext): string {
  return ctxSessionKey(ctx)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");
}

function sessionTaskTodoPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "todos", `${ctxSessionStoreScope(ctx)}.json`);
}

function sessionIndependentTodoPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "session-todos", `${ctxSessionStoreScope(ctx)}.json`);
}

function sessionDirectoryPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "sessions", ctxSessionStoreScope(ctx));
}

function hiddenRoleRunInboxPath(cwd: string, ctx: TestSparkContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "hidden-role-run-inbox.json");
}

function currentProjectStatePath(cwd: string, ctx: TestSparkContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "state.json");
}

function projectTreeIndexPath(cwd: string): string {
  return join(cwd, ".spark", "projects", "index.json");
}

function projectTreeDirName(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-");
}

async function taskGraphSnapshotText(cwd: string): Promise<string> {
  const graph = await defaultTaskGraphStore(cwd).load();
  return JSON.stringify(graph?.snapshot() ?? null, null, 2);
}

function sessionGoalPath(cwd: string, ctx: TestSparkContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "goal.json");
}

function todoDisplayNumberPath(cwd: string, ctx: TestSparkContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "todo-display-numbers.json");
}

function toolText(result: SparkToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

function assertToolTextIsCompactSummary(result: SparkToolResult): void {
  const text = toolText(result).trimStart();
  assert.notEqual(text[0], "{");
  assert.notEqual(text[0], "[");
  assert.doesNotMatch(text, /\n\s+"[^"\n]+":/);
}

function largeLegacyRoleRunBody(runRef: RunRef, runName: string, paddingBytes: number) {
  return {
    record: {
      ref: runRef,
      roleRef: "role:builtin-worker",
      runName,
      instruction: "legacy instruction that should not be preserved in replacement metadata",
      status: "succeeded",
      startedAt: "2026-05-28T00:00:00.000Z",
      finishedAt: "2026-05-28T00:00:01.000Z",
    },
    stdout: `${"x".repeat(paddingBytes)}\ntail-marker ${runName}\n`,
    stderr: "",
    jsonEvents: [],
  };
}

test("repro experiment lint rejects placeholders and honors active item status", () => {
  const issuesFor = (
    title: string,
    status: "pending" | "in_progress" | "blocked" | "done" | "cancelled" | "deleted" = "pending",
  ) =>
    collectReproExperimentIssues([
      {
        name: "boundary",
        title: "Boundary experiment",
        description: "Exercise mechanical experiment lint boundaries.",
        plan: {
          ...executionReadyPlan("Exercise mechanical experiment lint boundaries"),
          items: [
            {
              id: "item-boundary",
              title,
              status,
              notes: [],
              evidenceRefs: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    ]);
  const rejected: Array<[string, "command" | "expected"]> = [
    ["command:; expected: exit code 0", "command"],
    ["script: TBD; expected: exit code 0", "command"],
    ["command: describe what to run; expected: exit code 0", "command"],
    ["command: determine later; expected: exit code 0", "command"],
    ["Use git history; expected: exit code 0", "command"],
    ["Review `documentation text`; expected: exit code 0", "command"],
    ["Inspect packages/spark-extension/src/index.ts; expected: exit code 0", "command"],
    ["packages/spark-extension/src/index.ts; expected: exit code 0", "command"],
    ["command: packages/spark-extension/src/index.ts; expected: exit code 0", "command"],
    ["command: pnpm test test/repro.test.ts; expected:", "expected"],
    ["command: pnpm test test/repro.test.ts; expected: observable", "expected"],
    ["command: pnpm test test/repro.test.ts; assert:", "expected"],
    ["command: pnpm test test/repro.test.ts; expected: TBD", "expected"],
    ["command: pnpm test test/repro.test.ts; expected: expected result", "expected"],
  ];
  for (const [title, field] of rejected) {
    assert.ok(
      issuesFor(title).some((issue) => issue.field === field),
      title,
    );
  }
  assert.deepEqual(
    issuesFor("command: pnpm test test/repro.test.ts; expected: exit code 0 and 3 tests passed"),
    [],
  );
  assert.deepEqual(issuesFor("script: packages/tools/probe.ts; expected: exit code 0"), []);
  assert.deepEqual(issuesFor("./tools/probe.sh --case x; expected: exit code 0"), []);
  for (const status of ["done", "cancelled", "deleted"] as const) {
    assert.deepEqual(issuesFor("command:; expected:", status), []);
  }
  for (const status of ["in_progress", "blocked"] as const) {
    assert.deepEqual(
      issuesFor("command:; expected:", status).map((issue) => issue.field),
      ["command", "expected"],
    );
  }
});

test("impl_plan_tasks enforces concrete experiments for the bound reproduce project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-experiment-plan-lint-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, {
      action: "start",
      objective: "Reproduce experiment planning behavior",
    });
    const initial = await readSessionRepro(dir, ctx);
    assert.ok(initial?.projectRef);
    const reproduceIndex = initial.stages.findIndex((stage) => stage.name === "target");
    assert.notEqual(reproduceIndex, -1);
    const materializedScaffold = await materializeReproStagePlan(dir, ctx, initial, "reference");
    const materializedReproduce = await materializeReproStagePlan(
      dir,
      ctx,
      { ...materializedScaffold.repro, currentStageIndex: reproduceIndex },
      "target",
    );
    await writeSessionRepro(
      dir,
      { ...materializedReproduce.repro, currentStageIndex: reproduceIndex },
      ctx,
    );

    const taskInput = (name: string, item: string) => ({
      name,
      title: "Run " + name + " experiment",
      description: "Execute a bounded repro experiment and retain objective evidence.",
      kind: "implement",
      status: "pending",
      plan: {
        ...executionReadyPlan("Run " + name + " experiment with retained evidence"),
        items: [{ title: item }],
      },
    });
    const boundTaskCount = () =>
      defaultTaskGraphStore(dir)
        .load()
        .then((graph) => graph?.tasks(initial.projectRef).length ?? 0);
    const initialCount = await boundTaskCount();

    const missingCommand = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      project: initial.projectRef,
      tasks: [taskInput("missing-command", "expected: exit code 0 and 3 matching rows")],
    });
    const commandDetails = missingCommand.details as {
      error?: string;
      issues?: Array<{ field?: string; task?: string; itemIndex?: number; itemId?: string }>;
    };
    assert.equal(commandDetails.error, "repro_experiment_not_concrete");
    assert.equal(commandDetails.issues?.[0]?.field, "command");
    assert.match(commandDetails.issues?.[0]?.task ?? "", /missing-command/u);
    assert.equal(commandDetails.issues?.[0]?.itemIndex, 0);
    assert.ok(commandDetails.issues?.[0]?.itemId);
    assert.equal(await boundTaskCount(), initialCount);

    const missingExpected = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      project: initial.projectRef,
      tasks: [taskInput("missing-expected", "command: pnpm test test/repro-experiment.test.ts")],
    });
    const expectedDetails = missingExpected.details as {
      error?: string;
      issues?: Array<{ field?: string; task?: string }>;
    };
    assert.equal(expectedDetails.error, "repro_experiment_not_concrete");
    assert.equal(expectedDetails.issues?.[0]?.field, "expected");
    assert.match(expectedDetails.issues?.[0]?.task ?? "", /missing-expected/u);
    assert.equal(await boundTaskCount(), initialCount);

    const accepted = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      project: initial.projectRef,
      tasks: [
        taskInput(
          "concrete-experiment",
          "command: pnpm test test/repro-experiment.test.ts; expected: exit code 0 and 3 tests passed",
        ),
      ],
    });
    assert.equal((accepted.details as { error?: string }).error, undefined);
    assert.match(toolText(accepted), /Planned tasks: created=1 updated=0/u);
    assert.equal(await boundTaskCount(), initialCount + 1);

    const store = defaultTaskGraphStore(dir);
    let otherProjectRef: ProjectRef | undefined;
    await store.update((graph) => {
      otherProjectRef = graph.createProject({
        title: "Unbound experiment project",
        description: "This project is not bound to the active repro.",
      }).ref;
    });
    assert.ok(otherProjectRef);
    const unbound = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      project: otherProjectRef,
      tasks: [
        taskInput(
          "unbound-project-task",
          "Inspect packages/spark-extension/src and validate the implementation evidence",
        ),
      ],
    });
    assert.equal((unbound.details as { error?: string }).error, undefined);
    assert.match(toolText(unbound), /Planned tasks: created=1 updated=0/u);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks(otherProjectRef).length, 1);

    const scaleIndex = initial.stages.findIndex((stage) => stage.name === "alignment");
    assert.notEqual(scaleIndex, -1);
    await writeSessionRepro(dir, { ...initial, currentStageIndex: scaleIndex }, ctx);
    const scaleCount = await boundTaskCount();
    const scaleRejected = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      project: initial.projectRef,
      tasks: [taskInput("scale-missing-command", "expected: exit code 0")],
    });
    assert.equal(
      (scaleRejected.details as { error?: string; stage?: string }).error,
      "repro_experiment_not_concrete",
    );
    assert.equal((scaleRejected.details as { stage?: string }).stage, "alignment");
    assert.equal(await boundTaskCount(), scaleCount);

    await writeSessionRepro(
      dir,
      { ...initial, status: "complete", currentStageIndex: reproduceIndex },
      ctx,
    );
    const completeAccepted = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      project: initial.projectRef,
      tasks: [
        taskInput(
          "complete-repro-task",
          "Inspect packages/spark-extension/src and validate implementation evidence",
        ),
      ],
    });
    assert.equal((completeAccepted.details as { error?: string }).error, undefined);

    await writeSessionRepro(dir, { ...initial, status: "active", currentStageIndex: 0 }, ctx);
    const otherStageAccepted = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      project: initial.projectRef,
      tasks: [
        taskInput(
          "setup-stage-task",
          "Inspect packages/spark-extension/src and validate setup evidence",
        ),
      ],
    });
    assert.equal((otherStageAccepted.details as { error?: string }).error, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repro command and tool start the loop with the canonical rendered prompt", async () => {
  const prompts: string[] = [];
  for (const entry of ["command", "tool"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-prompt-" + entry + "-"));
    try {
      await writeEmptySparkProject(dir);
      const ctx = testSparkContext(dir, entry);
      const run = registerSparkToolsForTest();
      if (entry === "command") {
        const command = run.commands.get("repro");
        assert.ok(command);
        await command.handler("start", ctx);
      } else {
        await executeSparkTool(run.tools, "repro", ctx, { action: "start" });
      }
      const started = run.loopControl.startInputs.at(-1);
      assert.ok(started?.binding?.reproId);
      assert.equal(typeof started?.prompt, "string");
      prompts.push(started.prompt);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1]);
});

test("repro start creates a generic project with one task per bound subgoal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-project-binding-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, {
      action: "start",
      objective: "Reproduce target logits with inspectable evidence",
    });

    const repro = await readSessionRepro(dir, ctx);
    assert.equal(repro?.version, 7);
    assert.ok(repro?.projectRef);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const project = graph.getProject(repro.projectRef);
    assert.equal(project.kind, "generic");
    assert.equal(project.kindState, undefined);
    const tasks = graph.tasks(project.ref);
    assert.equal(tasks.length, 26);
    assert.equal(
      tasks.every((task) => decideTaskPlanBeforeCreate(task).accepted),
      true,
    );
    assert.deepEqual(
      graph
        .readyTasks(project.ref)
        .map((task) => task.name)
        .sort(),
      [
        "competitor-baseline-availability-researched",
        "freeze-source-model-weight-data-contract",
        "trace-target-existing-path",
      ],
    );
    assert.equal(project.roadmap.items.length, 5);
    assert.equal(
      project.roadmap.items.reduce((count, item) => count + (item.taskRefs?.length ?? 0), 0),
      26,
    );
    assert.deepEqual(
      [
        ...new Set(
          repro.subgoals
            .map((subgoal) => subgoal.taskRef)
            .filter((taskRef): taskRef is TaskRef => !!taskRef),
        ),
      ].sort((left, right) => left.localeCompare(right)),
      tasks.map((task) => task.ref).sort(),
    );
    const persisted = JSON.parse(await readFile(sessionReproStorePath(dir, ctx), "utf8")) as {
      version: number;
      repro?: { projectRef?: string };
    };
    assert.equal(persisted.version, 7);
    assert.equal(persisted.repro?.projectRef, project.ref);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro stage blueprints materialize a complete dependency-valid task graph", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-stage-blueprints-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, {
      action: "start",
      objective: "Qualify a model reproduction through target scale",
    });
    let repro = await readSessionRepro(dir, ctx);
    if (!repro?.projectRef) throw new Error("missing project-backed repro");
    for (const stage of ["reference", "target", "alignment", "delivery"] as const) {
      repro = (await materializeReproStagePlan(dir, ctx, repro, stage)).repro;
    }

    const blueprints = Object.values(REPRO_STAGE_BLUEPRINTS);
    assert.deepEqual(
      blueprints.map((blueprint) => blueprint.stage),
      ["contract", "reference", "target", "alignment", "delivery"],
    );
    assert.equal(REPRO_STAGE_BLUEPRINTS.delivery.displayTitle, "Finalize");
    const blueprintTasks = blueprints.flatMap((blueprint) => blueprint.tasks);
    assert.equal(new Set(blueprintTasks.map((task) => task.id)).size, blueprintTasks.length);
    assert.equal(
      blueprints.every((blueprint) =>
        blueprint.tasks.every((task) =>
          blueprint.roadmaps.some((roadmap) => roadmap.key === task.roadmapKey),
        ),
      ),
      true,
    );

    const taskById = new Map(blueprintTasks.map((task) => [task.id, task]));
    for (const task of blueprintTasks) {
      assert.equal(
        task.dependsOn.every((dependency) => taskById.has(dependency)),
        true,
        `unknown dependency for ${task.id}`,
      );
    }
    assert.deepEqual(taskById.get("qualify-tp")?.dependsOn, [
      "revalidate-parent-determinism-and-checkpoint",
    ]);
    assert.deepEqual(taskById.get("qualify-ep")?.dependsOn, [
      "revalidate-parent-determinism-and-checkpoint",
    ]);
    assert.deepEqual(taskById.get("compose-tp-ep")?.dependsOn, ["qualify-tp", "qualify-ep"]);
    assert.deepEqual(taskById.get("compose-tp-ep-pp")?.dependsOn, [
      "compose-tp-ep",
      "qualify-pp-delta",
    ]);
    assert.deepEqual(taskById.get("join-s0-time-and-s2-structure")?.dependsOn, [
      "run-s0-p0-htarget",
      "bitwise-pass-20",
    ]);
    assert.equal(taskById.get("qualify-tp")?.executionPolicy.resources?.gpuCount, 2);
    assert.equal(taskById.get("qualify-ep")?.executionPolicy.resources?.gpuCount, 2);
    assert.equal(taskById.get("qualify-tp")?.roleRef, "role:extension-repro-distributed-runner");
    assert.equal(taskById.get("qualify-ep")?.roleRef, "role:extension-repro-distributed-runner");
    assert.equal(taskById.get("compose-tp-ep")?.executionPolicy.resources?.gpuCount, 4);
    assert.equal(taskById.get("compose-tp-ep-pp")?.executionPolicy.resources?.gpuCount, 8);
    assert.equal(
      taskById.get("performance-budget")?.executionPolicy.resources?.exclusiveNode,
      true,
    );
    assert.equal(
      taskById.get("performance-budget")?.roleRef,
      "role:extension-repro-performance-benchmarker",
    );
    assert.equal(
      blueprintTasks.every((task) => task.executionPolicy.maxAttempts === 2),
      true,
    );

    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const tasks = graph.tasks(repro.projectRef);
    assert.equal(tasks.length, blueprintTasks.length);
    assert.equal(
      tasks.every((task) => decideTaskPlanBeforeCreate(task).accepted),
      true,
    );
    assert.equal(
      tasks.every((task) => task.executionPolicy?.concurrencyKeys.length === 1),
      true,
    );
    assert.equal(repro.subgoals.length, blueprintTasks.length);
    assert.equal(
      repro.subgoals.every((subgoal) => typeof subgoal.taskRef === "string"),
      true,
    );
    assert.equal(
      new Set(repro.subgoals.map((subgoal) => subgoal.taskRef)).size,
      blueprintTasks.length,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro settle schedules the safe ready frontier at the default cadence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-settle-ready-frontier-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "ready-frontier") as TestSparkContext & {
      loop?: SparkHostLoopContext;
    };
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, { action: "start" });
    const repro = await readSessionRepro(dir, ctx);
    assert.ok(repro?.projectRef);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    assert.ok(graph.readyTasks(repro.projectRef).length > 0);

    const scheduled: Parameters<SparkHostLoopContext["schedule"]>[0][] = [];
    ctx.loop = reproScheduleSpy(ctx.sessionId, scheduled);
    await executeSparkTool(tools, "repro", ctx, { action: "settle" });

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.delayMs, 30_000);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro settle keeps a ten second cadence when any safe task run is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-settle-active-run-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "active-run") as TestSparkContext & {
      loop?: SparkHostLoopContext;
    };
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, { action: "start" });
    const repro = await readSessionRepro(dir, ctx);
    assert.ok(repro?.projectRef);
    const safeTaskRef = repro.subgoals.find(
      (subgoal) => subgoal.authority === "safe_local" && subgoal.taskRef,
    )?.taskRef;
    assert.ok(safeTaskRef);
    await defaultTaskGraphStore(dir).update((graph) => {
      graph.recordRun({
        ref: "run:repro-safe-active" as RunRef,
        projectRef: repro.projectRef!,
        taskRef: safeTaskRef,
        status: "running",
        startedAt: "2026-07-28T00:00:00.000Z",
        outputEvidenceRefs: [],
      });
      graph.recordRun({
        ref: "run:repro-safe-later-success" as RunRef,
        projectRef: repro.projectRef!,
        taskRef: safeTaskRef,
        status: "succeeded",
        startedAt: "2026-07-28T00:00:01.000Z",
        finishedAt: "2026-07-28T00:00:02.000Z",
        outputEvidenceRefs: [],
      });
    });
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    assert.ok(collectReproOrchestrationSnapshot(repro, graph).activeTaskRefs.includes(safeTaskRef));

    const scheduled: Parameters<SparkHostLoopContext["schedule"]>[0][] = [];
    ctx.loop = reproScheduleSpy(ctx.sessionId, scheduled);
    await executeSparkTool(tools, "repro", ctx, { action: "settle" });

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.delayMs, 10_000);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro settle leaves the driver dormant while awaiting owner ask authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-settle-awaiting-ask-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "awaiting-ask") as TestSparkContext & {
      loop?: SparkHostLoopContext;
    };
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, { action: "start" });
    const repro = await readSessionRepro(dir, ctx);
    assert.ok(repro?.projectRef);
    await writeSessionRepro(
      dir,
      {
        ...repro,
        subgoals: repro.subgoals.map((subgoal) => {
          if (subgoal.authority !== "safe_local") return subgoal;
          const { taskRef: _taskRef, ...unbound } = subgoal;
          return unbound;
        }),
      },
      ctx,
    );

    const scheduled: Parameters<SparkHostLoopContext["schedule"]>[0][] = [];
    ctx.loop = reproScheduleSpy(ctx.sessionId, scheduled);
    const settled = await executeSparkTool(tools, "repro", ctx, { action: "settle" });

    assert.equal(scheduled.length, 0);
    assert.equal(settled.details?.dormantReason, "awaiting_ask");
    assert.match(toolText(settled), /awaiting a canonical ask response.*Loop remains dormant/u);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro settle schedules a thirty second repair tick when bound ask tasks are terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-settle-terminal-ask-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "terminal-ask") as TestSparkContext & {
      loop?: SparkHostLoopContext;
    };
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, { action: "start" });
    const repro = await readSessionRepro(dir, ctx);
    assert.ok(repro?.projectRef);
    const safeSubgoal = repro.subgoals.find(
      (subgoal) => subgoal.authority === "safe_local" && subgoal.taskRef,
    );
    assert.ok(safeSubgoal);
    const taskRef = safeSubgoal.taskRef!;
    const askRepro = {
      ...repro,
      subgoals: repro.subgoals.map((subgoal) =>
        subgoal.id === safeSubgoal.id
          ? { ...subgoal, authority: "ask_decision" as const }
          : subgoal,
      ),
    };
    await writeSessionRepro(dir, askRepro, ctx);
    await defaultTaskGraphStore(dir).update((graph) => {
      graph.setTaskStatus(taskRef, "done");
    });
    const scheduled: Parameters<SparkHostLoopContext["schedule"]>[0][] = [];
    ctx.loop = reproScheduleSpy(ctx.sessionId, scheduled);
    const settled = await executeSparkTool(tools, "repro", ctx, { action: "settle" });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.delayMs, 30_000);
    assert.equal(settled.details?.dormantReason, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro orchestration excludes ask authority tasks from the dispatchable frontier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-frontier-ask-exclusion-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "ask-exclusion");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, { action: "start" });
    const repro = await readSessionRepro(dir, ctx);
    assert.ok(repro?.projectRef);
    const safeSubgoal = repro.subgoals.find(
      (subgoal) => subgoal.authority === "safe_local" && subgoal.taskRef,
    );
    assert.ok(safeSubgoal);
    const askTaskRef = safeSubgoal.taskRef!;
    const withAskAuthority = {
      ...repro,
      subgoals: repro.subgoals.map((subgoal) =>
        subgoal.ref === safeSubgoal.ref
          ? { ...subgoal, authority: "ask_decision" as const }
          : subgoal,
      ),
    };
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);

    const snapshot = collectReproOrchestrationSnapshot(withAskAuthority, graph);
    assert.equal(snapshot.dispatchableTaskRefs.includes(askTaskRef), false);
    assert.equal(snapshot.excludedAskTaskRefs.includes(askTaskRef), true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro tool exposes Task-bound planning without a delegate action", () => {
  const tools = new Map<string, SparkToolConfig>();
  registerSparkReproTool(
    (config) => {
      tools.set(config.name, config as SparkToolConfig);
    },
    { loopControl: createTestDriverControl() },
  );
  const tool = tools.get("repro");
  assert.ok(tool);
  const publicContract = JSON.stringify({
    description: tool.description,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
  });
  assert.doesNotMatch(publicContract, /subgoal\.assignment|subgoal\.receipt|action=delegate/u);
  assert.match(publicContract, /taskRef/u);
});

/* Historical delegate/receipt integration tests retired with the protocol.
test("repro delegation persists the assignment before dispatch and completes only a matching receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-subgoal-delegation-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "owner");
    const initial = createSparkSessionRepro(ctx.sessionId);
    const subgoal = initial.subgoals.find((candidate) => candidate.authority === "safe_local");
    if (!subgoal) throw new Error("missing safe_local repro subgoal");
    await writeSessionRepro(dir, initial, ctx);
    const delegatedEvidence = await defaultEvidenceStore(dir).put({
      kind: "record",
      title: "Delegated subgoal proof",
      format: "json",
      body: { passed: true },
      provenance: { producer: "spark" },
    });
    const delegatedEvidenceRef = delegatedEvidence.ref as EvidenceRef;

    const tools = new Map<string, SparkToolConfig>();
    let persistedAtDispatch: string | undefined;
    let dispatchedAssignment:
      | Parameters<
          NonNullable<Parameters<typeof registerSparkReproTool>[1]["sendSessionRequest"]>
        >[0]["assignment"]
      | undefined;
    registerSparkReproTool(
      (config) => {
        tools.set(config.name, config as SparkToolConfig);
      },
      {
        loopControl: createTestDriverControl(),
        async sendSessionRequest(input) {
          dispatchedAssignment = input.assignment;
          persistedAtDispatch = await readFile(sessionReproStorePath(dir, ctx), "utf8");
          return encodeSubgoalReceipt({
            subgoalRef: input.assignment.subgoalRef,
            status: "done",
            planRevision: input.assignment.planRevision,
            definitionDigest: input.assignment.definitionDigest,
            evidenceRefs: [delegatedEvidenceRef],
          });
        },
      },
    );

    const result = await executeSparkTool(tools, "repro", ctx, {
      action: "delegate",
      stepId: subgoal.id,
      targetSessionId: "session-executor",
    });
    assert.match(toolText(result), /receipt verified and completed/u);
    if (!dispatchedAssignment) throw new Error("missing dispatched assignment");
    assert.equal(dispatchedAssignment.schema, "spark.subgoal.assignment/v1");
    assert.equal(dispatchedAssignment.ownerSessionId, ctx.sessionId);
    assert.equal(dispatchedAssignment.subgoalRef, subgoal.ref);
    assert.equal(dispatchedAssignment.planRevision, subgoal.planRevision);
    assert.equal(dispatchedAssignment.definitionDigest, subgoalDefinitionDigest(subgoal));

    if (!persistedAtDispatch) throw new Error("dispatch must observe the persisted delegation");
    const dispatchEnvelope = JSON.parse(persistedAtDispatch) as {
      repro?: {
        subgoals?: Array<{
          ref?: string;
          status?: string;
          delegation?: {
            sessionId?: string;
            planRevision?: number;
            definitionDigest?: string;
            delegatedAt?: string;
          };
        }>;
      };
    };
    const delegated = dispatchEnvelope.repro?.subgoals?.find(
      (candidate) => candidate.ref === subgoal.ref,
    );
    assert.equal(delegated?.status, "in_progress");
    assert.deepEqual(delegated?.delegation, {
      sessionId: "session-executor",
      planRevision: subgoal.planRevision,
      definitionDigest: subgoalDefinitionDigest(subgoal),
      delegatedAt: dispatchedAssignment.assignedAt,
    });

    const completed = (await readSessionRepro(dir, ctx))?.subgoals.find(
      (candidate) => candidate.ref === subgoal.ref,
    );
    assert.equal(completed?.status, "done");
    assert.deepEqual(completed?.evidenceRefs, [delegatedEvidenceRef]);
    assert.equal(completed?.verification?.verdict, "Pass");
    assert.equal(completed?.delegation?.sessionId, "session-executor");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro delegation keeps persisted work pending when receipt revision or digest mismatches", async () => {
  for (const mismatch of ["revision", "digest"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `spark-repro-subgoal-${mismatch}-repair-`));
    try {
      await writeEmptySparkProject(dir);
      const ctx = testSparkContext(dir, `owner-${mismatch}`);
      const initial = createSparkSessionRepro(ctx.sessionId);
      const subgoal = initial.subgoals.find((candidate) => candidate.authority === "safe_local");
      if (!subgoal) throw new Error("missing safe_local repro subgoal");
      await writeSessionRepro(dir, initial, ctx);

      const tools = new Map<string, SparkToolConfig>();
      registerSparkReproTool(
        (config) => {
          tools.set(config.name, config as SparkToolConfig);
        },
        {
          loopControl: createTestDriverControl(),
          async sendSessionRequest(input) {
            return encodeSubgoalReceipt({
              subgoalRef: input.assignment.subgoalRef,
              status: "done",
              planRevision:
                mismatch === "revision"
                  ? input.assignment.planRevision + 1
                  : input.assignment.planRevision,
              definitionDigest:
                mismatch === "digest"
                  ? "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                  : input.assignment.definitionDigest,
              evidenceRefs: ["evidence:delegated-proof" as EvidenceRef],
            });
          },
        },
      );

      const result = await executeSparkTool(tools, "repro", ctx, {
        action: "delegate",
        stepId: subgoal.ref,
        targetSessionId: "session-executor",
      });
      assert.match(toolText(result), /Repair:/u);
      assert.equal(result.details?.verdict, "Repair");
      assert.match(
        toolText(result),
        mismatch === "revision" ? /plan revision/u : /definitionDigest/u,
      );

      const persisted = (await readSessionRepro(dir, ctx))?.subgoals.find(
        (candidate) => candidate.ref === subgoal.ref,
      );
      assert.equal(persisted?.status, "in_progress");
      assert.equal(persisted?.verification, undefined);
      assert.equal(persisted?.delegation?.sessionId, "session-executor");
      assert.equal(persisted?.delegation?.planRevision, subgoal.planRevision);
      assert.equal(persisted?.delegation?.definitionDigest, subgoalDefinitionDigest(subgoal));
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
});

test("repro delegation rejects decision authorities in the owner main session", async () => {
  for (const authority of ["ask_decision", "ask_approval"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `spark-repro-subgoal-${authority}-owner-`));
    try {
      await writeEmptySparkProject(dir);
      const ctx = testSparkContext(dir, `owner-${authority}`);
      const initial = createSparkSessionRepro(ctx.sessionId);
      const subgoal = initial.subgoals.find((candidate) => candidate.authority === "safe_local");
      if (!subgoal) throw new Error("missing safe_local repro subgoal");
      await writeSessionRepro(
        dir,
        {
          ...initial,
          subgoals: initial.subgoals.map((candidate) =>
            candidate.ref === subgoal.ref ? { ...candidate, authority } : candidate,
          ),
        },
        ctx,
      );

      let dispatched = false;
      const tools = new Map<string, SparkToolConfig>();
      registerSparkReproTool(
        (config) => {
          tools.set(config.name, config as SparkToolConfig);
        },
        {
          loopControl: createTestDriverControl(),
          async sendSessionRequest() {
            dispatched = true;
            throw new Error("decision authority must not dispatch");
          },
        },
      );

      await assert.rejects(
        () =>
          executeSparkTool(tools, "repro", ctx, {
            action: "delegate",
            stepId: subgoal.id,
            targetSessionId: "session-executor",
          }),
        /owner 主会话/u,
      );
      assert.equal(dispatched, false);
      const persisted = (await readSessionRepro(dir, ctx))?.subgoals.find(
        (candidate) => candidate.ref === subgoal.ref,
      );
      assert.equal(persisted?.status, "pending");
      assert.equal(persisted?.delegation, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
});

test("repro delegation rejects missing evidence before owner completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-subgoal-missing-evidence-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "owner-missing-evidence");
    const initial = createSparkSessionRepro(ctx.sessionId);
    const subgoal = initial.subgoals.find((candidate) => candidate.authority === "safe_local");
    if (!subgoal) throw new Error("missing safe_local repro subgoal");
    await writeSessionRepro(dir, initial, ctx);

    const tools = new Map<string, SparkToolConfig>();
    registerSparkReproTool(
      (config) => {
        tools.set(config.name, config as SparkToolConfig);
      },
      {
        loopControl: createTestDriverControl(),
        async sendSessionRequest(input) {
          return encodeSubgoalReceipt({
            subgoalRef: input.assignment.subgoalRef,
            status: "done",
            planRevision: input.assignment.planRevision,
            definitionDigest: input.assignment.definitionDigest,
            evidenceRefs: ["evidence:missing-delegated-proof" as EvidenceRef],
          });
        },
      },
    );

    const result = await executeSparkTool(tools, "repro", ctx, {
      action: "delegate",
      stepId: subgoal.id,
      targetSessionId: "session-executor",
    });
    assert.match(toolText(result), /Repair: delegated evidence not found/u);
    assert.equal(result.details?.verdict, "Repair");
    const persisted = (await readSessionRepro(dir, ctx))?.subgoals.find(
      (candidate) => candidate.ref === subgoal.ref,
    );
    assert.equal(persisted?.status, "in_progress");
    assert.equal(persisted?.verification, undefined);
    assert.equal(persisted?.delegation?.sessionId, "session-executor");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("repro delegation turns malformed receipts and corrupt evidence reads into Repair", async () => {
  for (const failure of ["malformed-receipt", "corrupt-evidence"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `spark-repro-subgoal-${failure}-`));
    try {
      await writeEmptySparkProject(dir);
      const ctx = testSparkContext(dir, `owner-${failure}`);
      const initial = createSparkSessionRepro(ctx.sessionId);
      const subgoal = initial.subgoals.find((candidate) => candidate.authority === "safe_local");
      if (!subgoal) throw new Error("missing safe_local repro subgoal");
      await writeSessionRepro(dir, initial, ctx);

      const corruptEvidenceRef = "evidence:corrupt-delegated-proof" as EvidenceRef;
      if (failure === "corrupt-evidence") {
        const corruptPath = defaultEvidenceStore(dir).pathFor(corruptEvidenceRef);
        await mkdir(dirname(corruptPath), { recursive: true });
        await writeFile(corruptPath, "{not valid evidence metadata", "utf8");
      }

      const tools = new Map<string, SparkToolConfig>();
      registerSparkReproTool(
        (config) => {
          tools.set(config.name, config as SparkToolConfig);
        },
        {
          loopControl: createTestDriverControl(),
          async sendSessionRequest(input) {
            return failure === "malformed-receipt"
              ? { schema: "spark.subgoal.receipt/v0", subgoalRef: input.assignment.subgoalRef }
              : encodeSubgoalReceipt({
                  subgoalRef: input.assignment.subgoalRef,
                  status: "done",
                  planRevision: input.assignment.planRevision,
                  definitionDigest: input.assignment.definitionDigest,
                  evidenceRefs: [corruptEvidenceRef],
                });
          },
        },
      );

      const result = await executeSparkTool(tools, "repro", ctx, {
        action: "delegate",
        stepId: subgoal.id,
        targetSessionId: "session-executor",
      });
      assert.match(toolText(result), /Repair:/u);
      assert.equal(result.details?.verdict, "Repair");
      assert.match(
        toolText(result),
        failure === "malformed-receipt"
          ? /invalid delegated receipt/u
          : /delegated evidence validation failed/u,
      );
      const persisted = (await readSessionRepro(dir, ctx))?.subgoals.find(
        (candidate) => candidate.ref === subgoal.ref,
      );
      assert.equal(persisted?.status, "in_progress");
      assert.equal(persisted?.verification, undefined);
      assert.equal(persisted?.delegation?.sessionId, "session-executor");
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
});
*/

test("repro advance materializes the target stage blueprint before advancing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repro-advance-planning-blocker-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "repro", ctx, { action: "start" });

    const repro = await readSessionRepro(dir, ctx);
    if (!repro) throw new Error("missing active repro");
    const setupSteps = repro.plan.steps.filter((step) => step.stage === "contract");
    let completed = repro;
    for (const step of setupSteps) {
      const evidenceRef = `evidence:${step.id}` as EvidenceRef;
      const updated = updateReproStep(completed, step.id, {
        status: "done",
        evidenceRefs: [evidenceRef],
        verifier: {
          verdict: "Pass",
          planRevision:
            completed.subgoals.find((subgoal) => subgoal.id === step.id)?.planRevision ??
            completed.plan.currentRevision,
          stepId: step.id,
          definitionDigest: stepDefinitionDigest(step),
          proofKind: step.authority === "safe_local" ? "evidence" : "decision",
          evidenceRefs: [evidenceRef],
          verifiedDoneWhen: step.doneWhen,
          ...(step.authority === "safe_local"
            ? {}
            : {
                askRequestHash: "setup-request",
                acceptedAnswerHash: "setup-answer",
                selectedValues: ["approved"],
              }),
        },
      });
      if (!updated) throw new Error(`missing setup step ${step.id}`);
      completed = updated;
    }
    await writeSessionRepro(
      dir,
      {
        ...completed,
        stages: completed.stages.map((stage) =>
          stage.name === "contract"
            ? {
                ...stage,
                acceptance: stage.acceptance.map((requirement) =>
                  requirement.kind === "evidence"
                    ? { ...requirement, evidenceRefs: ["evidence:setup-complete"] }
                    : requirement.kind === "decision"
                      ? {
                          ...requirement,
                          decisionRef: "evidence:setup-decision",
                          selectedValue: "approved",
                        }
                      : {
                          ...requirement,
                          command: "pnpm test",
                          resultRef: "evidence:setup-validation",
                          passed: true,
                        },
                ),
              }
            : stage,
        ),
        subgoals: completed.subgoals.filter((subgoal) => subgoal.stage !== "reference"),
      },
      ctx,
    );

    const advanced = await executeSparkTool(tools, "repro", ctx, { action: "advance" });
    assert.match(toolText(advanced), /Stage advanced to: Reference/u);
    const afterAdvance = await readSessionRepro(dir, ctx);
    assert.equal(afterAdvance?.stages[afterAdvance.currentStageIndex]?.name, "reference");
    const scaffoldSubgoals = afterAdvance?.subgoals.filter(
      (subgoal) => subgoal.stage === "reference",
    );
    assert.ok(scaffoldSubgoals && scaffoldSubgoals.length > 8);
    assert.equal(
      scaffoldSubgoals.every((subgoal) => typeof subgoal.taskRef === "string"),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
