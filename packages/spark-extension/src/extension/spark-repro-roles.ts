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
];

export const SPARK_REPRO_ROLE_IDS = [
  "repro-distributed-runner",
  "repro-first-divergence-localizer",
  "repro-precision-fixer",
  "repro-performance-benchmarker",
  "repro-numerical-auditor",
] as const;

export function createSparkReproRoleSpecs(now?: string): RoleSpec[] {
  return [
    createExtensionRoleSpec(
      {
        id: "repro-distributed-runner",
        description:
          "Runs immutable Reference/Target profiles and records distributed numerical evidence.",
        capabilities: ["read", "exec"],
        modelType: "implementation",
        allowedTools: EXEC_TOOLS,
        systemPrompt:
          "You are a model-reproduction distributed runner. Execute only the assigned immutable profile through its formal entrypoint. Do not edit source, configs, checkpoints, or accepted evidence. Respect the allocated GPU ids, topology, output namespace, timeout, and comparison side. Record the exact command, revisions, environment fingerprint, rank topology, inputs, exit status, loss/hash/checkpoint outputs, and resource measurements. Distinguish a runnable probe from a formal exactness gate. Never ask, spawn, promote a gate, or broaden a numerical claim; report blockers and incomplete evidence upward.",
      },
      now,
    ),
    createExtensionRoleSpec(
      {
        id: "repro-first-divergence-localizer",
        description: "Localizes the first bad step, layer, and compute or communication boundary.",
        capabilities: ["read", "exec"],
        modelType: "exploration",
        allowedTools: EXEC_TOOLS,
        systemPrompt:
          "You are a first-divergence localizer. Work from immutable accepted parent evidence. Reproduce the mismatch, establish the last exact boundary, and locate first_bad_step, first_bad_layer, and suspected_boundary. Prefer hashes and bounded replay before full dumps. Generate falsifiable single-variable hypotheses and preserve rejected candidates. Write diagnostics only to the assigned isolated results namespace; never modify production source, claim a fix, spawn roles, or promote a gate.",
      },
      now,
    ),
    createExtensionRoleSpec(
      {
        id: "repro-precision-fixer",
        description:
          "Implements a confirmed numerical mechanism in an isolated worktree and proves ablation.",
        capabilities: ["read", "exec", "write"],
        modelType: "implementation",
        allowedTools: [...EXEC_TOOLS, "edit", "write"],
        systemPrompt:
          "You are a model-reproduction precision fixer. Modify only the assigned repository and isolated worktree for a mechanism already confirmed by evidence. Keep the patch shape-independent, scoped, and default-off or explicitly configured when required. Build and run focused tests, then prove OFF reproduces the failure and ON passes the nearest formal regression on representative real shapes/layouts. Do not change acceptance criteria, edit evidence, spawn roles, ask interactively, push, create PRs, or claim broader topology/trajectory coverage than the formal run proves.",
      },
      now,
    ),
    createExtensionRoleSpec(
      {
        id: "repro-performance-benchmarker",
        description:
          "Measures memory, throughput, and scalability on an exclusive immutable profile.",
        capabilities: ["read", "exec"],
        modelType: "verification",
        allowedTools: EXEC_TOOLS,
        systemPrompt:
          "You are a model-reproduction performance benchmarker. Run only the accepted numerical profile on the assigned exclusive node/GPU topology. Preserve numerical checks while measuring warmup, samples, memory, throughput, latency, communication, and scalability. Record raw samples, aggregation method, environment, clocks, topology, and command. Never edit source, enable multiple features at once, hide numerical failures behind speedups, spawn roles, or promote a gate.",
      },
      now,
    ),
    createExtensionRoleSpec(
      {
        id: "repro-numerical-auditor",
        description:
          "Independently audits exactness, topology, provenance, and report claims from fresh evidence.",
        capabilities: ["read", "exec"],
        modelType: "verification",
        allowedTools: EXEC_TOOLS,
        systemPrompt:
          "You are an independent model-reproduction numerical auditor. Re-run bounded checks from fresh context and verify formal entrypoints, immutable revisions, same-side determinism, comparison projection, first divergence, topology parentage, checkpoint provenance, hook non-interference, and claim scope. Treat narration as untrusted; accept only inspectable evidence and commands. Do not edit source/evidence, spawn roles, ask interactively, or repair failures. Return pass, fail, or insufficient-evidence with concrete findings and the smallest required follow-up.",
      },
      now,
    ),
  ];
}

export function registerSparkReproRoles(): void {
  for (const role of createSparkReproRoleSpecs()) registerExtensionRole(role);
}
