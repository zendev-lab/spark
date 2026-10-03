import {
  createExtensionRoleSpec,
  registerExtensionRole,
  type RoleSpec,
} from "@zendev-lab/spark-roles";

const READ_TOOLS = ["read", "grep", "find", "context"];
const EXEC_TOOLS = [
  ...READ_TOOLS,
  "cue_exec",
  "cue_run",
  "cue_script",
  "script_run",
  "script_eval",
  "cue_jobs",
  "evidence",
  "impl_update_task_plan_items",
  "impl_finish_task",
];
const LANE_WRITE_TOOLS = [...EXEC_TOOLS, "git", "edit", "write"];

export const SPARK_REPRO_ROLE_IDS = [
  "repro-implementation-explorer",
  "repro-exactness-instrumentation-worker",
  "repro-precision-fixer",
] as const;

export function createSparkReproRoleSpecs(now?: string): RoleSpec[] {
  return [
    createExtensionRoleSpec(
      {
        id: "repro-implementation-explorer",
        description:
          "Builds one bounded implementation candidate for the current Repro checkpoint.",
        capabilities: ["read", "exec", "write"],
        modelType: "implementation",
        allowedTools: LANE_WRITE_TOOLS,
        systemPrompt:
          "You are the Repro Implementation lane. Work only on the supplied objective and checkpoint. A Workspace may contain zero, one, or many repositories; discover relevant inputs through owner-provided Workspace and Artifact context, and never assume the process cwd is a Git repository. Keep experiments reversible and finish with one strict spark.repro.lane-result/v2 JSON Evidence bound to the supplied checkpointId, sessionId, TaskRef, and RunRef. Attach the carrier and every referenced Evidence to that TaskRun through impl_finish_task. For implementation_refresh, use sourceCheckpointId and parentCheckpointId exactly as supplied. Never publish, merge, force-push, spawn roles, or ask the user directly; emit attention_request only for a genuine user decision.",
      },
      now,
    ),
    createExtensionRoleSpec(
      {
        id: "repro-exactness-instrumentation-worker",
        description:
          "Independently verifies a checkpoint candidate and localizes its first divergence.",
        capabilities: ["read", "exec", "write"],
        modelType: "exploration",
        allowedTools: LANE_WRITE_TOOLS,
        systemPrompt:
          "You are the Repro Exactness lane. Work only on the supplied objective and checkpoint. A Workspace may contain zero, one, or many repositories; use the accepted sourceCheckpointId Evidence and owner-provided Artifacts instead of assuming cwd, a GitChange, a worktree, or a mechanical import. Add bounded non-interfering diagnostics, identify the first bad boundary, and require isolate plus resynchronize Evidence before a skip. Finish with one strict spark.repro.lane-result/v2 JSON Evidence bound to checkpointId, sessionId, TaskRef, and RunRef. For exactness_refresh, preserve parentCheckpointId ordering. Never publish, force-push, spawn roles, or ask the user directly.",
      },
      now,
    ),
    createExtensionRoleSpec(
      {
        id: "repro-precision-fixer",
        description: "Formalizes an evidence-confirmed mechanism and proves the bounded result.",
        capabilities: ["read", "exec", "write"],
        modelType: "implementation",
        allowedTools: LANE_WRITE_TOOLS,
        systemPrompt:
          "You are the Repro Formalize lane. Work only on the supplied objective and formalize checkpoint after accepted Exactness Evidence. A Workspace may contain zero, one, or many repositories; do not assume cwd is Git, that a GitChange exists, or that Draft submission is required. Keep changes scoped, run focused and numerical checks, and finish with one strict spark.repro.lane-result/v2 JSON Evidence bound to checkpointId, sourceCheckpointId, sessionId, TaskRef, and RunRef. Only this checkpoint may declare formalizedRevision, and only when inspectable Evidence proves it. Do not change acceptance criteria, edit prior Evidence, spawn roles, ask directly, publish, merge, force-push, or claim broader coverage than the formal run proves.",
      },
      now,
    ),
  ];
}

export function registerSparkReproRoles(): void {
  for (const role of createSparkReproRoleSpecs()) registerExtensionRole(role);
}
