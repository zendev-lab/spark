export interface ReproBuiltinWorkflowSpec {
  id: string;
  title: string;
  description: string;
  itemField: string;
  itemLabel: string;
  executorRoleRef: string;
  stages: string[];
  instructions: string[];
  mode?: "parallel" | "change-loop" | "delivery-sync";
}

const RUNNER = "role:extension-repro-distributed-runner";
const LOCALIZER = "role:extension-repro-first-divergence-localizer";
const FIXER = "role:extension-repro-precision-fixer";
const AUDITOR = "role:extension-repro-numerical-auditor";

export const reproBuiltinWorkflowSpecs: readonly ReproBuiltinWorkflowSpec[] = [
  {
    id: "repro-stage-orchestrate",
    title: "repro:stage-orchestrate",
    description:
      "Execute a bounded stage-local safe work wave and independently review its evidence join; durable Project Task dispatch remains assign-owned",
    itemField: "tasks",
    itemLabel: "stage task",
    executorRoleRef: RUNNER,
    stages: ["Validate", "Execute wave", "Evidence join"],
    instructions: [
      "Treat every item as an already authorized safe-local unit inside one Project Task.",
      "Respect each item dependency, resource allocation, output namespace, and doneWhen contract.",
      "Do not mutate Project Task/Subgoal state; the owner Session and assign scheduler own promotion.",
    ],
  },
  {
    id: "repro-module-sweep",
    title: "repro:module-sweep",
    description:
      "Run an isolated module experiment matrix concurrently and summarize exact, failed, and inconclusive cells",
    itemField: "experiments",
    itemLabel: "module experiment",
    executorRoleRef: RUNNER,
    stages: ["Validate", "Run matrix", "Summarize"],
    instructions: [
      "Use the real module code, declared shapes/layouts/dtypes, and immutable inputs.",
      "Each item must have an isolated results namespace and may change only its declared variable.",
      "Classify every cell as pass, fail, crash, or inconclusive with evidence refs.",
    ],
  },
  {
    id: "repro-first-divergence",
    title: "repro:first-divergence",
    description:
      "Fan out bounded localization hypotheses, identify the last exact and first bad boundary, and require independent review",
    itemField: "hypotheses",
    itemLabel: "localization hypothesis",
    executorRoleRef: LOCALIZER,
    stages: ["Validate", "Localize", "Mechanism review"],
    instructions: [
      "Start from the same immutable failing run and accepted parent evidence.",
      "Prefer first_bad_step, first_bad_layer, and boundary hashes before full tensor dumps.",
      "A hypothesis is not confirmed until a single-variable control changes the predicted boundary.",
    ],
  },
  {
    id: "repro-change-loop",
    title: "repro:change-loop",
    description:
      "Run one confirmed precision fix through implementation, build, formal regression, and independent review",
    itemField: "changes",
    itemLabel: "confirmed mechanism",
    executorRoleRef: FIXER,
    stages: ["Validate", "Fix", "Build and regress", "Review"],
    instructions: [
      "Accept only mechanisms already confirmed by immutable evidence.",
      "Keep edits in the assigned isolated worktree and preserve OFF-failure/ON-pass ablation.",
      "Do not promote the patch until the nearest formal entrypoint regression and independent review pass.",
    ],
    mode: "change-loop",
  },
  {
    id: "repro-long-horizon",
    title: "repro:long-horizon",
    description:
      "Run a bounded trajectory, locate first_bad_step, and expand detailed traces only around the failing step",
    itemField: "profiles",
    itemLabel: "trajectory profile",
    executorRoleRef: RUNNER,
    stages: ["Validate", "Run trajectory", "Localize first bad step"],
    instructions: [
      "Record loss, parameter, optimizer, RNG/data cursor, scheduler, and scaler hashes every step.",
      "Record full boundary hashes only at declared checkpoints until a first bad step exists.",
      "Never replace earlier immutable trajectory evidence.",
    ],
  },
  {
    id: "repro-axis-qualify",
    title: "repro:axis-qualify",
    description:
      "Qualify one TP, EP, PP, SP, CP, DP, or optimizer-sharding delta against a certified parent profile",
    itemField: "profiles",
    itemLabel: "axis candidate",
    executorRoleRef: RUNNER,
    stages: ["Validate parent", "Run sides", "Audit boundary"],
    instructions: [
      "Each candidate must cite a certified parent and change exactly one topology axis.",
      "Capture same-side determinism and compute/collective boundaries before cross-framework comparison.",
      "Performance never substitutes for topology exactness.",
    ],
  },
  {
    id: "repro-topology-compose",
    title: "repro:topology-compose",
    description:
      "Compose independently qualified topology axes and validate H1 then Hshort before longer trajectories",
    itemField: "profiles",
    itemLabel: "composed topology",
    executorRoleRef: RUNNER,
    stages: ["Validate parents", "Compose", "Audit H1 and Hshort"],
    instructions: [
      "Require accepted evidence for every parent axis.",
      "Relative to the nearest certified parent, add only the declared composition delta.",
      "Run H1 before Hshort and preserve per-rank communication evidence.",
    ],
  },
  {
    id: "repro-evidence-review",
    title: "repro:evidence-review",
    description:
      "Independently review numerical, entrypoint, topology, provenance, resource, and report evidence lenses",
    itemField: "evidence",
    itemLabel: "evidence lens",
    executorRoleRef: AUDITOR,
    stages: ["Validate", "Audit lenses", "Verdict"],
    instructions: [
      "Treat narration and generated reports as untrusted indexes.",
      "Check each claim against immutable command, config, revision, run, and evidence refs.",
      "Return pass, fail, or insufficient-evidence without repairing the target.",
    ],
  },
  {
    id: "repro-delivery-sync",
    title: "repro:delivery-sync",
    description:
      "Render deterministic managed report and Draft PR sections from accepted evidence without owning git or forge mutation",
    itemField: "updates",
    itemLabel: "delivery update",
    executorRoleRef: AUDITOR,
    stages: ["Validate", "Render managed sections", "Record receipt"],
    instructions: [
      "Use only accepted canonical Project, TaskRun, evidence, commit, config, and PR refs.",
      "Preserve unsupported, rejected, blocked, and inconclusive states instead of upgrading claims.",
      "Return deterministic managed section bodies; the owner delivery Task owns commit, push, and PR mutation.",
    ],
    mode: "delivery-sync",
  },
];

export function reproStageOrchestrateWorkflowScript(): string {
  return reproWorkflowScript(requireReproWorkflowSpec("repro-stage-orchestrate"));
}

export function reproModuleSweepWorkflowScript(): string {
  return reproWorkflowScript(requireReproWorkflowSpec("repro-module-sweep"));
}

export function reproFirstDivergenceWorkflowScript(): string {
  return reproWorkflowScript(requireReproWorkflowSpec("repro-first-divergence"));
}

export function reproChangeLoopWorkflowScript(): string {
  return reproWorkflowScript(requireReproWorkflowSpec("repro-change-loop"));
}

export function reproLongHorizonWorkflowScript(): string {
  return reproWorkflowScript(requireReproWorkflowSpec("repro-long-horizon"));
}

export function reproAxisQualifyWorkflowScript(): string {
  return reproWorkflowScript(requireReproWorkflowSpec("repro-axis-qualify"));
}

export function reproTopologyComposeWorkflowScript(): string {
  return reproWorkflowScript(requireReproWorkflowSpec("repro-topology-compose"));
}

export function reproEvidenceReviewWorkflowScript(): string {
  return reproWorkflowScript(requireReproWorkflowSpec("repro-evidence-review"));
}

export function reproDeliverySyncWorkflowScript(): string {
  return reproWorkflowScript(requireReproWorkflowSpec("repro-delivery-sync"));
}

function requireReproWorkflowSpec(id: string): ReproBuiltinWorkflowSpec {
  const spec = reproBuiltinWorkflowSpecs.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`missing Repro workflow spec: ${id}`);
  return spec;
}

function reproWorkflowScript(spec: ReproBuiltinWorkflowSpec): string {
  const meta = {
    name: spec.title,
    description: spec.description,
    stages: spec.stages.map((title) => ({ title })),
  };
  const config = {
    workflowName: spec.title,
    stages: spec.stages,
    itemField: spec.itemField,
    itemLabel: spec.itemLabel,
    executorRoleRef: spec.executorRoleRef,
    auditorRoleRef: AUDITOR,
    instructions: spec.instructions,
    mode: spec.mode ?? "parallel",
  };
  return `export const meta = ${JSON.stringify(meta, null, 2)}

const input = args || {}
const config = ${JSON.stringify(config, null, 2)}
const items = Array.isArray(input[config.itemField]) ? input[config.itemField] : []
if (items.length === 0) throw new Error(config.workflowName + ' requires args.' + config.itemField + '[]')
const concurrency = boundedInt(input.concurrency, Math.min(items.length, 8), 1, 64)

function boundedInt(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback
}

function compact(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function itemLabel(item, index) {
  if (item && typeof item === 'object' && (item.id || item.name || item.title)) {
    return String(item.id || item.name || item.title)
  }
  return config.itemLabel + ' ' + (index + 1)
}

stage(config.stages[0])
const contract = {
  workflow: config.workflowName,
  projectRef: input.projectRef,
  taskRef: input.taskRef,
  subgoalRef: input.subgoalRef,
  planRevision: input.planRevision,
  definitionDigest: input.definitionDigest,
  immutableBase: input.immutableBase,
  items,
  instructions: config.instructions,
}

if (config.mode === 'change-loop') {
  stage(config.stages[1])
  const mechanism = items[0]
  const fixed = await agent([
    'Implement only this confirmed model-reproduction mechanism.',
    ...config.instructions.map((line) => '- ' + line),
    '',
    compact({ contract, mechanism }, 12000),
  ].join('\\n'), {
    label: 'precision fix',
    roleRef: config.executorRoleRef,
    isolation: input.graftBase ? 'graft' : undefined,
    timeoutMs: input.timeoutMs,
  })
  stage(config.stages[2])
  const validation = await agent([
    'Build the patch and run the exact requested OFF/ON formal regression.',
    'Do not edit source. Return commands, exit codes, evidence refs, and remaining failures.',
    '',
    compact({ contract, mechanism, fixed }, 14000),
  ].join('\\n'), {
    label: 'formal regression',
    roleRef: 'role:extension-repro-distributed-runner',
    timeoutMs: input.timeoutMs,
  })
  stage(config.stages[3])
  const verdict = await agent([
    'Independently review this precision change loop.',
    'Return pass, fail, or insufficient-evidence and do not repair it.',
    '',
    compact({ contract, mechanism, fixed, validation }, 16000),
  ].join('\\n'), {
    label: 'independent change review',
    roleRef: config.auditorRoleRef,
  })
  return { contract, fixed, validation, verdict }
}

stage(config.stages[1])
const outputs = await parallel(items.map((item, index) => async () => {
  const label = itemLabel(item, index)
  return {
    label,
    output: await agent([
      'Execute one bounded unit inside ' + config.workflowName + '.',
      ...config.instructions.map((line) => '- ' + line),
      '',
      'Workflow contract:',
      compact(contract, 8000),
      '',
      'Assigned item:',
      compact(item, 6000),
    ].join('\\n'), {
      label,
      roleRef: config.executorRoleRef,
      timeoutMs: item && typeof item === 'object' ? item.timeoutMs : input.timeoutMs,
      env: item && typeof item === 'object' ? item.env : undefined,
    }),
  }
}), {
  concurrency,
  retry: { attempts: boundedInt(input.maxAttempts, 2, 1, 3) },
  onError: 'collect',
})

stage(config.stages[2])
const verdict = await agent([
  'Independently synthesize the workflow results against the immutable contract.',
  'Do not infer success from missing output. Preserve pass, fail, crash, blocked, and inconclusive cells.',
  'Return the earliest divergence or failed join and the exact evidence needed for promotion.',
  '',
  compact({ contract, outputs }, 18000),
].join('\\n'), {
  label: 'evidence join',
  roleRef: config.auditorRoleRef,
})

if (config.mode === 'delivery-sync') {
  const receipt = await evidenceRecord({
    title: config.workflowName + ' managed sections',
    kind: 'record',
    format: 'markdown',
    projectRef: input.projectRef,
    taskRef: input.taskRef,
    body: compact({ contract, outputs, verdict }, 30000),
  })
  return { contract, outputs, verdict, receipt }
}

return { contract, outputs, verdict }`;
}
