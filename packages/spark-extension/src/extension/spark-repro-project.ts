import {
  nowIso,
  stableId,
  type ProjectRef,
  type RoadmapItem,
  type TaskRef,
} from "@zendev-lab/spark-core";
import {
  sparkSessionOwnerKey,
  sparkStateCwd,
  type SparkSessionContext,
} from "@zendev-lab/spark-loop";
import {
  collectNonConcreteTaskIssues,
  decideTaskPlanBeforeCreate,
  defaultTaskGraphStore,
  normalizeTaskPlan,
  type TaskPlanInput,
} from "@zendev-lab/spark-tasks";
import { applyRoadmapHintsToTaskPlanInput } from "../flows/roadmap-flow.ts";
import {
  createSparkSessionRepro,
  reproProgressDigest,
  writeSessionRepro,
  type SparkSessionRepro,
} from "./spark-session-repro.ts";
import { saveCurrentProjectRef } from "./session-state.ts";
import { initialReproProjectTasks, reproProjectTitle } from "./spark-repro-project-tasks.ts";

interface ReproProjectBindingResult {
  repro: SparkSessionRepro;
  projectRef: ProjectRef;
  taskRefs: TaskRef[];
  readyTaskRefs: TaskRef[];
}

const SETUP_TASK_REFS_BY_SUBGOAL = new Map<string, string[]>([
  ["competitor-baseline-availability-researched", ["baseline-availability"]],
  ["baseline-construction-strategy-approved", ["baseline-strategy"]],
  ["implementation-landscape-researched", ["implementation-landscape"]],
  ["alignment-paths-researched", ["alignment-paths"]],
  ["implementation-strategy-approved", ["implementation-alignment-strategy"]],
  ["alignment-strategy-approved", ["implementation-alignment-strategy"]],
]);

export async function createProjectBackedSessionRepro(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  input: { objective?: string; existing?: SparkSessionRepro } = {},
): Promise<ReproProjectBindingResult> {
  const existing = input.existing;
  if (existing?.projectRef) {
    return {
      repro: existing,
      projectRef: existing.projectRef,
      taskRefs: [...new Set(existing.subgoals.flatMap((subgoal) => subgoal.taskRefs))],
      readyTaskRefs: [],
    };
  }
  const repro = existing ?? createSparkSessionRepro(sparkSessionOwnerKey(ctx), undefined, input);
  const store = defaultTaskGraphStore(sparkStateCwd(cwd, ctx));
  const { result } = await store.update((graph): ReproProjectBindingResult => {
    const objective = repro.goalContract.objective;
    const project = graph.createProject({
      title: reproProjectTitle(objective),
      description: `Evidence-backed reproduction project for: ${objective}`,
      purpose:
        "Research the reference baseline, resolve implementation and alignment decisions, run typed experiments, and deliver inspectable reproduction evidence.",
      outputLanguage: "zh",
    });
    const roadmapItem = createSetupRoadmapItem(repro, project.ref);
    graph.replaceProjectRoadmap(project.ref, {
      ...project.roadmap,
      activeItemRef: roadmapItem.ref,
      items: [roadmapItem],
      updatedAt: roadmapItem.updatedAt!,
    });

    const taskDefinitions = initialReproProjectTasks(repro, roadmapItem);
    const taskInputs: TaskPlanInput[] = taskDefinitions.map((task) =>
      applyRoadmapHintsToTaskPlanInput(
        {
          name: task.name,
          title: task.title,
          description: task.description,
          kind: task.kind,
          roleRef: task.roleRef,
          dependsOn: task.dependsOn,
          plan: normalizeTaskPlan(task.plan, task.description, task.title),
        },
        roadmapItem,
      ),
    );
    const concreteIssues = collectNonConcreteTaskIssues(taskInputs);
    if (concreteIssues.length > 0) {
      throw new Error(
        `repro initial tasks are not concrete: ${concreteIssues.map((issue) => `@${issue.name}: ${issue.message}`).join("; ")}`,
      );
    }
    const planned = graph.planTasks(project.ref, taskInputs);
    const decisions = planned.created.map((task) => decideTaskPlanBeforeCreate(task));
    const rejectedIndex = decisions.findIndex((decision) => !decision.accepted);
    if (rejectedIndex >= 0) {
      const task = planned.created[rejectedIndex]!;
      const decision = decisions[rejectedIndex]!;
      throw new Error(`repro initial task plan not ready: @${task.name}: ${decision.summary}`);
    }
    if (planned.created.length !== 5 || decisions.length !== 5) {
      throw new Error(
        `repro start must create 5 readiness-checked tasks; created ${planned.created.length}`,
      );
    }
    const taskRefs = planned.created.map((task) => task.ref);
    graph.attachRoadmapItemTaskRefs(project.ref, roadmapItem.ref, taskRefs);
    const readyTaskRefs = graph.readyTasks(project.ref).map((task) => task.ref);
    if (readyTaskRefs.length !== 3) {
      throw new Error(`repro start requires 3 ready frontier tasks; found ${readyTaskRefs.length}`);
    }
    const refsByName = new Map(planned.created.map((task) => [task.name, task.ref]));
    const boundRepro = bindProjectAndTasks(repro, project.ref, refsByName);
    return { repro: boundRepro, projectRef: project.ref, taskRefs, readyTaskRefs };
  });
  await writeSessionRepro(cwd, result.repro, ctx);
  await saveCurrentProjectRef(cwd, ctx, result.projectRef);
  return result;
}

function bindProjectAndTasks(
  repro: SparkSessionRepro,
  projectRef: ProjectRef,
  refsByName: ReadonlyMap<string, TaskRef>,
): SparkSessionRepro {
  const timestamp = nowIso();
  const bound: SparkSessionRepro = {
    ...repro,
    projectRef,
    subgoals: repro.subgoals.map((subgoal) => {
      const names = SETUP_TASK_REFS_BY_SUBGOAL.get(subgoal.id) ?? [];
      const taskRefs = names
        .map((name) => refsByName.get(name))
        .filter((ref): ref is TaskRef => !!ref);
      return taskRefs.length > 0 ? { ...subgoal, taskRefs, updatedAt: timestamp } : subgoal;
    }),
    updatedAt: timestamp,
  };
  return {
    ...bound,
    stopGuard: { ...bound.stopGuard, lastProgressDigest: reproProgressDigest(bound) },
  };
}

function createSetupRoadmapItem(repro: SparkSessionRepro, projectRef: ProjectRef): RoadmapItem {
  const timestamp = nowIso();
  return {
    ref: `roadmap-item:repro-setup-${stableId(`${projectRef}:${repro.reproId}`)}`,
    title: "Setup research and strategy",
    status: "active",
    objective: `Establish a runnable baseline and approved implementation/alignment path for ${repro.goalContract.objective}`,
    scope: ["setup stage", "reference baseline", "implementation reuse", "alignment strategy"],
    constraints: [
      "Do not invent a baseline when the repository or environment cannot provide one",
      "Owner session retains canonical decision authority",
    ],
    successCriteria: [
      "Artifact report records 3 independent research task refs for baseline, implementation, and alignment findings",
      "Reviewer artifact records 2 strategy decision matrices with explicit ready/not-ready verdicts",
    ],
    evidenceRequired: [
      "Artifact report containing source file paths, command output with exit codes, and explicit decision options",
    ],
    evidenceRefs: [],
    openQuestions: [],
    askRefs: [],
    taskRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
