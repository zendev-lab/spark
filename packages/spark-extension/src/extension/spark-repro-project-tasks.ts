import { type RoadmapItem, type RoleRef, type TaskPlan } from "@zendev-lab/spark-core";
import type { SparkSessionRepro } from "./spark-session-repro.ts";

export interface ReproProjectTaskDefinition {
  name: string;
  title: string;
  description: string;
  kind: "research" | "review";
  roleRef: RoleRef;
  dependsOn?: string[];
  plan: Partial<TaskPlan>;
}

export function initialReproProjectTasks(
  repro: SparkSessionRepro,
  roadmapItem: RoadmapItem,
): ReproProjectTaskDefinition[] {
  const objective = repro.goalContract.objective;
  return [
    {
      name: "baseline-availability",
      title: "Verify competitor/reference baseline availability",
      description:
        "Inspect the workspace and dependency manifests, then prove whether a runnable reference baseline exists.",
      kind: "research",
      roleRef: "role:builtin-explorer",
      plan: taskPlan(roadmapItem, {
        objective: `Determine whether a runnable competitor/reference baseline exists for ${objective}, including the exact launch command or exact missing inputs.`,
        successCriteria: [
          "Evidence artifact records inspected source paths and a baseline command with its exit code, or records the exact missing files and configuration that block execution.",
        ],
        evidenceRequired: [
          "Evidence artifact containing repository paths, dependency findings, command output, and exit code or the explicit absence diagnosis.",
        ],
        items: [
          "Inspect repository paths, dependency manifests, and documented entry points for the competitor/reference baseline",
          "Run the discovered baseline command and record output plus exit code, or record the exact missing files and configuration",
        ],
      }),
    },
    {
      name: "implementation-landscape",
      title: "Map reusable implementation boundaries",
      description:
        "Trace existing implementation modules and identify reusable boundaries for the target reproduction.",
      kind: "research",
      roleRef: "role:builtin-researcher",
      plan: taskPlan(roadmapItem, {
        objective: `Produce a source-backed implementation map for ${objective} that identifies reusable modules, extension boundaries, and incompatible assumptions.`,
        successCriteria: [
          "Research artifact lists reusable modules and rejected alternatives with concrete source file paths and exported API names.",
        ],
        evidenceRequired: [
          "Research artifact containing source paths, API symbols, dependency constraints, and the comparison result.",
        ],
        items: [
          "Trace target implementation entry points, imports, and exported APIs across the workspace",
          "Compare reusable modules against the reproduction contract and record source-backed compatibility findings",
        ],
      }),
    },
    {
      name: "alignment-paths",
      title: "Compare real-module and eager alignment paths",
      description:
        "Run source-backed comparisons of the available alignment paths and their observability constraints.",
      kind: "research",
      roleRef: "role:builtin-explorer",
      plan: taskPlan(roadmapItem, {
        objective: `Compare real-module and eager alignment paths for ${objective} using executable probes and observable outputs.`,
        successCriteria: [
          "Evidence artifact records commands, outputs, and a metric or assertion comparison for both alignment paths.",
        ],
        evidenceRequired: [
          "Evidence artifact containing both probe commands, exit codes, captured outputs, and the comparison table.",
        ],
        items: [
          "Inspect both alignment path implementations and record their source entry points and observable outputs",
          "Run a probe command for each path and compare exit codes, outputs, and alignment assertions",
        ],
      }),
    },
    {
      name: "baseline-strategy",
      title: "Review baseline construction strategy",
      description:
        "Convert verified baseline availability evidence into explicit owner decision options and consequences.",
      kind: "review",
      roleRef: "role:builtin-reviewer",
      dependsOn: ["baseline-availability"],
      plan: taskPlan(roadmapItem, {
        objective:
          "Review the baseline availability artifact and produce complete owner decision options for reuse or construction without making the decision on the owner's behalf.",
        successCriteria: [
          "Reviewer artifact contains the baseline evidence refs, option matrix, constraints, and a verdict on whether the owner has enough evidence to ask the canonical decision.",
        ],
        evidenceRequired: [
          "Reviewer artifact with cited evidence refs, option matrix, and explicit ready/not-ready verdict.",
        ],
        items: [
          "Inspect the baseline availability evidence artifact and verify every cited path, command, and blocker",
          "Render reuse and construction options with consequences and record a ready/not-ready reviewer verdict",
        ],
      }),
    },
    {
      name: "implementation-strategy",
      title: "Review implementation strategy",
      description: "Synthesize implementation findings into an explicit owner decision package.",
      kind: "review",
      roleRef: "role:builtin-reviewer",
      dependsOn: ["implementation-landscape"],
      plan: taskPlan(roadmapItem, {
        objective:
          "Review implementation research and produce an owner-ready reuse, adapt, or new implementation decision package without selecting the strategy.",
        successCriteria: [
          "Reviewer artifact contains an implementation decision matrix with source refs, constraints, and a ready/not-ready verdict.",
        ],
        evidenceRequired: [
          "Reviewer artifact with implementation options, cited source refs, and an explicit verdict.",
        ],
        items: [
          "Verify the implementation research artifact against its cited source paths and APIs",
          "Render reuse, adapt, and new implementation options and record owner readiness",
        ],
      }),
    },
    {
      name: "alignment-strategy",
      title: "Review alignment strategy",
      description: "Synthesize alignment probe findings into an explicit owner decision package.",
      kind: "review",
      roleRef: "role:builtin-reviewer",
      dependsOn: ["alignment-paths"],
      plan: taskPlan(roadmapItem, {
        objective:
          "Review alignment evidence and produce an owner-ready real-module versus eager alignment decision package without selecting the strategy.",
        successCriteria: [
          "Reviewer artifact contains an alignment decision matrix with probe evidence, observability constraints, and a ready/not-ready verdict.",
        ],
        evidenceRequired: [
          "Reviewer artifact with alignment options, cited command evidence, and an explicit verdict.",
        ],
        items: [
          "Verify the alignment research artifact against its cited commands and outputs",
          "Render real-module and eager alignment options and record owner readiness",
        ],
      }),
    },
  ];
}

export function taskPlan(
  roadmapItem: RoadmapItem,
  input: {
    objective: string;
    successCriteria: string[];
    evidenceRequired: string[];
    items: string[];
  },
): Partial<TaskPlan> {
  return {
    objective: input.objective,
    contextRefs: [roadmapItem.ref],
    constraints: [...(roadmapItem.constraints ?? [])],
    nonGoals: ["Treating agent narration as completion evidence"],
    successCriteria: input.successCriteria,
    evidenceRequired: input.evidenceRequired,
    steps: input.items,
    openQuestions: [],
    askRefs: [],
    riskLevel: "normal",
  };
}

export function reproProjectTitle(objective: string): string {
  const compact = objective.replace(/\s+/g, " ").trim();
  return `Repro: ${compact.length > 72 ? `${compact.slice(0, 69)}...` : compact}`;
}
