import type { RoleRef, TaskExecutionPolicy, TaskKind } from "@zendev-lab/spark-core";
import type { SparkReproStageName, SparkReproStepAuthority } from "./spark-session-repro.ts";

export interface ReproRoadmapBlueprint {
  key: string;
  title: string;
  objective: string;
  scope: string[];
  successCriteria: string[];
  evidenceRequired: string[];
}

export interface ReproTaskBlueprint {
  id: string;
  roadmapKey: string;
  title: string;
  description: string;
  kind: TaskKind;
  roleRef: RoleRef;
  executionPolicy: TaskExecutionPolicy;
  authority: SparkReproStepAuthority;
  dependsOn: string[];
  goal: string;
  doneWhen: string[];
  evidenceRequired: string[];
}

export interface ReproStageBlueprint {
  stage: SparkReproStageName;
  displayTitle: string;
  roadmaps: ReproRoadmapBlueprint[];
  tasks: ReproTaskBlueprint[];
}

const explorer = "role:builtin-explorer" as RoleRef;
const reviewer = "role:builtin-reviewer" as RoleRef;
const distributedRunner = "role:extension-repro-distributed-runner" as RoleRef;
const divergenceLocalizer = "role:extension-repro-first-divergence-localizer" as RoleRef;
const precisionFixer = "role:extension-repro-precision-fixer" as RoleRef;
const performanceBenchmarker = "role:extension-repro-performance-benchmarker" as RoleRef;
const numericalAuditor = "role:extension-repro-numerical-auditor" as RoleRef;
const implementationExplorer = "role:extension-repro-implementation-explorer" as RoleRef;
const exactnessInstrumentation = "role:extension-repro-exactness-instrumentation-worker" as RoleRef;

function task(
  id: string,
  roadmapKey: string,
  title: string,
  input: {
    description?: string;
    kind?: TaskKind;
    roleRef?: RoleRef;
    executionPolicy?: TaskExecutionPolicy;
    authority?: SparkReproStepAuthority;
    dependsOn?: string[];
    goal?: string;
    doneWhen: string[];
    evidenceRequired: string[];
  },
): ReproTaskBlueprint {
  const authority = input.authority ?? "safe_local";
  const kind = input.kind ?? (authority === "safe_local" ? "research" : "ask");
  return {
    id,
    roadmapKey,
    title,
    description:
      input.description ??
      `${title}. Execute the bounded stage work and preserve inspectable commands, outputs, and source references.`,
    kind,
    roleRef: input.roleRef ?? defaultReproRoleRef(id, kind, authority),
    executionPolicy:
      input.executionPolicy ?? defaultReproExecutionPolicy(id, roadmapKey, kind, authority),
    authority,
    dependsOn: input.dependsOn ?? [],
    goal: input.goal ?? title,
    doneWhen: input.doneWhen,
    evidenceRequired: input.evidenceRequired,
  };
}

function defaultReproRoleRef(
  id: string,
  kind: TaskKind,
  authority: SparkReproStepAuthority,
): RoleRef {
  if (authority !== "safe_local") return reviewer;
  if (/(?:first-bad|boundary-classification|localiz)/u.test(id)) return divergenceLocalizer;
  if (/(?:instrument|diagnostic-hook|trace-hook)/u.test(id)) return exactnessInstrumentation;
  if (/(?:precision-fix|incident-fix|apply-fix)/u.test(id)) return precisionFixer;
  if (/(?:performance-budget|benchmark)/u.test(id)) return performanceBenchmarker;
  if (
    /(?:audit|independent-review|final-checker|review-.*(?:evidence|topology|acceptance|claim))/u.test(
      id,
    )
  ) {
    return numericalAuditor;
  }
  if (
    /(?:determinism|entrypoint|full-transaction|trace-export|checkpoint-export|resource-measurement|^align-|^validate-|^run-s[0-3]-|^qualify-|^compose-|replay$|ablation)/u.test(
      id,
    )
  ) {
    return distributedRunner;
  }
  if (kind === "implement") return implementationExplorer;
  if (kind === "review") return reviewer;
  return explorer;
}

function defaultReproExecutionPolicy(
  id: string,
  roadmapKey: string,
  kind: TaskKind,
  authority: SparkReproStepAuthority,
): TaskExecutionPolicy {
  const isAsk = authority !== "safe_local";
  const isImplementation = kind === "implement";
  const isExperiment =
    /(?:probe|entrypoint|transaction|determinism|align|validate|run-|bitwise|qualify|compose|replay|ablation|benchmark|checker)/u.test(
      id,
    );
  const axisGpuCount = /qualify-(?:tp|ep|pp)/u.test(id)
    ? 2
    : id === "compose-tp-ep"
      ? 4
      : /(?:compose-tp-ep-pp|ptarget|s3-)/u.test(id)
        ? 8
        : isExperiment
          ? 1
          : 0;
  const paired =
    axisGpuCount <= 2 &&
    /(?:determinism|align-s0|validate-s0|final-checker|accuracy-mode|ablation)/u.test(id);
  const exclusiveNode = /(?:benchmark|performance-budget|target-scale-convergence)/u.test(id);
  const topologyClass =
    axisGpuCount === 2 ? "gpu-pair" : axisGpuCount === 4 ? "gpu-island-4" : undefined;
  const isolation = isImplementation
    ? "isolated_worktree"
    : isExperiment
      ? "isolated_results"
      : "readonly";
  const sessionLifetime =
    kind === "research" || kind === "review" || kind === "plan" || isAsk
      ? "task_run"
      : "task_revision";
  return {
    sessionLifetime,
    continuity: sessionLifetime === "task_run" ? "fresh" : "reuse_within_revision",
    isolation,
    comparison: paired ? "paired" : "single_side",
    ...(axisGpuCount > 0 || exclusiveNode
      ? {
          resources: {
            gpuCount: axisGpuCount,
            ...(topologyClass ? { topologyClass } : {}),
            ...(exclusiveNode ? { exclusiveNode: true } : {}),
          },
        }
      : {}),
    concurrencyKeys: [
      isolation === "isolated_worktree"
        ? `worktree:repro:${roadmapKey}:${id}`
        : isolation === "isolated_results"
          ? `results:repro:${id}`
          : `readonly:repro:${id}`,
    ],
    ...(isExperiment ? { timeoutMs: 6 * 60 * 60 * 1_000 } : {}),
    maxAttempts: 2,
  };
}

function roadmap(
  key: string,
  title: string,
  objective: string,
  successCriteria: string[],
): ReproRoadmapBlueprint {
  return {
    key,
    title,
    objective,
    scope: [key.replaceAll("-", " "), "formal evidence", "continuous delivery checkpoint"],
    successCriteria: successCriteria.map(
      (criterion) => `Evidence record and checker output verify: ${criterion}`,
    ),
    evidenceRequired: [
      "Evidence record containing accepted commands, configs, source revisions, outputs, and reviewer verdicts.",
    ],
  };
}

const setup: ReproStageBlueprint = {
  stage: "contract",
  displayTitle: "Setup",
  roadmaps: [
    roadmap(
      "contract",
      "Contract and immutable inputs",
      "Freeze the falsifiable reproduction contract.",
      [
        "Source, model, weight, tokenizer, data, profile, horizon, topology, and exactness contracts are explicit.",
      ],
    ),
    roadmap(
      "architecture",
      "Architecture and prior art",
      "Map real reference and target computation paths.",
      [
        "Novel components, cross-layer dependencies, reuse boundaries, and diagnostic hypotheses cite current evidence.",
      ],
    ),
    roadmap(
      "resources",
      "Resources and topology",
      "Derive Pfit, Ptarget, and the topology qualification DAG.",
      ["Resource probes and topology choices are reproducible from recorded commands and outputs."],
    ),
    roadmap(
      "observability",
      "Determinism and observability",
      "Define symmetric evidence and checker contracts.",
      [
        "Same-side determinism, tensor naming, boundary traces, and hook non-interference have explicit checks.",
      ],
    ),
    roadmap(
      "strategy",
      "Strategy review and delivery initialization",
      "Prepare owner decisions and delivery ledgers.",
      [
        "Owner decisions are evidence-backed and the report plus PR dependency map exist before implementation.",
      ],
    ),
  ],
  tasks: [
    task(
      "freeze-source-model-weight-data-contract",
      "contract",
      "Freeze source, model, weight, and data revisions",
      {
        doneWhen: ["Every immutable input has an exact revision or content hash."],
        evidenceRequired: [
          "Manifest Evidence record with repository, model, weight, tokenizer, config, and data revisions.",
        ],
      },
    ),
    task("define-data-tokenizer-contract", "contract", "Define data and tokenizer contract", {
      dependsOn: ["freeze-source-model-weight-data-contract"],
      doneWhen: [
        "Token IDs, labels, masks, sample order, and cursor state have named comparison projections.",
      ],
      evidenceRequired: [
        "Data contract Evidence record with fixtures, hashes, shapes, and cursor semantics.",
      ],
    }),
    task(
      "competitor-baseline-availability-researched",
      "architecture",
      "Verify reference baseline availability",
      {
        doneWhen: [
          "A real reference entrypoint either runs with a recorded exit code or has an exact absence diagnosis.",
        ],
        evidenceRequired: [
          "Command Evidence record with paths, configuration, output, exit code, and missing-input diagnosis when applicable.",
        ],
      },
    ),
    task(
      "trace-reference-architecture",
      "architecture",
      "Trace reference forward and backward architecture",
      {
        dependsOn: ["competitor-baseline-availability-researched"],
        doneWhen: [
          "Forward, loss, backward, optimizer, and checkpoint paths identify source files and symbols.",
        ],
        evidenceRequired: [
          "Reference trace Evidence record with file and symbol locations plus computation boundaries.",
        ],
      },
    ),
    task(
      "trace-target-existing-path",
      "architecture",
      "Trace target framework implementation paths",
      {
        doneWhen: [
          "Existing target entrypoints, builders, kernels, and distributed boundaries are mapped.",
        ],
        evidenceRequired: [
          "Target trace Evidence record with source paths, exported APIs, and unsupported assumptions.",
        ],
      },
    ),
    task("map-model-novel-components", "architecture", "Map model novel components", {
      roleRef: explorer,
      dependsOn: ["trace-reference-architecture", "trace-target-existing-path"],
      doneWhen: ["Every model component is classified as reuse, adapt, or new with cited reasons."],
      evidenceRequired: [
        "Component matrix Evidence record with primary source and implementation references.",
      ],
    }),
    task("map-cross-layer-dependencies", "architecture", "Map cross-layer dependencies", {
      dependsOn: ["trace-reference-architecture"],
      doneWhen: [
        "First, middle, special, and final layer dependencies define the S1 and S2 closure.",
      ],
      evidenceRequired: [
        "Cross-layer dependency graph with residual, cache, sharing, and RNG boundaries.",
      ],
    }),
    task(
      "implementation-landscape-researched",
      "architecture",
      "Research reusable implementation boundaries",
      {
        roleRef: explorer,
        dependsOn: ["map-model-novel-components"],
        doneWhen: [
          "Reusable modules and rejected alternatives cite concrete APIs and constraints.",
        ],
        evidenceRequired: [
          "Implementation landscape Evidence record with reuse, adapt, and new options.",
        ],
      },
    ),
    task(
      "research-prior-art-and-known-diffs",
      "architecture",
      "Research prior art and diagnostic categories",
      {
        roleRef: explorer,
        dependsOn: ["map-model-novel-components"],
        doneWhen: [
          "Three to five highest-relevance primary sources are deeply reviewed and classified.",
        ],
        evidenceRequired: [
          "Research Evidence record separating direct reuse, pattern reuse, and background material.",
        ],
      },
    ),
    task(
      "estimate-parameter-and-activation-memory",
      "resources",
      "Estimate parameter and activation memory",
      {
        dependsOn: ["map-model-novel-components", "map-cross-layer-dependencies"],
        doneWhen: ["S0, S1, S2, and S3 memory estimates state assumptions and dominant terms."],
        evidenceRequired: [
          "Resource model Evidence record with parameter, optimizer, activation, and communication estimates.",
        ],
      },
    ),
    task("probe-s0-and-s2-resource-envelope", "resources", "Probe S0 and S2 resource envelope", {
      dependsOn: [
        "competitor-baseline-availability-researched",
        "estimate-parameter-and-activation-memory",
      ],
      doneWhen: [
        "Observed peak memory and runtime exist for S0 and the smallest feasible S2 attempt.",
      ],
      evidenceRequired: [
        "Profiler command Evidence record with device inventory, peak memory, runtime, and exit codes.",
      ],
    }),
    task("derive-pfit-and-ptarget", "resources", "Derive Pfit and Ptarget topology vectors", {
      dependsOn: ["probe-s0-and-s2-resource-envelope"],
      doneWhen: ["P0, Pfit, and Ptarget are explicit topology vectors with fit rationale."],
      evidenceRequired: [
        "Topology Evidence record containing tp, pp, ep, cp, dp, sequence parallel, and sharding fields.",
      ],
    }),
    task("design-topology-qualification-dag", "resources", "Produce topology qualification DAG", {
      roleRef: explorer,
      dependsOn: ["derive-pfit-and-ptarget", "research-prior-art-and-known-diffs"],
      doneWhen: ["Every candidate topology changes one axis from an accepted parent."],
      evidenceRequired: [
        "Topology DAG Evidence record covering TP, EP, PP, SP, CP, DP, sharding, and performance features.",
      ],
    }),
    task("define-determinism-contract", "observability", "Define same-side determinism contract", {
      roleRef: explorer,
      dependsOn: ["define-data-tokenizer-contract"],
      doneWhen: [
        "Inputs, parameters, loss, optimizer, RNG, scheduler, scaler, and cursor comparisons are specified.",
      ],
      evidenceRequired: [
        "Determinism checker contract with exact repetition count and projections.",
      ],
    }),
    task(
      "define-observability-and-checker-contract",
      "observability",
      "Define symmetric observability and checker contract",
      {
        roleRef: explorer,
        dependsOn: ["trace-reference-architecture", "trace-target-existing-path"],
        doneWhen: [
          "Tensor naming, boundary hashing, checkpoint schema, and first-divergence projections are symmetric.",
        ],
        evidenceRequired: [
          "Checker schema Evidence record with hook non-interference acceptance criteria.",
        ],
      },
    ),
    task("review-baseline-options", "strategy", "Review baseline construction options", {
      kind: "review",
      roleRef: reviewer,
      dependsOn: ["competitor-baseline-availability-researched"],
      doneWhen: [
        "Reuse and construction options have consequences and a ready or not-ready verdict.",
      ],
      evidenceRequired: ["Reviewer option matrix citing baseline availability evidence."],
    }),
    task(
      "baseline-construction-strategy-approved",
      "strategy",
      "Approve baseline construction strategy",
      {
        authority: "ask_decision",
        dependsOn: ["review-baseline-options"],
        doneWhen: [
          "The owner selects a baseline source or construction approach through a canonical decision.",
        ],
        evidenceRequired: [
          "Canonical Ask decision receipt bound to the current Subgoal definition.",
        ],
      },
    ),
    task(
      "review-reuse-adapt-new-options",
      "strategy",
      "Review reuse, adapt, and new implementation options",
      {
        kind: "review",
        roleRef: reviewer,
        dependsOn: ["implementation-landscape-researched"],
        doneWhen: [
          "Each implementation option has scope, risk, ownership, and source-backed consequences.",
        ],
        evidenceRequired: ["Independent reviewer matrix and ready or not-ready verdict."],
      },
    ),
    task("implementation-strategy-approved", "strategy", "Approve implementation strategy", {
      authority: "ask_decision",
      dependsOn: ["review-reuse-adapt-new-options"],
      doneWhen: [
        "The owner selects reuse, adaptation, or new implementation through a canonical decision.",
      ],
      evidenceRequired: ["Canonical Ask decision receipt bound to the current Subgoal definition."],
    }),
    task(
      "alignment-paths-researched",
      "strategy",
      "Compare real-module and eager alignment paths",
      {
        dependsOn: ["define-observability-and-checker-contract"],
        doneWhen: [
          "Both paths have executable probe commands, outputs, and observability tradeoffs.",
        ],
        evidenceRequired: [
          "Paired probe Evidence record with commands, exit codes, and comparison table.",
        ],
      },
    ),
    task("review-alignment-path-options", "strategy", "Review alignment path options", {
      kind: "review",
      roleRef: reviewer,
      dependsOn: ["alignment-paths-researched"],
      doneWhen: [
        "The real-module and eager options have explicit diagnostic and formal-use boundaries.",
      ],
      evidenceRequired: ["Independent reviewer matrix and ready or not-ready verdict."],
    }),
    task("alignment-strategy-approved", "strategy", "Approve alignment strategy", {
      authority: "ask_decision",
      dependsOn: ["review-alignment-path-options"],
      doneWhen: ["The owner selects the formal alignment path through a canonical decision."],
      evidenceRequired: ["Canonical Ask decision receipt bound to the current Subgoal definition."],
    }),
    task("review-resource-and-topology-plan", "strategy", "Review resource and topology plan", {
      kind: "review",
      roleRef: reviewer,
      dependsOn: ["design-topology-qualification-dag"],
      doneWhen: [
        "Pfit, Ptarget, GPU packing, and topology parent evidence are internally consistent.",
      ],
      evidenceRequired: ["Reviewer verdict citing resource probes and topology DAG."],
    }),
    task("repro-contract-frozen", "contract", "Freeze the reproduction acceptance contract", {
      kind: "review",
      roleRef: reviewer,
      dependsOn: [
        "define-determinism-contract",
        "define-observability-and-checker-contract",
        "review-resource-and-topology-plan",
      ],
      doneWhen: [
        "S0 through S3, H1 through Htarget, formal entrypoint, and exactness claims are frozen.",
      ],
      evidenceRequired: [
        "Reviewed Goal Contract Evidence record with explicit claims, non-goals, profiles, and evidence requirements.",
      ],
    }),
    task("baseline-probe-passed", "strategy", "Run approved baseline comparison probe", {
      dependsOn: ["baseline-construction-strategy-approved", "alignment-strategy-approved"],
      doneWhen: [
        "The approved reference and comparison path execute the frozen real probe with a passing assertion.",
      ],
      evidenceRequired: [
        "Probe command, configuration, raw output, exit code, and checker result.",
      ],
    }),
    task(
      "initialize-report-and-pr-map",
      "strategy",
      "Initialize report preview and PR dependency map",
      {
        dependsOn: ["repro-contract-frozen"],
        doneWhen: [
          "A report skeleton and owner-repository PR dependency map are stored as Artifacts.",
        ],
        evidenceRequired: [
          "Preview Artifact with managed report sections, repository owners, branch plan, and sync events.",
        ],
      },
    ),
  ],
};

const scaffold: ReproStageBlueprint = {
  stage: "reference",
  displayTitle: "Scaffold",
  roadmaps: [
    roadmap(
      "environment",
      "Environment and build closure",
      "Build and independently validate both environments.",
      ["Reference and target environments rebuild with frozen fingerprints and native extensions."],
    ),
    roadmap(
      "reference",
      "Reference baseline profiles",
      "Establish formal S0, S1, and S2 reference entrypoints.",
      ["Reference profiles complete the required transaction and export checkpoint plus traces."],
    ),
    roadmap(
      "implementation",
      "Target structure implementation",
      "Implement all unique target ownership boundaries.",
      ["The target parameter inventory and checkpoint mapping cover every unique module."],
    ),
    roadmap(
      "integration",
      "Formal entrypoint and observability",
      "Integrate transaction, trace, and roundtrip paths.",
      ["S0 and S2 execute formally without diagnostic shortcuts or hook interference."],
    ),
    roadmap(
      "delivery",
      "Early reviewable delivery",
      "Publish the first buildable and reviewable slice.",
      [
        "Report evidence is current and owner-approved external publication has a Draft PR receipt.",
      ],
    ),
  ],
  tasks: [
    task("build-reference-environment", "environment", "Build isolated reference environment", {
      kind: "implement",
      dependsOn: ["baseline-probe-passed"],
      doneWhen: [
        "The frozen reference dependencies install and import from an isolated environment.",
      ],
      evidenceRequired: [
        "Build command log, lockfile or manifest, environment path, and exit code.",
      ],
    }),
    task("build-target-environment", "environment", "Build isolated target environment", {
      kind: "implement",
      dependsOn: ["implementation-strategy-approved"],
      doneWhen: ["The frozen target dependencies install and import from an isolated environment."],
      evidenceRequired: [
        "Build command log, lockfile or manifest, environment path, and exit code.",
      ],
    }),
    task(
      "prepare-dataset-tokenizer",
      "environment",
      "Prepare deterministic dataset and tokenizer derivatives",
      {
        kind: "implement",
        dependsOn: ["define-data-tokenizer-contract"],
        doneWhen: [
          "Both sides consume identical immutable token, label, mask, and sample-order fixtures.",
        ],
        evidenceRequired: [
          "Fixture manifest with hashes, shapes, tokenizer revision, and sample IDs.",
        ],
      },
    ),
    task("build-native-extensions", "environment", "Build required native extensions", {
      kind: "implement",
      dependsOn: ["build-reference-environment", "build-target-environment"],
      doneWhen: ["Required native kernels build and load in their owning environments."],
      evidenceRequired: ["Compiler commands, versions, build logs, load checks, and exit codes."],
    }),
    task(
      "validate-reference-environment",
      "environment",
      "Validate reference environment independently",
      {
        dependsOn: ["build-reference-environment", "build-native-extensions"],
        doneWhen: ["Reference imports, device discovery, and a bounded tensor operation pass."],
        evidenceRequired: ["Independent validation command and captured environment fingerprint."],
      },
    ),
    task(
      "validate-target-environment",
      "environment",
      "Validate target environment independently",
      {
        dependsOn: ["build-target-environment", "build-native-extensions"],
        doneWhen: ["Target imports, device discovery, and a bounded tensor operation pass."],
        evidenceRequired: ["Independent validation command and captured environment fingerprint."],
      },
    ),
    task(
      "record-environment-fingerprints",
      "environment",
      "Record symmetric environment fingerprints",
      {
        dependsOn: ["validate-reference-environment", "validate-target-environment"],
        doneWhen: [
          "Framework, CUDA, compiler, driver, GPU, dependency, and kernel settings are recorded.",
        ],
        evidenceRequired: ["Symmetric environment manifest for reference and target."],
      },
    ),
    task("reference-s0-entrypoint", "reference", "Establish reference S0 formal entrypoint", {
      kind: "implement",
      dependsOn: ["validate-reference-environment", "prepare-dataset-tokenizer"],
      doneWhen: ["S0 uses real model code and runs on one GPU through the formal entrypoint."],
      evidenceRequired: [
        "Entrypoint command, resolved config, module inventory, output, and exit code.",
      ],
    }),
    task(
      "reference-s0-full-transaction",
      "reference",
      "Run reference S0 full training transaction",
      {
        dependsOn: ["reference-s0-entrypoint"],
        doneWhen: [
          "Forward, loss, backward, reduce, clip, optimizer, save, and readback all execute.",
        ],
        evidenceRequired: ["Transaction manifest with boundary hashes and checkpoint reference."],
      },
    ),
    task("reference-s1-entrypoint", "reference", "Establish reference S1 shallow entrypoint", {
      kind: "implement",
      dependsOn: ["reference-s0-entrypoint"],
      doneWhen: ["The shallow cross-layer closure executes through the formal entrypoint."],
      evidenceRequired: ["S1 command, layer inventory, configuration, output, and exit code."],
    }),
    task("reference-s2-pfit-entrypoint", "reference", "Establish reference S2 on Pfit", {
      kind: "implement",
      dependsOn: ["reference-s1-entrypoint", "derive-pfit-and-ptarget"],
      doneWhen: ["Every unique module and required cross-layer relationship executes on Pfit."],
      evidenceRequired: [
        "S2/Pfit command, topology vector, module coverage, output, and resource trace.",
      ],
    }),
    task(
      "reference-checkpoint-and-trace-export",
      "reference",
      "Export reference checkpoint and symmetric trace",
      {
        dependsOn: ["reference-s2-pfit-entrypoint"],
        doneWhen: [
          "Checkpoint inventory and contracted boundary traces are exportable and immutable.",
        ],
        evidenceRequired: ["Checkpoint hashes, tensor inventory, trace schema, and Evidence refs."],
      },
    ),
    task(
      "design-target-ownership-boundaries",
      "implementation",
      "Freeze target interfaces and ownership boundaries",
      {
        kind: "review",
        roleRef: reviewer,
        dependsOn: ["implementation-strategy-approved", "map-model-novel-components"],
        doneWhen: [
          "Config, attention, MLP or MoE, embedding, checkpoint, and parallel interfaces are explicit.",
        ],
        evidenceRequired: ["Reviewed interface and worktree ownership map."],
      },
    ),
    task("implement-config-builders", "implementation", "Implement target config and builders", {
      kind: "implement",
      dependsOn: ["design-target-ownership-boundaries"],
      doneWhen: ["Formal configs instantiate S0, S1, and S2 shapes without hidden overrides."],
      evidenceRequired: ["Changed-file Evidence record, focused tests, and builder inventory."],
    }),
    task(
      "implement-attention-rope",
      "implementation",
      "Implement attention and positional encoding",
      {
        kind: "implement",
        dependsOn: ["design-target-ownership-boundaries"],
        doneWhen: [
          "Real attention and positional paths support contracted shapes, dtypes, and layouts.",
        ],
        evidenceRequired: ["Changed-file Evidence record with focused forward and backward tests."],
      },
    ),
    task(
      "implement-mlp-moe-experts",
      "implementation",
      "Implement MLP, router, shared expert, and expert modules",
      {
        kind: "implement",
        dependsOn: ["design-target-ownership-boundaries"],
        doneWhen: ["All dense or MoE variants execute real forward and backward paths."],
        evidenceRequired: [
          "Changed-file Evidence record with router, dispatch, expert, and gradient tests.",
        ],
      },
    ),
    task(
      "implement-embedding-output",
      "implementation",
      "Implement embedding and output boundaries",
      {
        kind: "implement",
        dependsOn: ["design-target-ownership-boundaries"],
        doneWhen: [
          "Embedding, output projection, tying, and loss inputs match the declared inventory.",
        ],
        evidenceRequired: ["Changed-file Evidence record with inventory and boundary tests."],
      },
    ),
    task(
      "implement-checkpoint-mapping",
      "implementation",
      "Implement checkpoint mapping and coverage checks",
      {
        kind: "implement",
        dependsOn: ["design-target-ownership-boundaries", "reference-checkpoint-and-trace-export"],
        doneWhen: [
          "Official weights load with explicit coverage, shape, dtype, and layout checks.",
        ],
        evidenceRequired: ["Mapping table, load command, coverage report, and rejected key list."],
      },
    ),
    task(
      "implement-parallel-config",
      "implementation",
      "Implement Pfit parallel state and configuration",
      {
        kind: "implement",
        dependsOn: ["design-target-ownership-boundaries", "derive-pfit-and-ptarget"],
        doneWhen: [
          "Pfit topology is expressed natively without claiming its numerical qualification.",
        ],
        evidenceRequired: ["Topology config, rank map, initialization trace, and focused tests."],
      },
    ),
    task(
      "project-structure-created",
      "integration",
      "Integrate formal target structure and entrypoint",
      {
        kind: "implement",
        dependsOn: [
          "implement-config-builders",
          "implement-attention-rope",
          "implement-mlp-moe-experts",
          "implement-embedding-output",
          "implement-checkpoint-mapping",
          "implement-parallel-config",
        ],
        doneWhen: [
          "The target formal entrypoint builds S0 and S2 from reviewed production modules.",
        ],
        evidenceRequired: [
          "Formal command, parameter inventory, module execution trace, and changed-file Evidence record.",
        ],
      },
    ),
    task(
      "implement-symmetric-observability",
      "integration",
      "Implement symmetric result and trace schemas",
      {
        kind: "implement",
        dependsOn: ["project-structure-created", "define-observability-and-checker-contract"],
        doneWhen: [
          "Both sides emit the same tensor names, hashes, manifests, and distributed boundaries.",
        ],
        evidenceRequired: ["Schema fixtures, checker tests, and paired trace Evidence records."],
      },
    ),
    task(
      "dependencies-buildable",
      "integration",
      "Validate full transaction and checkpoint roundtrip",
      {
        dependsOn: ["project-structure-created", "implement-symmetric-observability"],
        doneWhen: [
          "S0 runs on one GPU and S2/Pfit completes forward, backward, optimizer, save, and readback.",
        ],
        evidenceRequired: [
          "Formal S0 and S2 commands, finite outputs, checkpoint roundtrip, and exit codes.",
        ],
      },
    ),
    task(
      "audit-hook-and-diagnostic-non-interference",
      "integration",
      "Audit hook non-interference and diagnostic shortcuts",
      {
        kind: "review",
        roleRef: reviewer,
        dependsOn: ["dependencies-buildable"],
        doneWhen: [
          "Hook on and off results match and no diagnostic path replaces production computation.",
        ],
        evidenceRequired: [
          "Independent audit Evidence record with paired hashes and source findings.",
        ],
      },
    ),
    task(
      "update-scaffold-report",
      "delivery",
      "Update report with structure, environment, and resources",
      {
        dependsOn: [
          "audit-hook-and-diagnostic-non-interference",
          "record-environment-fingerprints",
        ],
        doneWhen: [
          "Managed report sections cite the accepted structure, environment, and resource evidence.",
        ],
        evidenceRequired: ["Updated preview Artifact with evidence links and current limitations."],
      },
    ),
    task("create-initial-draft-pr-approved", "delivery", "Create or update initial Draft PR", {
      authority: "ask_approval",
      dependsOn: ["update-scaffold-report"],
      doneWhen: [
        "The owner authorizes external publication and the first buildable reviewable slice is in a Draft PR.",
      ],
      evidenceRequired: ["Canonical approval receipt plus Draft PR and pushed commit refs."],
    }),
  ],
};

const reproduce: ReproStageBlueprint = {
  stage: "target",
  displayTitle: "Reproduce",
  roadmaps: [
    roadmap(
      "qualification",
      "Determinism qualification",
      "Prove same-side determinism before cross-framework comparison.",
      ["Reference and target repetitions match under the frozen input and hook contracts."],
    ),
    roadmap(
      "h1",
      "S0 full-transaction ladder",
      "Align every boundary of one complete S0 training transaction.",
      ["The first mismatch is localized before later boundaries are claimed."],
    ),
    roadmap(
      "incidents",
      "Incident resolution",
      "Preserve dynamic first-divergence experiments and accepted fixes.",
      [
        "Every fix has a single-variable mechanism proof, formal regression, and independent review.",
      ],
    ),
    roadmap(
      "trajectory",
      "Structure and time branches",
      "Run S0 long horizon beside S1 and S2 structural expansion.",
      ["The time and structure branches join before S2 long-horizon promotion."],
    ),
    roadmap(
      "delivery",
      "Continuous precision delivery",
      "Keep patches, report, and Draft PR current.",
      ["Accepted fixes and rejected or inconclusive experiments are traceable."],
    ),
  ],
  tasks: [
    task(
      "reference-s0-s2-determinism",
      "qualification",
      "Qualify reference S0 and S2 determinism",
      {
        dependsOn: ["dependencies-buildable"],
        doneWhen: [
          "Repeated reference runs match inputs, loss, parameters, optimizer, RNG, and cursor projections.",
        ],
        evidenceRequired: ["Paired reference manifests and raw-bit checker results."],
      },
    ),
    task("target-s0-s2-determinism", "qualification", "Qualify target S0 and S2 determinism", {
      dependsOn: ["dependencies-buildable"],
      doneWhen: [
        "Repeated target runs match inputs, loss, parameters, optimizer, RNG, and cursor projections.",
      ],
      evidenceRequired: ["Paired target manifests and raw-bit checker results."],
    }),
    task(
      "audit-rng-data-cursor-and-hooks",
      "qualification",
      "Audit RNG, data cursor, and hook replay",
      {
        kind: "review",
        roleRef: reviewer,
        dependsOn: ["reference-s0-s2-determinism", "target-s0-s2-determinism"],
        doneWhen: [
          "RNG, data progression, and hook on or off contracts cannot explain a cross-side mismatch.",
        ],
        evidenceRequired: [
          "Independent audit Evidence record with state hashes and hook equivalence.",
        ],
      },
    ),
    task("align-s0-input-token-label", "h1", "Align S0 input, token, label, and mask bits", {
      dependsOn: ["audit-rng-data-cursor-and-hooks"],
      doneWhen: ["All contracted input tensors and sample identities are raw-bit equal."],
      evidenceRequired: ["Named tensor inventory, hashes, and mismatch-free checker result."],
    }),
    task("align-s0-initial-parameters", "h1", "Align S0 initial parameter inventory and bits", {
      dependsOn: ["align-s0-input-token-label"],
      doneWhen: ["Parameter names, shapes, dtypes, layouts, strides, and raw bits match."],
      evidenceRequired: ["Paired initial parameter inventory and exact checker output."],
    }),
    task("align-s0-forward", "h1", "Align S0 forward boundaries", {
      dependsOn: ["align-s0-initial-parameters"],
      doneWhen: [
        "Every named forward boundary is exact and the first divergence query returns none.",
      ],
      evidenceRequired: ["Paired forward trace and boundary checker result."],
    }),
    task("align-s0-loss", "h1", "Align S0 loss inputs and loss", {
      dependsOn: ["align-s0-forward"],
      doneWhen: ["Loss inputs and raw-bit loss match under the frozen reduction contract."],
      evidenceRequired: ["Loss input tensors, reduction configuration, and exact checker result."],
    }),
    task("align-s0-backward", "h1", "Align S0 named gradients", {
      dependsOn: ["align-s0-loss"],
      doneWhen: ["All named pre-reduction gradients are exact."],
      evidenceRequired: ["Paired gradient trace and first-divergence checker result."],
    }),
    task("align-s0-grad-reduce", "h1", "Align S0 gradient reduction boundaries", {
      dependsOn: ["align-s0-backward"],
      doneWhen: ["Pre-collective and post-collective named gradients are exact."],
      evidenceRequired: ["Distributed boundary trace and collective configuration."],
    }),
    task("align-s0-clip", "h1", "Align S0 gradient clipping", {
      dependsOn: ["align-s0-grad-reduce"],
      doneWhen: ["Clip inputs, norm, scale, and outputs are exact."],
      evidenceRequired: ["Clip boundary tensors and exact checker result."],
    }),
    task("align-s0-optimizer", "h1", "Align S0 optimizer state and parameter update", {
      dependsOn: ["align-s0-clip"],
      doneWhen: ["Optimizer state initialization and post-update parameter bits match."],
      evidenceRequired: [
        "Optimizer inventory, update hashes, hyperparameters, and exact checker output.",
      ],
    }),
    task("align-s0-checkpoint-readback", "h1", "Align S0 checkpoint save and readback", {
      dependsOn: ["align-s0-optimizer"],
      doneWhen: [
        "Saved and reloaded parameters, optimizer, RNG, scheduler, scaler, and cursor match.",
      ],
      evidenceRequired: ["Checkpoint inventory, hashes, reload command, and exact checker result."],
    }),
    task("validate-s0-p0-h1", "h1", "Validate S0 P0 H1 complete transaction", {
      dependsOn: ["align-s0-checkpoint-readback"],
      doneWhen: ["One formal S0/P0 training transaction is raw-bit exact end to end."],
      evidenceRequired: ["Formal paired run manifests and full-transaction checker verdict."],
    }),
    task("run-s0-p0-htarget", "trajectory", "Run S0 P0 Htarget exact trajectory", {
      dependsOn: ["validate-s0-p0-h1"],
      doneWhen: [
        "Every step through Htarget has exact loss, post-update, optimizer, RNG, and cursor hashes.",
      ],
      evidenceRequired: [
        "Immutable long-horizon manifests, per-step hashes, and first-bad-step result.",
      ],
    }),
    task("run-s1-p0-h1", "trajectory", "Run S1 P0 H1 structural bridge", {
      dependsOn: ["validate-s0-p0-h1"],
      doneWhen: ["The shallow cross-layer closure is exact for a complete training transaction."],
      evidenceRequired: ["S1 paired manifests, boundary hashes, and exact checker verdict."],
    }),
    task("run-s2-pfit-h1", "trajectory", "Run S2 Pfit H1 exact transaction", {
      dependsOn: ["run-s1-p0-h1"],
      doneWhen: [
        "Every unique module and required cross-layer boundary is exact for one transaction.",
      ],
      evidenceRequired: [
        "S2/Pfit paired manifests, topology, boundary traces, and checker verdict.",
      ],
    }),
    task("bitwise-pass-20", "trajectory", "Run S2 Pfit Hshort exact trajectory", {
      dependsOn: ["run-s2-pfit-h1"],
      doneWhen: ["S2/Pfit remains exact through the contract Hshort horizon."],
      evidenceRequired: ["Hshort per-step hashes and trajectory checker verdict."],
    }),
    task("join-s0-time-and-s2-structure", "trajectory", "Join S0 time and S2 structure evidence", {
      kind: "review",
      roleRef: reviewer,
      dependsOn: ["run-s0-p0-htarget", "bitwise-pass-20"],
      doneWhen: [
        "Independent review confirms both branches use the same frozen contract and accepted patches.",
      ],
      evidenceRequired: ["Join review citing both immutable run sets and their provenance."],
    }),
    task("bitwise-pass-100", "trajectory", "Run S2 Pfit Htarget exact trajectory", {
      dependsOn: ["join-s0-time-and-s2-structure"],
      doneWhen: [
        "S2/Pfit remains exact through Htarget and checkpoint resume does not fork the trajectory.",
      ],
      evidenceRequired: [
        "Htarget per-step hashes, checkpoint resume replay, and exact checker verdict.",
      ],
    }),
    task(
      "sync-reproduce-report-and-draft-pr",
      "delivery",
      "Sync accepted fixes and precision matrix",
      {
        dependsOn: ["bitwise-pass-20"],
        doneWhen: [
          "The report and managed Draft PR sections identify accepted fixes and all rejected or inconclusive incidents.",
        ],
        evidenceRequired: [
          "Updated preview, commit refs, Draft PR ref, and evidence-linked first-divergence ledger.",
        ],
      },
    ),
  ],
};

const scale: ReproStageBlueprint = {
  stage: "alignment",
  displayTitle: "Scale",
  roadmaps: [
    roadmap(
      "parent",
      "Accepted parent profile",
      "Freeze the numerical and resource parent for topology deltas.",
      ["Parent determinism, checkpoint, patches, and resource envelope are immutable."],
    ),
    roadmap(
      "axes",
      "Independent topology axes",
      "Qualify TP, EP, and the PP delta from accepted parents.",
      ["Each axis changes one topology field and preserves distributed-boundary evidence."],
    ),
    roadmap(
      "compose",
      "Topology composition",
      "Compose TP, EP, and PP only after parent axes pass.",
      ["Combination profiles cite all parent evidence and pass H1 before longer horizons."],
    ),
    roadmap("target", "Additional axes and target scale", "Qualify SP, CP, DP, sharding, and S3.", [
      "Ptarget and the requested S3 horizon pass numerical and resume gates.",
    ]),
    roadmap(
      "performance",
      "Performance features",
      "Enable one performance feature per accepted experiment.",
      ["Numerical verdict, memory, throughput, and scalability are reported independently."],
    ),
    roadmap(
      "delivery",
      "Scale delivery checkpoint",
      "Continuously publish the topology and resource matrix.",
      ["Report and Draft PR claims match immutable topology evidence."],
    ),
  ],
  tasks: [
    task("freeze-scale-parent-profile", "parent", "Freeze accepted S2 parent profile and patches", {
      dependsOn: ["bitwise-pass-100"],
      doneWhen: [
        "Parent config, sources, inputs, environment, accepted patches, and evidence are content-addressed.",
      ],
      evidenceRequired: ["Parent profile manifest and patch ledger."],
    }),
    task(
      "revalidate-parent-determinism-and-checkpoint",
      "parent",
      "Revalidate parent determinism and checkpoint",
      {
        dependsOn: ["freeze-scale-parent-profile"],
        doneWhen: ["Parent repetition and checkpoint resume reproduce the accepted hashes."],
        evidenceRequired: ["Repeated parent manifests and checkpoint replay checker result."],
      },
    ),
    task("qualify-tp", "axes", "Qualify tensor parallel axis", {
      dependsOn: ["revalidate-parent-determinism-and-checkpoint"],
      doneWhen: ["TP-only delta passes H1 distributed boundaries and Hshort trajectory."],
      evidenceRequired: [
        "Parent and TP topology vectors, collective traces, and exact checker verdicts.",
      ],
    }),
    task("qualify-ep", "axes", "Qualify expert parallel axis", {
      dependsOn: ["revalidate-parent-determinism-and-checkpoint"],
      doneWhen: [
        "EP-only delta passes router, dispatch, expert, collective, optimizer, and Hshort checks.",
      ],
      evidenceRequired: [
        "Parent and EP topology vectors, token routing traces, and exact checker verdicts.",
      ],
    }),
    task("qualify-pp-delta", "axes", "Qualify pipeline parallel delta", {
      dependsOn: ["revalidate-parent-determinism-and-checkpoint", "run-s1-p0-h1"],
      doneWhen: [
        "Adding PP to the nearest fitting accepted parent passes fixed-schedule H1 boundaries.",
      ],
      evidenceRequired: [
        "Pipeline schedule, microbatch contract, send and receive traces, and exact verdict.",
      ],
    }),
    task("compose-tp-ep", "compose", "Compose TP and EP", {
      dependsOn: ["qualify-tp", "qualify-ep"],
      doneWhen: ["TP by EP passes H1 and Hshort while citing both qualified parents."],
      evidenceRequired: ["Composition manifest, parent refs, boundary traces, and exact verdicts."],
    }),
    task("compose-tp-ep-pp", "compose", "Add PP to qualified TP by EP", {
      dependsOn: ["compose-tp-ep", "qualify-pp-delta"],
      doneWhen: [
        "TP by EP by PP passes H1 and Hshort with only PP changed from its accepted parent.",
      ],
      evidenceRequired: ["Composition manifest, rank map, schedule trace, and exact verdicts."],
    }),
    task("qualify-sequence-parallel", "target", "Qualify sequence parallel", {
      dependsOn: ["compose-tp-ep-pp"],
      doneWhen: ["Sequence parallel changes one axis and preserves H1 plus Hshort exactness."],
      evidenceRequired: ["Parent and candidate topology vectors with exact boundary results."],
    }),
    task("qualify-context-parallel", "target", "Qualify context parallel", {
      dependsOn: ["qualify-sequence-parallel"],
      doneWhen: ["Context parallel attention boundaries and Hshort trajectory are exact."],
      evidenceRequired: ["Sequence partition, attention communication trace, and exact verdict."],
    }),
    task("qualify-data-parallel", "target", "Qualify data parallel", {
      dependsOn: ["qualify-context-parallel"],
      doneWhen: ["Data-parallel gradient and optimizer semantics pass H1 and Hshort."],
      evidenceRequired: ["Batch partition, gradient collective trace, and exact verdict."],
    }),
    task("qualify-optimizer-sharding", "target", "Qualify optimizer sharding", {
      dependsOn: ["qualify-data-parallel"],
      doneWhen: [
        "Sharded optimizer state and post-update parameters match the qualified DP parent.",
      ],
      evidenceRequired: [
        "Shard inventory, communication trace, checkpoint mapping, and exact verdict.",
      ],
    }),
    task("run-s2-ptarget-htarget", "target", "Run S2 Ptarget Htarget", {
      dependsOn: ["qualify-optimizer-sharding"],
      doneWhen: ["The complete target topology remains exact through Htarget."],
      evidenceRequired: ["Ptarget topology manifest, per-step hashes, and trajectory verdict."],
    }),
    task("run-s3-ptarget-h1-hshort", "target", "Run S3 Ptarget H1 and Hshort", {
      dependsOn: ["run-s2-ptarget-htarget"],
      doneWhen: ["The target-scale model passes structure inventory, H1, and Hshort exactness."],
      evidenceRequired: ["S3 manifests, inventory, resource trace, and exact checker verdicts."],
    }),
    task("target-scale-convergence", "target", "Run S3 Ptarget Htarget and resume replay", {
      dependsOn: ["run-s3-ptarget-h1-hshort"],
      doneWhen: ["The contract target-scale horizon and checkpoint resume replay pass."],
      evidenceRequired: [
        "S3 Htarget per-step hashes, checkpoint replay, and final numerical verdict.",
      ],
    }),
    ...[
      ["qualify-recompute", "recompute"],
      ["qualify-fused-attention-norm-mlp", "fused attention, norm, and MLP"],
      ["qualify-communication-overlap", "communication overlap"],
      ["qualify-pipeline-interleaving", "pipeline interleaving and virtual pipeline"],
      ["qualify-async-collective", "asynchronous collectives"],
      ["qualify-low-precision-communication", "FP8 or quantized communication"],
    ].map(([id, feature], index) =>
      task(id!, "performance", `Qualify ${feature}`, {
        dependsOn: [
          index === 0
            ? "target-scale-convergence"
            : [
                "qualify-recompute",
                "qualify-fused-attention-norm-mlp",
                "qualify-communication-overlap",
                "qualify-pipeline-interleaving",
                "qualify-async-collective",
              ][index - 1]!,
        ],
        doneWhen: [
          `${feature} changes one variable and preserves the declared numerical projection.`,
        ],
        evidenceRequired: [
          `OFF and ON manifests for ${feature} with numerical, memory, throughput, and scalability deltas.`,
        ],
      }),
    ),
    task(
      "performance-budget",
      "performance",
      "Benchmark final topology in an exclusive node lane",
      {
        dependsOn: ["qualify-low-precision-communication"],
        doneWhen: [
          "Final memory, throughput, and scalability meet the contract without hiding numerical failures.",
        ],
        evidenceRequired: [
          "Exclusive-node benchmark manifest, raw samples, summary statistics, and numerical verdict.",
        ],
      },
    ),
    task(
      "sync-scale-report-and-draft-pr",
      "delivery",
      "Sync topology matrix, resources, and patches",
      {
        dependsOn: ["target-scale-convergence", "performance-budget"],
        doneWhen: [
          "Managed report and Draft PR sections match every enabled topology and performance feature.",
        ],
        evidenceRequired: [
          "Updated preview, profile matrix, resource table, commit refs, and Draft PR ref.",
        ],
      },
    ),
  ],
};

const deliver: ReproStageBlueprint = {
  stage: "delivery",
  displayTitle: "Finalize",
  roadmaps: [
    roadmap(
      "audit",
      "Independent evidence audit",
      "Audit every formal numerical and delivery claim.",
      [
        "Environment, entrypoint, topology, checkpoint, resource, and report verdicts are independent.",
      ],
    ),
    roadmap(
      "replay",
      "Clean rebuild and replay",
      "Rebuild both sides and replay the final checker suite.",
      ["Clean runs reproduce the selected immutable final evidence."],
    ),
    roadmap(
      "ablation",
      "Ablation and non-interference",
      "Prove accepted patches and hooks do not overclaim.",
      ["OFF and ON, patch-by-patch, representative shape, and resume evidence are complete."],
    ),
    roadmap(
      "pr",
      "PR convergence",
      "Resolve review and dependency ordering without first-time delivery.",
      ["Every owner repository PR is ready or has a concrete external blocker."],
    ),
    roadmap(
      "report",
      "Final report and bundle",
      "Freeze claims, limitations, and the immutable bundle.",
      ["The final bundle is independent of mutable workspaces."],
    ),
  ],
  tasks: [
    ...[
      ["audit-final-environment", "environment fingerprints and clean rebuild inputs"],
      ["audit-formal-entrypoints", "formal entrypoints and absence of diagnostic shortcuts"],
      [
        "audit-numerical-evidence",
        "numerical projections, first divergence, and trajectory claims",
      ],
      ["audit-topology-evidence", "topology parents, one-axis deltas, and distributed boundaries"],
      ["audit-checkpoint-provenance", "checkpoint inventory, hashes, and resume provenance"],
      ["audit-resource-performance", "resource, memory, throughput, and scalability claims"],
      ["audit-report-claims", "report claims, evidence links, and limitations"],
    ].map(([id, subject]) =>
      task(id!, "audit", `Audit ${subject}`, {
        kind: "review",
        roleRef: reviewer,
        dependsOn: ["sync-scale-report-and-draft-pr"],
        doneWhen: [`An independent reviewer either verifies ${subject} or records exact blockers.`],
        evidenceRequired: [
          `Independent audit Evidence record for ${subject} with source and evidence refs.`,
        ],
      }),
    ),
    task("clean-reference-rebuild-and-replay", "replay", "Clean rebuild and replay reference", {
      kind: "implement",
      dependsOn: ["audit-final-environment", "audit-formal-entrypoints"],
      doneWhen: ["A clean environment reproduces the selected reference final run."],
      evidenceRequired: ["Clean build log, formal command, manifest, hashes, and exit code."],
    }),
    task("clean-target-rebuild-and-replay", "replay", "Clean rebuild and replay target", {
      kind: "implement",
      dependsOn: ["audit-final-environment", "audit-formal-entrypoints"],
      doneWhen: ["A clean environment reproduces the selected target final run."],
      evidenceRequired: ["Clean build log, formal command, manifest, hashes, and exit code."],
    }),
    task("run-final-checker-suite", "replay", "Run final checker suite", {
      dependsOn: ["clean-reference-rebuild-and-replay", "clean-target-rebuild-and-replay"],
      doneWhen: [
        "Every required structure, numerical, topology, checkpoint, and provenance checker passes.",
      ],
      evidenceRequired: ["Final checker manifest with individual verdicts and selected run refs."],
    }),
    task("run-accuracy-mode-off-on", "ablation", "Run accuracy mode OFF and ON ablation", {
      dependsOn: ["run-final-checker-suite"],
      doneWhen: [
        "OFF reproduces the expected baseline behavior and ON reproduces the accepted exact result.",
      ],
      evidenceRequired: ["Paired OFF and ON configs, manifests, checker outputs, and hashes."],
    }),
    task("run-patch-by-patch-ablation", "ablation", "Run patch-by-patch mechanism ablation", {
      dependsOn: ["run-accuracy-mode-off-on"],
      doneWhen: ["Each accepted patch has a bounded necessity or non-interference result."],
      evidenceRequired: ["Patch ledger with control and treatment runs plus mechanism verdicts."],
    }),
    task(
      "run-hook-shape-resume-regressions",
      "ablation",
      "Run hook, representative shape, and resume regressions",
      {
        dependsOn: ["run-patch-by-patch-ablation"],
        doneWhen: [
          "Hook equivalence, at least two real shapes or layouts, and checkpoint resume pass.",
        ],
        evidenceRequired: [
          "Regression matrix with configs, commands, hashes, and checker verdicts.",
        ],
      },
    ),
    task(
      "review-pr-scope-ci-and-order",
      "pr",
      "Review PR scope, CI, commits, and cross-repository order",
      {
        kind: "review",
        roleRef: reviewer,
        dependsOn: ["run-hook-shape-resume-regressions", "audit-report-claims"],
        doneWhen: [
          "PR scope, commit hygiene, CI, review comments, and dependency order are resolved or blocked externally.",
        ],
        evidenceRequired: [
          "PR review Evidence record with URLs, commits, check results, comments, and blockers.",
        ],
      },
    ),
    task("mark-prs-ready-approved", "pr", "Mark PRs ready and request review", {
      authority: "ask_approval",
      dependsOn: ["review-pr-scope-ci-and-order"],
      doneWhen: [
        "The owner authorizes readiness and every PR is ready or has an explicit external blocker.",
      ],
      evidenceRequired: ["Canonical approval receipt and final PR state refs."],
    }),
    task("pr-submitted", "pr", "Verify continuous Draft PR delivery is complete", {
      kind: "review",
      roleRef: reviewer,
      dependsOn: ["mark-prs-ready-approved"],
      doneWhen: [
        "No first-time PR creation remains and all accepted patches map to pushed commits and PRs.",
      ],
      evidenceRequired: ["Cross-repository PR dependency map and commit-to-evidence ledger."],
    }),
    task("no-runtime-patches", "report", "Verify no untracked runtime patches remain", {
      kind: "review",
      roleRef: reviewer,
      dependsOn: ["run-hook-shape-resume-regressions"],
      doneWhen: [
        "Formal runs depend only on reviewed code, explicit configs, and immutable inputs.",
      ],
      evidenceRequired: ["Clean-tree and runtime patch audit with source and config hashes."],
    }),
    task(
      "freeze-final-report-and-bundle",
      "report",
      "Freeze final report and immutable release bundle",
      {
        dependsOn: [
          "pr-submitted",
          "no-runtime-patches",
          "audit-numerical-evidence",
          "audit-topology-evidence",
        ],
        doneWhen: [
          "Unsupported claims are downgraded and the bundle contains all final manifests, configs, evidence, and limitations.",
        ],
        evidenceRequired: [
          "Final preview and bundle manifest with content hashes and no mutable workspace dependencies.",
        ],
      },
    ),
  ],
};

export const REPRO_STAGE_BLUEPRINTS: Readonly<Record<SparkReproStageName, ReproStageBlueprint>> = {
  contract: setup,
  reference: scaffold,
  target: reproduce,
  alignment: scale,
  delivery: deliver,
};

export function reproStageBlueprint(stage: SparkReproStageName): ReproStageBlueprint {
  return REPRO_STAGE_BLUEPRINTS[stage];
}
