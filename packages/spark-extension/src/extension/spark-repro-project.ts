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
  type TaskGraph,
  type TaskPlanInput,
} from "@zendev-lab/spark-tasks";
import {
  createSparkSessionRepro,
  reproProgressDigest,
  reviseReproPlan,
  writeSessionRepro,
  type SparkReproStageName,
  type SparkSessionRepro,
} from "./spark-session-repro.ts";
import { saveCurrentProjectRef } from "./session-state.ts";
import { reproStageBlueprint, type ReproTaskBlueprint } from "./spark-repro-stage-blueprints.ts";

interface ReproProjectBindingResult {
  repro: SparkSessionRepro;
  projectRef: ProjectRef;
  taskRefs: TaskRef[];
  readyTaskRefs: TaskRef[];
}

function reproProjectTitle(objective: string): string {
  const compact = objective.replace(/\s+/g, " ").trim();
  return `Repro: ${compact.length > 72 ? `${compact.slice(0, 69)}...` : compact}`;
}

export async function createProjectBackedSessionRepro(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  input: { objective?: string; reproId?: string; existing?: SparkSessionRepro } = {},
): Promise<ReproProjectBindingResult> {
  const existing = input.existing;
  if (existing?.projectRef) {
    return {
      repro: existing,
      projectRef: existing.projectRef,
      taskRefs: [
        ...new Set(
          existing.subgoals
            .map((subgoal) => subgoal.taskRef)
            .filter((ref): ref is TaskRef => !!ref),
        ),
      ],
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
    const materialized = materializeStageInGraph(graph, repro, project.ref, "contract");
    const taskRefs = materialized.taskRefs;
    const readyTaskRefs = graph.readyTasks(project.ref).map((task) => task.ref);
    if (readyTaskRefs.length === 0) {
      throw new Error("repro start requires a non-empty ready frontier");
    }
    return { repro: materialized.repro, projectRef: project.ref, taskRefs, readyTaskRefs };
  });
  await writeSessionRepro(cwd, result.repro, ctx);
  await saveCurrentProjectRef(cwd, ctx, result.projectRef);
  return result;
}

export async function materializeReproStagePlan(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  repro: SparkSessionRepro,
  stage: SparkReproStageName,
): Promise<ReproProjectBindingResult> {
  if (!repro.projectRef) throw new Error("Repro Stage planning requires a bound Project");
  const store = defaultTaskGraphStore(sparkStateCwd(cwd, ctx));
  const { result } = await store.update(
    (graph): ReproProjectBindingResult => {
      const materialized = materializeStageInGraph(graph, repro, repro.projectRef!, stage);
      const readyTaskRefs = graph.readyTasks(repro.projectRef).map((task) => task.ref);
      return {
        repro: materialized.repro,
        projectRef: repro.projectRef!,
        taskRefs: materialized.taskRefs,
        readyTaskRefs,
      };
    },
    { createIfMissing: false },
  );
  await writeSessionRepro(cwd, result.repro, ctx);
  return result;
}

function materializeStageInGraph(
  graph: TaskGraph,
  repro: SparkSessionRepro,
  projectRef: ProjectRef,
  stage: SparkReproStageName,
): { repro: SparkSessionRepro; taskRefs: TaskRef[] } {
  const blueprint = reproStageBlueprint(stage);
  const timestamp = nowIso();
  const project = graph.getProject(projectRef);
  const roadmapItems = blueprint.roadmaps.map(
    (item, index): RoadmapItem => ({
      ref: `roadmap-item:repro-${stage}-${stableId(`${projectRef}:${repro.reproId}:${item.key}`)}`,
      title: item.title,
      status: index === 0 ? "active" : "pending",
      objective: `${item.objective} Target: ${repro.goalContract.objective}`,
      scope: item.scope,
      constraints: [
        "Treat only inspectable evidence as completion proof",
        "Keep external writes and material owner decisions behind canonical Ask authority",
      ],
      successCriteria: item.successCriteria,
      evidenceRequired: item.evidenceRequired,
      evidenceRefs: [],
      openQuestions: [],
      askRefs: [],
      taskRefs: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  const newRefs = new Set(roadmapItems.map((item) => item.ref));
  const priorItems = project.roadmap.items
    .filter((item) => !newRefs.has(item.ref))
    .map((item) =>
      item.status === "active" ? { ...item, status: "done" as const, updatedAt: timestamp } : item,
    );
  graph.replaceProjectRoadmap(projectRef, {
    ...project.roadmap,
    title: `Repro Stage Roadmap: ${blueprint.displayTitle}`,
    status: "active",
    activeItemRef: roadmapItems[0]?.ref,
    items: [...priorItems, ...roadmapItems],
    updatedAt: timestamp,
  });
  const roadmapByKey = new Map(
    blueprint.roadmaps.map((item, index) => [item.key, roadmapItems[index]!]),
  );
  const taskInputs = blueprint.tasks.map((definition) =>
    taskPlanInput(definition, roadmapByKey.get(definition.roadmapKey)!),
  );
  assertConcreteStageTasks(taskInputs, stage);
  const planned = graph.planTasks(projectRef, taskInputs);
  const decisions = [...planned.created, ...planned.updated].map((plannedTask) =>
    decideTaskPlanBeforeCreate(plannedTask),
  );
  const rejectedIndex = decisions.findIndex((decision) => !decision.accepted);
  if (rejectedIndex >= 0) {
    const plannedTask = [...planned.created, ...planned.updated][rejectedIndex]!;
    throw new Error(
      `repro ${stage} task plan not ready: @${plannedTask.name}: ${decisions[rejectedIndex]!.summary}`,
    );
  }
  const refsByName = new Map(
    graph.tasks(projectRef).map((plannedTask) => [plannedTask.name, plannedTask.ref]),
  );
  for (const [roadmapKey, roadmapItem] of roadmapByKey) {
    graph.attachRoadmapItemTaskRefs(
      projectRef,
      roadmapItem.ref,
      blueprint.tasks
        .filter((definition) => definition.roadmapKey === roadmapKey)
        .map((definition) => refsByName.get(definition.id)!)
        .filter((ref): ref is TaskRef => !!ref),
    );
  }
  const revised = reviseReproPlan(
    { ...repro, projectRef },
    {
      reason: `Materialize deterministic ${stage} Stage blueprint`,
      subgoals: blueprint.tasks.map((definition) => ({
        id: definition.id,
        stage,
        goal: definition.goal,
        doneWhen: definition.doneWhen,
        evidenceRequired: definition.evidenceRequired,
        authority: definition.authority,
        ...(definition.dependsOn.length > 0 ? { dependsOn: definition.dependsOn } : {}),
        taskRef: refsByName.get(definition.id)!,
      })),
    },
  );
  const bound: SparkSessionRepro = {
    ...revised,
    updatedAt: timestamp,
  };
  return {
    repro: {
      ...bound,
      stopGuard: { ...bound.stopGuard, lastProgressDigest: reproProgressDigest(bound) },
    },
    taskRefs: blueprint.tasks
      .map((definition) => refsByName.get(definition.id)!)
      .filter((ref): ref is TaskRef => !!ref),
  };
}

function taskPlanInput(definition: ReproTaskBlueprint, roadmapItem: RoadmapItem): TaskPlanInput {
  return {
    name: definition.id,
    title: definition.title,
    description: definition.description,
    kind: definition.kind,
    roleRef: definition.roleRef,
    executionPolicy: definition.executionPolicy,
    dependsOn: definition.dependsOn,
    plan: normalizeTaskPlan(
      {
        objective: definition.goal,
        contextRefs: [roadmapItem.ref],
        constraints: [
          "Stay within the bound Subgoal and do not mutate another Project Task",
          "Preserve commands, exit codes, source refs, configs, and immutable Evidence refs",
        ],
        nonGoals: [
          "Treating agent narration as evidence",
          "Advancing the Subgoal without its configured verifier",
        ],
        successCriteria: definition.doneWhen.map(
          (criterion) => `Evidence record and checker output verify: ${criterion}`,
        ),
        evidenceRequired: definition.evidenceRequired.map(
          (evidence) => `Evidence record containing: ${evidence}`,
        ),
        steps: [
          `Execute ${definition.title} against the frozen Stage inputs and record the observable result.`,
          "Store the required evidence and report the bounded Task outcome without promoting the Subgoal.",
        ],
        openQuestions: [],
        askRefs: [],
        riskLevel: definition.authority === "safe_local" ? "normal" : "high",
      },
      definition.description,
      definition.title,
    ),
  };
}

function assertConcreteStageTasks(inputs: TaskPlanInput[], stage: SparkReproStageName): void {
  const concreteIssues = collectNonConcreteTaskIssues(inputs);
  if (concreteIssues.length === 0) return;
  throw new Error(
    `repro ${stage} tasks are not concrete: ${concreteIssues
      .map((issue) => `@${issue.name}: ${issue.message}`)
      .join("; ")}`,
  );
}
