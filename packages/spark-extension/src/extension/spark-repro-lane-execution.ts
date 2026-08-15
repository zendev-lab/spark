import { createHash } from "node:crypto";

import {
  defaultArtifactStore,
  defaultEvidenceStore,
  GitLifecycleService,
  type ArtifactRef,
  type GitChangeArtifactBody,
} from "@zendev-lab/spark-artifacts";
import type { EvidenceRef, ProjectRef, RoleRef, TaskRef } from "@zendev-lab/spark-core";
import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
} from "@zendev-lab/spark-core";
import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";
import {
  acknowledgeSparkReproRoute,
  bindSparkReproFormalizeOwnership,
  parseSparkReproLaneResult,
  reconcileSparkReproLaneResult,
  rematerializeSparkReproWorkItem,
  registerSparkReproWorkItem,
  sparkReproLaneResultEvidenceRefs,
  sparkReproLaneBinding,
  type SparkReproLane,
  type SparkReproRoute,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

export interface SparkReproRouteMaterialization {
  repro: SparkSessionRepro;
  taskRefs: TaskRef[];
  materializedRouteIds: string[];
  routeTaskRefs: Record<string, TaskRef>;
  attentionRoutes: SparkReproRoute[];
}

export interface SparkReproLaneEvidenceIngestion {
  repro: SparkSessionRepro;
  acceptedEvidenceRefs: EvidenceRef[];
}

/** Ingest terminal Task output Evidence; unrelated Evidence is ignored. */
export async function ingestSparkReproLaneResultEvidence(input: {
  workspaceCwd: string;
  repro: SparkSessionRepro;
  evidenceRefs: readonly EvidenceRef[];
}): Promise<SparkReproLaneEvidenceIngestion> {
  let repro = input.repro;
  const acceptedEvidenceRefs: EvidenceRef[] = [];
  const store = defaultEvidenceStore(input.workspaceCwd);
  for (const evidenceRef of [...new Set(input.evidenceRefs)].sort()) {
    const evidence = await store.tryGet(evidenceRef);
    if (!evidence || evidence.format !== "json" || !isRecord(evidence.body)) continue;
    if (evidence.body.schema !== "spark.repro.lane-result/v1") continue;
    const result = parseSparkReproLaneResult(evidence.body);
    for (const referencedEvidenceRef of sparkReproLaneResultEvidenceRefs(result)) {
      if (!(await store.tryGet(referencedEvidenceRef))) {
        throw new Error(
          `lane result ${evidenceRef} references missing Evidence ${referencedEvidenceRef}`,
        );
      }
    }
    const reconciled = reconcileSparkReproLaneResult({
      state: repro.threeLane,
      reproId: repro.reproId,
      evidenceRef,
      result,
    });
    if (reconciled.state !== repro.threeLane) {
      repro = { ...repro, threeLane: reconciled.state };
    }
    acceptedEvidenceRefs.push(evidenceRef);
  }
  return { repro, acceptedEvidenceRefs };
}

interface EnsureGitChangeInput {
  workspaceCwd: string;
  repositoryCwd: string;
  repro: SparkSessionRepro;
  route: SparkReproRoute;
  targetLane: SparkReproLane;
}

interface EnsureTaskInput {
  workspaceCwd: string;
  projectRef: ProjectRef;
  repro: SparkSessionRepro;
  route: SparkReproRoute;
  targetLane: SparkReproLane;
  targetBindingRevision: number;
  targetSourceRevision: string;
  gitChangeRef: ArtifactRef;
  inputEvidenceRefs: EvidenceRef[];
}

export interface SparkReproLaneExecutionDeps {
  ensureGitChange?: (input: EnsureGitChangeInput) => Promise<ArtifactRef>;
  ensureTask?: (input: EnsureTaskInput) => Promise<TaskRef>;
  ensureFormalizeDraft?: (input: {
    workspaceCwd: string;
    repositoryCwd: string;
    repro: SparkSessionRepro;
    route: SparkReproRoute;
    gitChangeRef: ArtifactRef;
  }) => Promise<void>;
}

export interface SparkReproLaneTopologyReconcileResult {
  repro: SparkSessionRepro;
  acceptedEvidenceRefs: EvidenceRef[];
  materializedRouteIds: string[];
  dispatchedRouteIds: string[];
  attentionRouteIds: string[];
}

export type SparkReproDriverGitOperation =
  | "candidate_create"
  | "canonical_create"
  | "canonical_layer_add"
  | "draft_submit";

/**
 * Exact driver-local capability fence. Everything outside these four
 * generation-bound operations (including force-push, Ready, merge, base
 * changes, close, sync, and cleanup) is rejected before reaching Git owners.
 */
export function assertSparkReproDriverGitAuthorization(input: {
  repro: SparkSessionRepro;
  route: SparkReproRoute;
  operation: string;
  gitChangeRef?: ArtifactRef;
}): asserts input is typeof input & { operation: SparkReproDriverGitOperation } {
  if (input.repro.status !== "active") throw new Error("Repro generation is not active");
  const authoritative = input.repro.threeLane.routes.find(
    (route) => route.routeId === input.route.routeId,
  );
  if (
    !authoritative ||
    authoritative.status !== "pending" ||
    authoritative.planRevision !== input.repro.threeLane.planRevision ||
    authoritative.resultDigest !== input.route.resultDigest ||
    !sameRouteAuthority(authoritative, input.route)
  ) {
    throw new Error("Repro driver Git operation has no current pending route authority");
  }
  if (
    input.operation === "candidate_create" &&
    authoritative.action === "materialize_binding" &&
    (authoritative.toLane === "implementation" || authoritative.toLane === "exactness")
  ) {
    return;
  }
  if (
    (input.operation === "canonical_create" || input.operation === "canonical_layer_add") &&
    authoritative.action === "materialize_binding" &&
    authoritative.toLane === "formalize"
  ) {
    return;
  }
  if (
    input.operation === "draft_submit" &&
    authoritative.action === "refresh_binding" &&
    authoritative.fromLane === "formalize" &&
    authoritative.toLane === "exactness" &&
    input.gitChangeRef === input.repro.threeLane.formalize.ownership?.gitChangeRef
  ) {
    return;
  }
  throw new Error(`Repro driver Git operation is not authorized: ${input.operation}`);
}

/** Open exactly one daemon-owned async human request for a deduplicated Root decision. */
export async function requestSparkReproRootAttention(input: {
  route: SparkReproRoute;
  interaction?: (request: ExtensionInteractionRequest) => Promise<ExtensionInteractionResponse>;
}): Promise<boolean> {
  const { route } = input;
  if (route.action !== "root_attention" || !route.decisionKey || !route.attention) {
    throw new Error("Repro Root attention requires a structured attention route");
  }
  if (!input.interaction) return false;
  const request: ExtensionInteractionRequest = {
    version: SPARK_PROTOCOL_VERSION,
    kind: "askFlow",
    requestId: `repro_attention_${stableWireId(route.decisionKey)}`,
    toolCallId: `repro-attention:${route.decisionKey}`,
    title: "Repro decision required",
    prompt: route.attention.reason,
    source: "extension",
    metadata: {
      tool: "repro_lane_attention",
      routeId: route.routeId,
      decisionKey: route.decisionKey,
      expectedAnswerKind: route.attention.expectedAnswerKind,
    },
    delivery: "async",
    mode: "decision",
    questions: [
      {
        id: route.decisionKey,
        prompt: route.attention.question,
        type: "freeform",
        required: true,
        defaultValues: [],
      },
    ],
    allowElaborate: true,
  };
  const response = await input.interaction(request);
  return (
    response.kind === "askFlow" && (response.status === "pending" || response.status === "answered")
  );
}

/**
 * Restart-safe topology reconciliation. Persistence is deliberately injected
 * so each cross-owner boundary is fenced before the next side effect.
 */
export async function reconcileSparkReproLaneTopology(input: {
  workspaceCwd: string;
  repositoryCwd: string;
  repro: SparkSessionRepro;
  evidenceRefs: readonly EvidenceRef[];
  persist: (repro: SparkSessionRepro) => Promise<void>;
  dispatch: (taskRefs: TaskRef[]) => Promise<Array<{ taskRef: TaskRef; sessionId: string }>>;
  requestAttention?: (route: SparkReproRoute) => Promise<boolean>;
  deps?: SparkReproLaneExecutionDeps;
}): Promise<SparkReproLaneTopologyReconcileResult> {
  let repro = await recoverDispatchedSparkReproRoutes({
    workspaceCwd: input.workspaceCwd,
    repro: input.repro,
  });
  if (repro !== input.repro) await input.persist(repro);
  const ingested = await ingestSparkReproLaneResultEvidence({
    workspaceCwd: input.workspaceCwd,
    repro,
    evidenceRefs: input.evidenceRefs,
  });
  const beforeIngestion = repro;
  repro = ingested.repro;
  if (repro !== beforeIngestion) await input.persist(repro);
  await ensurePendingFormalizeDrafts({
    workspaceCwd: input.workspaceCwd,
    repositoryCwd: input.repositoryCwd,
    repro,
    deps: input.deps,
  });
  const materialized = await materializeSparkReproRoutes({
    workspaceCwd: input.workspaceCwd,
    repositoryCwd: input.repositoryCwd,
    repro,
    deps: input.deps,
  });
  repro = materialized.repro;
  if (materialized.materializedRouteIds.length > 0) await input.persist(repro);
  const dispatchTaskRefs = serializableDispatchTaskRefs(repro, materialized);
  const records = await input.dispatch(dispatchTaskRefs);
  const recordsByTask = new Map(records.map((record) => [record.taskRef, record]));
  const dispatchedRouteIds = materialized.materializedRouteIds.filter((routeId) =>
    recordsByTask.has(materialized.routeTaskRefs[routeId]!),
  );
  for (const routeId of dispatchedRouteIds) {
    const route = repro.threeLane.routes.find((candidate) => candidate.routeId === routeId);
    if (route?.toLane !== "formalize") continue;
    const taskRef = materialized.routeTaskRefs[routeId]!;
    const record = recordsByTask.get(taskRef)!;
    const binding = sparkReproLaneBinding(repro.threeLane, route.workItemId, "formalize");
    if (!binding?.gitChangeRef) throw new Error("Formalize route has no canonical GitChange");
    repro = bindMaterializedFormalizeIntegrator({
      repro,
      gitChangeRef: binding.gitChangeRef,
      integratorSessionId: record.sessionId,
    });
  }
  const attentionRouteIds: string[] = [];
  if (input.requestAttention) {
    for (const route of materialized.attentionRoutes) {
      if (await input.requestAttention(route)) attentionRouteIds.push(route.routeId);
    }
  }
  const acknowledgedRouteIds = [...dispatchedRouteIds, ...attentionRouteIds];
  if (acknowledgedRouteIds.length > 0) {
    repro = acknowledgeMaterializedSparkReproRoutes(repro, acknowledgedRouteIds);
    await input.persist(repro);
  }
  return {
    repro,
    acceptedEvidenceRefs: ingested.acceptedEvidenceRefs,
    materializedRouteIds: materialized.materializedRouteIds,
    dispatchedRouteIds,
    attentionRouteIds,
  };
}

/**
 * Close the crash window after daemon invocation persistence but before the
 * Repro route acknowledgement. TaskGraph remains the runtime owner; Repro
 * records only the route receipt and canonical integrator identity that can
 * be proven from the current binding and its invoked TaskRun.
 */
async function recoverDispatchedSparkReproRoutes(input: {
  workspaceCwd: string;
  repro: SparkSessionRepro;
}): Promise<SparkSessionRepro> {
  const projectRef = input.repro.projectRef;
  if (!projectRef) return input.repro;
  const graph = await defaultTaskGraphStore(input.workspaceCwd).load();
  if (!graph) return input.repro;
  let repro = input.repro;
  const acknowledgedRouteIds: string[] = [];
  for (const route of repro.threeLane.routes) {
    if (route.status !== "pending" || route.action === "root_attention" || !route.toLane) continue;
    const binding = sparkReproLaneBinding(repro.threeLane, route.workItemId, route.toLane);
    if (
      !binding ||
      binding.status === "superseded" ||
      !binding.evidenceRefs.includes(route.evidenceRef)
    ) {
      continue;
    }
    const run = graph
      .runs(projectRef)
      .filter(
        (candidate) =>
          candidate.taskRef === binding.taskRef && candidate.execution?.invocationId !== undefined,
      )
      .at(-1);
    if (!run?.execution) continue;
    if (route.toLane === "formalize") {
      const integratorSessionId = run.execution.sessionId ?? run.execution.executionSessionId;
      if (!integratorSessionId || !binding.gitChangeRef) {
        throw new Error("invoked Formalize route has incomplete canonical ownership");
      }
      repro = bindMaterializedFormalizeIntegrator({
        repro,
        gitChangeRef: binding.gitChangeRef,
        integratorSessionId,
      });
    }
    acknowledgedRouteIds.push(route.routeId);
  }
  return acknowledgedRouteIds.length > 0
    ? acknowledgeMaterializedSparkReproRoutes(repro, acknowledgedRouteIds)
    : repro;
}

async function ensurePendingFormalizeDrafts(input: {
  workspaceCwd: string;
  repositoryCwd: string;
  repro: SparkSessionRepro;
  deps?: SparkReproLaneExecutionDeps;
}): Promise<void> {
  const ensure = input.deps?.ensureFormalizeDraft ?? defaultEnsureFormalizeDraft;
  const gitChangeRef = input.repro.threeLane.formalize.ownership?.gitChangeRef;
  if (!gitChangeRef) return;
  for (const route of input.repro.threeLane.routes) {
    if (
      route.status !== "pending" ||
      route.action !== "refresh_binding" ||
      route.fromLane !== "formalize"
    ) {
      continue;
    }
    await ensure({
      workspaceCwd: input.workspaceCwd,
      repositoryCwd: input.repositoryCwd,
      repro: input.repro,
      route,
      gitChangeRef,
    });
  }
}

function serializableDispatchTaskRefs(
  repro: SparkSessionRepro,
  materialized: SparkReproRouteMaterialization,
): TaskRef[] {
  let selectedFormalize = false;
  const selected: TaskRef[] = [];
  for (const routeId of materialized.materializedRouteIds) {
    const route = repro.threeLane.routes.find((candidate) => candidate.routeId === routeId);
    const taskRef = materialized.routeTaskRefs[routeId];
    if (!route || !taskRef) continue;
    if (route.toLane === "formalize") {
      if (selectedFormalize) continue;
      selectedFormalize = true;
    }
    if (!selected.includes(taskRef)) selected.push(taskRef);
  }
  return selected;
}

/**
 * Materialize every pending route through existing Artifact and TaskGraph
 * owners. It does not reserve/invoke Tasks and intentionally leaves routes
 * pending until the caller has durably dispatched their TaskRuns.
 */
export async function materializeSparkReproRoutes(input: {
  workspaceCwd: string;
  repositoryCwd: string;
  repro: SparkSessionRepro;
  deps?: SparkReproLaneExecutionDeps;
}): Promise<SparkReproRouteMaterialization> {
  if (!input.repro.projectRef) throw new Error("Repro lane execution requires a project");
  const ensureGitChange = input.deps?.ensureGitChange ?? defaultEnsureGitChange;
  const ensureTask = input.deps?.ensureTask ?? defaultEnsureTask;
  let repro = input.repro;
  const taskRefs: TaskRef[] = [];
  const materializedRouteIds: string[] = [];
  const routeTaskRefs: Record<string, TaskRef> = {};
  const attentionRoutes: SparkReproRoute[] = [];
  let selectedFormalizeRoute = false;

  for (const route of repro.threeLane.routes) {
    if (route.status !== "pending") continue;
    if (route.action === "root_attention") {
      attentionRoutes.push(structuredClone(route));
      continue;
    }
    const targetLane = route.toLane;
    if (!targetLane) throw new Error(`route ${route.routeId} has no target lane`);
    // Do not even create a later canonical stack layer until the preceding
    // Formalize route has been durably dispatched. Otherwise submitting the
    // first result could publish a later, still-empty Draft stack entry.
    if (targetLane === "formalize") {
      if (selectedFormalizeRoute) continue;
      selectedFormalizeRoute = true;
    }
    const existingBinding = sparkReproLaneBinding(repro.threeLane, route.workItemId, targetLane);
    if (
      existingBinding?.evidenceRefs.includes(route.evidenceRef) &&
      existingBinding.status !== "superseded"
    ) {
      taskRefs.push(existingBinding.taskRef);
      materializedRouteIds.push(route.routeId);
      routeTaskRefs[route.routeId] = existingBinding.taskRef;
      continue;
    }
    const gitChangeRef = await ensureGitChange({
      workspaceCwd: input.workspaceCwd,
      repositoryCwd: input.repositoryCwd,
      repro,
      route,
      targetLane,
    });
    const inputEvidenceRefs = routeEvidenceRefs(repro, route);
    const targetBindingRevision = (existingBinding?.bindingRevision ?? 0) + 1;
    const targetSourceRevision = routeSourceRevision(repro, route);
    const taskRef = await ensureTask({
      workspaceCwd: input.workspaceCwd,
      projectRef: input.repro.projectRef,
      repro,
      route,
      targetLane,
      targetBindingRevision,
      targetSourceRevision,
      gitChangeRef,
      inputEvidenceRefs,
    });
    const item = repro.threeLane.workItems.find(
      (candidate) => candidate.workItemId === route.workItemId,
    );
    if (!item) throw new Error(`route references unknown WorkItem: ${route.workItemId}`);
    const nextState = existingBinding
      ? rematerializeSparkReproWorkItem(repro.threeLane, {
          workItemId: route.workItemId,
          lane: targetLane,
          expectedBindingRevision: existingBinding.bindingRevision,
          expectedSourceRevision: existingBinding.sourceRevision,
          sourceRevision: targetSourceRevision,
          taskRef,
          gitChangeRef,
          evidenceRefs: inputEvidenceRefs,
        })
      : registerSparkReproWorkItem(repro.threeLane, targetLane, {
          ...item,
          sourceRevision: targetSourceRevision,
          status: "open",
          taskRef,
          gitChangeRef,
          evidenceRefs: inputEvidenceRefs,
        });
    repro = { ...repro, threeLane: nextState };
    taskRefs.push(taskRef);
    materializedRouteIds.push(route.routeId);
    routeTaskRefs[route.routeId] = taskRef;
  }

  return {
    repro,
    taskRefs: [...new Set(taskRefs)],
    materializedRouteIds,
    routeTaskRefs,
    attentionRoutes,
  };
}

/** Acknowledge only after TaskRun reservation/invocation or human-ledger creation succeeds. */
export function acknowledgeMaterializedSparkReproRoutes(
  repro: SparkSessionRepro,
  routeIds: readonly string[],
): SparkSessionRepro {
  let state = repro.threeLane;
  for (const routeId of routeIds) state = acknowledgeSparkReproRoute(state, routeId);
  return state === repro.threeLane ? repro : { ...repro, threeLane: state };
}

export function bindMaterializedFormalizeIntegrator(input: {
  repro: SparkSessionRepro;
  gitChangeRef: ArtifactRef;
  integratorSessionId: string;
}): SparkSessionRepro {
  const current = input.repro.threeLane.formalize.ownership;
  if (
    current?.gitChangeRef === input.gitChangeRef &&
    current.integratorSessionId === input.integratorSessionId
  ) {
    return input.repro;
  }
  const generation = (current?.generation ?? 0) + 1;
  return {
    ...input.repro,
    threeLane: bindSparkReproFormalizeOwnership(input.repro.threeLane, {
      gitChangeRef: input.gitChangeRef,
      integratorSessionId: input.integratorSessionId,
      generation,
    }),
  };
}

async function defaultEnsureGitChange(input: EnsureGitChangeInput): Promise<ArtifactRef> {
  const existingBinding = sparkReproLaneBinding(
    input.repro.threeLane,
    input.route.workItemId,
    input.targetLane,
  );
  if (input.route.action === "refresh_binding") {
    if (!existingBinding?.gitChangeRef) {
      throw new Error("refresh route requires the original binding GitChange");
    }
    return existingBinding.gitChangeRef;
  }
  const title =
    input.targetLane === "formalize"
      ? `Repro ${input.repro.reproId} canonical`
      : `Repro route ${input.route.routeId}`;
  const store = defaultArtifactStore(input.workspaceCwd);
  const artifacts = await store.list({ kind: "git_change" });
  const ownershipRef =
    input.targetLane === "formalize"
      ? input.repro.threeLane.formalize.ownership?.gitChangeRef
      : undefined;
  const owned = ownershipRef
    ? artifacts.find((artifact) => artifact.ref === ownershipRef)
    : undefined;
  if (ownershipRef && !owned) {
    throw new Error(`canonical ownership references missing GitChange ${ownershipRef}`);
  }
  if (owned && owned.title !== title) {
    throw new Error("canonical ownership references a foreign GitChange");
  }
  const titleMatches = artifacts.filter((artifact) => artifact.title === title);
  if (!owned && titleMatches.length > 1) {
    throw new Error(`multiple GitChanges claim Repro route title: ${title}`);
  }
  const existing = owned ?? titleMatches[0];
  if (existing) {
    if (input.targetLane === "formalize") {
      assertSparkReproDriverGitAuthorization({
        repro: input.repro,
        route: input.route,
        operation: "canonical_layer_add",
        gitChangeRef: existing.ref,
      });
      await ensureFormalizeLayer({
        workspaceCwd: input.workspaceCwd,
        repositoryCwd: input.repositoryCwd,
        gitChangeRef: existing.ref,
        repro: input.repro,
        workItemId: input.route.workItemId,
      });
    }
    return existing.ref;
  }
  const semantic = safeName(
    input.targetLane === "formalize"
      ? `repro-${input.repro.reproId}-canonical`
      : `repro-${input.route.workItemId}-${input.targetLane}-${input.route.routeId}`,
  );
  const service = new GitLifecycleService({
    cwd: input.repositoryCwd,
    workspaceRoot: input.workspaceCwd,
    store,
  });
  assertSparkReproDriverGitAuthorization({
    repro: input.repro,
    route: input.route,
    operation: input.targetLane === "formalize" ? "canonical_create" : "candidate_create",
  });
  const branch =
    input.targetLane === "formalize"
      ? formalizeLayerBranch(input.repro, input.route.workItemId)
      : `spark/${semantic}`;
  const artifact = await service.init({
    title,
    branch,
    repositoryPath: input.repositoryCwd,
  });
  return artifact.ref;
}

async function ensureFormalizeLayer(input: {
  workspaceCwd: string;
  repositoryCwd: string;
  gitChangeRef: ArtifactRef;
  repro: SparkSessionRepro;
  workItemId: string;
}): Promise<void> {
  const store = defaultArtifactStore(input.workspaceCwd);
  const artifact = await store.get<GitChangeArtifactBody>(input.gitChangeRef);
  if (artifact.kind !== "git_change") throw new Error("canonical Artifact is not a GitChange");
  const branch = formalizeLayerBranch(input.repro, input.workItemId);
  if (artifact.body.stack.entries.some((entry) => entry.branch === branch)) return;
  const service = new GitLifecycleService({
    cwd: input.repositoryCwd,
    workspaceRoot: input.workspaceCwd,
    store,
  });
  await service.layerAdd(input.gitChangeRef, branch);
}

async function defaultEnsureFormalizeDraft(input: {
  workspaceCwd: string;
  repositoryCwd: string;
  repro: SparkSessionRepro;
  route: SparkReproRoute;
  gitChangeRef: ArtifactRef;
}): Promise<void> {
  assertSparkReproDriverGitAuthorization({
    repro: input.repro,
    route: input.route,
    operation: "draft_submit",
    gitChangeRef: input.gitChangeRef,
  });
  const store = defaultArtifactStore(input.workspaceCwd);
  const artifact = await store.get<GitChangeArtifactBody>(input.gitChangeRef);
  if (artifact.kind !== "git_change") throw new Error("canonical Artifact is not a GitChange");
  const branch = formalizeLayerBranch(input.repro, input.route.workItemId);
  const entry = artifact.body.stack.entries.find((candidate) => candidate.branch === branch);
  if (!entry) throw new Error(`canonical stack has no WorkItem layer ${branch}`);
  if (entry.pullRequest) return;
  const service = new GitLifecycleService({
    cwd: input.repositoryCwd,
    workspaceRoot: input.workspaceCwd,
    store,
  });
  // Intentionally no ready=true path: active Repro generations may create only Draft PRs.
  await service.submit(input.gitChangeRef);
}

function formalizeLayerBranch(repro: SparkSessionRepro, workItemId: string): string {
  return `spark/${safeName(`repro-${repro.reproId}-${workItemId}`)}`;
}

async function defaultEnsureTask(input: EnsureTaskInput): Promise<TaskRef> {
  const name = safeName(`repro-${input.route.routeId}`);
  const result = await defaultTaskGraphStore(input.workspaceCwd).update(
    (graph) => {
      const existing = graph.tasks(input.projectRef).find((candidate) => candidate.name === name);
      if (existing) {
        if (
          existing.roleRef !== roleForLane(input.targetLane) ||
          !existing.artifactRefs.includes(input.gitChangeRef)
        ) {
          throw new Error(`route Task ${name} already exists with another binding`);
        }
        return existing.ref;
      }
      const workItem = input.repro.threeLane.workItems.find(
        (candidate) => candidate.workItemId === input.route.workItemId,
      );
      if (!workItem) throw new Error(`unknown route WorkItem: ${input.route.workItemId}`);
      const roleRef = roleForLane(input.targetLane);
      const task = graph.createTask({
        projectRef: input.projectRef,
        name,
        title: `${laneTitle(input.targetLane)}: ${workItem.title}`,
        description: routeTaskDescription(
          input.repro,
          input.route,
          input.targetLane,
          input.targetBindingRevision,
          input.targetSourceRevision,
        ),
        kind: "generic",
        status: "ready",
        roleRef,
        artifactRefs: [input.gitChangeRef],
        inputEvidenceRefs: input.inputEvidenceRefs,
        executionPolicy: {
          sessionLifetime: "task_revision",
          continuity: "reuse_within_revision",
          isolation: "isolated_worktree",
          comparison: "single_side",
          worktreeTarget: {
            primaryArtifactRef: input.gitChangeRef,
            writableArtifactRefs: [input.gitChangeRef],
          },
          concurrencyKeys: [writerConcurrencyKey(input.repro, input.route, input.targetLane)],
          maxAttempts: 3,
        },
        plan: {
          objective: `Produce a valid ${input.targetLane} lane result for ${workItem.workItemId}.`,
          contextRefs: [input.route.evidenceRef, input.gitChangeRef],
          constraints: [
            "Write only the assigned GitChange worktree.",
            "Do not Ask the user directly.",
            "Finish with spark.repro.lane-result/v1 JSON Evidence.",
          ],
          nonGoals: ["Publishing Ready, merging, force-pushing, or cleaning external state."],
          successCriteria: ["One revision-fenced lane-result Evidence is linked to the Task."],
          evidenceRequired: ["spark.repro.lane-result/v1"],
          steps: ["Execute lane-local work", "Validate", "Write lane-result Evidence"],
          riskLevel: "normal",
          openQuestions: [],
          askRefs: [],
        },
      });
      return task.ref;
    },
    { createIfMissing: false },
  );
  if (!result.graph) throw new Error("Repro route TaskGraph is unavailable");
  return result.result;
}

function routeEvidenceRefs(repro: SparkSessionRepro, route: SparkReproRoute): EvidenceRef[] {
  const handoffEvidence = repro.threeLane.handoffs
    .filter(
      (handoff) =>
        handoff.workItemId === route.workItemId &&
        handoff.from === route.fromLane &&
        handoff.status === "accepted",
    )
    .flatMap((handoff) => handoff.evidenceRefs);
  return [...new Set([route.evidenceRef, ...handoffEvidence])];
}

function routeSourceRevision(repro: SparkSessionRepro, route: SparkReproRoute): string {
  if (route.action !== "refresh_binding") return route.sourceRevision;
  const binding = route.toLane
    ? sparkReproLaneBinding(repro.threeLane, route.workItemId, route.toLane)
    : undefined;
  if (!binding) throw new Error("refresh route has no target binding");
  return binding.sourceRevision;
}

function roleForLane(lane: SparkReproLane): RoleRef {
  if (lane === "implementation") {
    return "role:extension-repro-implementation-explorer" as RoleRef;
  }
  if (lane === "exactness") {
    return "role:extension-repro-exactness-instrumentation-worker" as RoleRef;
  }
  return "role:extension-repro-precision-fixer" as RoleRef;
}

function writerConcurrencyKey(
  repro: SparkSessionRepro,
  route: SparkReproRoute,
  lane: SparkReproLane,
): string {
  return lane === "formalize"
    ? `repro:${repro.reproId}:formalize:writer`
    : `repro:${repro.reproId}:${route.workItemId}:${lane}:writer`;
}

function laneTitle(lane: SparkReproLane): string {
  return lane === "implementation"
    ? "Implementation"
    : lane === "exactness"
      ? "Exactness"
      : "Formalize";
}

function routeTaskDescription(
  repro: SparkSessionRepro,
  route: SparkReproRoute,
  lane: SparkReproLane,
  targetBindingRevision: number,
  targetSourceRevision: string,
): string {
  const baseline = repro.threeLane.formalize.formalizedTip ?? route.sourceRevision;
  return [
    `Repro ${repro.reproId}; WorkItem ${route.workItemId}; lane ${lane}.`,
    `Route ${route.routeId}; planRevision=${route.planRevision}; sourceBindingRevision=${route.sourceBindingRevision}.`,
    `Result bindingRevision=${targetBindingRevision}; result sourceRevision=${targetSourceRevision}.`,
    `Explore baseline ${baseline}. Exactness imports only accepted handoff candidate revisions.`,
    ...(route.action === "refresh_binding"
      ? [
          "Refresh the original lane worktree to the accepted canonical revision, drop only explicitly superseded revisions, rerun lane-local validation, and write refresh Evidence before convergence.",
        ]
      : []),
    ...(lane === "formalize"
      ? [
          "Integrate serially into only the assigned canonical stack layer; the formalized result must include fresh precision and numerical-audit evidence before Draft publication.",
        ]
      : []),
    "The lane result must bind the actual TaskRef and TaskRun RunRef and must not contain model-specific assumptions.",
  ].join("\n");
}

function safeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  if (!normalized) throw new Error("unable to derive a stable Repro route name");
  return normalized;
}

function stableWireId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameRouteAuthority(left: SparkReproRoute, right: SparkReproRoute): boolean {
  return (
    left.routeId === right.routeId &&
    left.resultId === right.resultId &&
    left.action === right.action &&
    left.workItemId === right.workItemId &&
    left.fromLane === right.fromLane &&
    left.toLane === right.toLane &&
    left.planRevision === right.planRevision &&
    left.sourceBindingRevision === right.sourceBindingRevision &&
    left.sourceRevision === right.sourceRevision &&
    left.evidenceRef === right.evidenceRef
  );
}
