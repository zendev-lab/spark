import { createHash } from "node:crypto";

import {
  GitRevisionMaterializationService,
  GitLifecycleError,
  GitLifecycleService,
  defaultArtifactStore,
  defaultEvidenceStore,
  defaultGitCommandRunner,
  gitHubRepositoryFromRemote,
  type ArtifactRef,
  type EvidenceRef,
} from "@zendev-lab/spark-artifacts";
import {
  nowIso,
  type ExtensionUi,
  type RoleRef,
  type RunRef,
  type TaskRef,
  type TaskRun,
} from "@zendev-lab/spark-core";
import { verifyCanonicalAnswerEventEvidence } from "@zendev-lab/spark-ask";
import { sparkStateCwd, type SparkSessionContext } from "@zendev-lab/spark-loop";
import { createAutonomousAskInteractionRequestId } from "@zendev-lab/spark-protocol";
import {
  acknowledgeSparkReproRoute,
  bindSparkReproFormalizeOwnership,
  enqueueSparkReproWork,
  materializeSparkReproRouteBinding,
  parseSparkReproLaneResult,
  reconcileSparkReproLaneResult,
  rejectSparkReproLaneResult,
  resumeSparkReproRouteFromAnswer,
  resumeSparkReproRouteFromRecovery,
  resumeSparkReproRouteFromRepair,
  sparkReproLaneBinding,
  sparkReproLaneResultEvidenceRefs,
  type SparkReproLane,
  type SparkReproLaneResult,
  type SparkReproRoute,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import { createSparkRoleRegistry } from "@zendev-lab/spark-roles";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

import {
  dispatchManagedTaskSessions,
  reserveManagedTaskSessions,
  type ManagedTaskSessionDispatchRecord,
} from "./spark-task-session-dispatch.ts";
import { readSessionRepro, writeSessionRepro } from "./spark-session-repro.ts";

const LANES = ["implementation", "exactness", "formalize"] as const;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "blocked", "failed", "cancelled", "stale"]);
const OWNER_RECONCILIATIONS = new Map<string, Promise<void>>();

type SparkReproRuntimeContext = SparkSessionContext & { ui?: ExtensionUi };

export interface SparkReproLaneRuntimeTopology {
  repro: SparkSessionRepro;
  workItemId: string;
  sourceRevision: string;
  lanes: Record<
    SparkReproLane,
    {
      artifactRef: ArtifactRef;
      taskRef: TaskRef;
      runRef: RunRef;
      sessionId: string;
    }
  >;
}

export interface SparkReproLaneRuntimeDeps {
  repositoryIdentity?: (cwd: string) => Promise<string>;
  resolveSourceRevision?: (cwd: string) => Promise<string>;
  persist?: (repro: SparkSessionRepro) => Promise<void>;
  reserve?: typeof reserveManagedTaskSessions;
  dispatch?: typeof dispatchManagedTaskSessions;
  ensureInitialArtifacts?: (input: {
    cwd: string;
    stateCwd: string;
    repository: string;
    repro: SparkSessionRepro;
    workItemId: string;
    sourceRevision: string;
  }) => Promise<Record<SparkReproLane, ArtifactRef>>;
  prepareRouteRevision?: typeof prepareRouteRevision;
  submitFormalizeDraft?: (input: {
    cwd: string;
    stateCwd: string;
    artifactRef: ArtifactRef;
  }) => Promise<void>;
}

/** Route a Root startup or one completed child Session to its owning Repro. */
export async function reconcileSparkReproRuntimeForSession(input: {
  cwd: string;
  ctx: SparkReproRuntimeContext;
}): Promise<SparkSessionRepro | undefined> {
  const stateCwd = sparkStateCwd(input.cwd, input.ctx);
  const graph = await defaultTaskGraphStore(stateCwd).load();
  const currentSessionId = input.ctx.sessionId?.trim();
  const ownedRun = currentSessionId
    ? graph
        ?.runs()
        .find(
          (run) =>
            (run.execution?.sessionId ?? run.execution?.executionSessionId) === currentSessionId,
        )
    : undefined;
  const ownerSessionId = ownedRun?.execution?.ownerSessionId ?? currentSessionId;
  if (!ownerSessionId) return undefined;
  const ownerCtx = { ...input.ctx, sessionId: ownerSessionId };
  return await withOwnerReconciliation(`${stateCwd}:${ownerSessionId}`, async () => {
    const repro = await readSessionRepro(input.cwd, ownerCtx);
    if (!repro?.projectRef || repro.status !== "active") return repro;
    return await reconcileSparkReproThreeLaneRuntime({
      cwd: input.cwd,
      ctx: ownerCtx,
      ownerSessionId,
      repro,
    });
  });
}

/**
 * Persist `/repro <objective>` as one WorkItem checkpoint, then idempotently
 * reserve all three lane TaskRuns and create their stable child Sessions. Only
 * the Implementation reservation is invoked until a typed route unlocks the
 * next lane.
 */
export async function launchSparkReproThreeLaneRuntime(input: {
  cwd: string;
  ctx: SparkReproRuntimeContext;
  ownerSessionId: string;
  repro: SparkSessionRepro;
  deps?: SparkReproLaneRuntimeDeps;
}): Promise<SparkReproLaneRuntimeTopology> {
  if (!input.repro.projectRef) throw new Error("three-lane Repro launch requires a Project");
  const projectRef = input.repro.projectRef;
  const stateCwd = sparkStateCwd(input.cwd, input.ctx);
  const persist =
    input.deps?.persist ?? ((repro) => writeSessionRepro(input.cwd, repro, input.ctx));
  const workItemId = primaryWorkItemId(input.repro.reproId);
  const existingWorkItem = input.repro.threeLane.workItems.find(
    (item) => item.workItemId === workItemId,
  );
  const sourceRevision =
    existingWorkItem?.sourceRevision ??
    input.repro.threeLane.formalize.formalizedTip ??
    (await (input.deps?.resolveSourceRevision ?? resolveHeadRevision)(input.cwd));
  const title = input.repro.goalContract.objective.trim() || input.repro.reproId;
  const enqueued = enqueueSparkReproWork(input.repro.threeLane, {
    enqueue: {
      schema: "spark.repro.work-enqueue/v1",
      workItemId,
      title,
      scope: title,
    },
    sourceRevision,
  });
  let repro = updateReproThreeLane(input.repro, enqueued.state);
  if (enqueued.changed) await persist(repro);

  const repository = await (input.deps?.repositoryIdentity ?? resolveRepositoryIdentity)(input.cwd);
  const artifactRefs = await (input.deps?.ensureInitialArtifacts ?? ensureInitialLaneArtifacts)({
    cwd: input.cwd,
    stateCwd,
    repository,
    repro,
    workItemId,
    sourceRevision,
  });
  const taskRefs = await ensureLaneTasks({
    stateCwd,
    repro,
    workItemId,
    artifactRefs,
  });
  const registry = await createSparkRoleRegistry(stateCwd);
  const graphBeforeReservation = await defaultTaskGraphStore(stateCwd).load();
  if (!graphBeforeReservation) throw new Error("three-lane Repro TaskGraph is unavailable");
  const reservable = LANES.map((lane) => taskRefs[lane]).filter((taskRef) => {
    const active = graphBeforeReservation
      .runs(repro.projectRef)
      .find(
        (run) => run.taskRef === taskRef && (run.status === "queued" || run.status === "running"),
      );
    return !active || (active.status === "queued" && !active.execution?.invocationId);
  });
  if (reservable.length > 0) {
    await (input.deps?.reserve ?? reserveManagedTaskSessions)({
      cwd: input.cwd,
      ctx: input.ctx,
      ownerSessionId: input.ownerSessionId,
      projectRef,
      taskRefs: reservable,
      registry,
    });
  }
  const reservations = await currentLaneReservations(stateCwd, repro, taskRefs);

  const startRoute = repro.threeLane.routes.find(
    (route) => route.workItemId === workItemId && route.action === "start_binding",
  );
  if (!startRoute) throw new Error("three-lane Repro launch checkpoint has no start route");
  if (!sparkReproLaneBinding(repro.threeLane, workItemId, "implementation")) {
    repro = updateReproThreeLane(
      repro,
      materializeSparkReproRouteBinding(repro.threeLane, {
        routeId: startRoute.routeId,
        taskRef: taskRefs.implementation,
        gitChangeRef: artifactRefs.implementation,
      }),
    );
    await persist(repro);
  }
  const formalizeReservation = reservations.formalize;
  if (!repro.threeLane.formalize.ownership) {
    repro = updateReproThreeLane(
      repro,
      bindSparkReproFormalizeOwnership(repro.threeLane, {
        gitChangeRef: artifactRefs.formalize,
        integratorSessionId: formalizeReservation.sessionId,
      }),
    );
    await persist(repro);
  }

  const implementationRun = await requireCurrentRun(stateCwd, repro, taskRefs.implementation);
  if (startRoute.status === "pending") {
    if (!implementationRun.execution?.invocationId && !isTerminalRun(implementationRun)) {
      await dispatchRouteTask({
        cwd: input.cwd,
        ctx: input.ctx,
        ownerSessionId: input.ownerSessionId,
        repro,
        route: startRoute,
        taskRef: taskRefs.implementation,
        registry,
        dispatch: input.deps?.dispatch,
      });
    }
    repro = updateReproThreeLane(
      repro,
      acknowledgeSparkReproRoute(repro.threeLane, startRoute.routeId),
    );
    await persist(repro);
  }

  repro = await reconcileSparkReproThreeLaneRuntime({
    cwd: input.cwd,
    ctx: input.ctx,
    ownerSessionId: input.ownerSessionId,
    repro,
    deps: { ...input.deps, persist },
  });

  return {
    repro,
    workItemId,
    sourceRevision,
    lanes: {
      implementation: {
        artifactRef: artifactRefs.implementation,
        taskRef: taskRefs.implementation,
        ...reservations.implementation,
      },
      exactness: {
        artifactRef: artifactRefs.exactness,
        taskRef: taskRefs.exactness,
        ...reservations.exactness,
      },
      formalize: {
        artifactRef: artifactRefs.formalize,
        taskRef: taskRefs.formalize,
        ...reservations.formalize,
      },
    },
  };
}

/** Process only terminal runs attached to current bindings, then advance pending routes. */
export async function reconcileSparkReproThreeLaneRuntime(input: {
  cwd: string;
  ctx: SparkReproRuntimeContext;
  ownerSessionId: string;
  repro: SparkSessionRepro;
  deps?: SparkReproLaneRuntimeDeps;
}): Promise<SparkSessionRepro> {
  if (!input.repro.projectRef || input.repro.status !== "active") return input.repro;
  const stateCwd = sparkStateCwd(input.cwd, input.ctx);
  const persist =
    input.deps?.persist ?? ((repro) => writeSessionRepro(input.cwd, repro, input.ctx));
  const graph = await defaultTaskGraphStore(stateCwd).load();
  if (!graph) return input.repro;
  let repro = input.repro;
  repro = await resumeAnsweredAttentionRoutes(stateCwd, repro);
  if (repro !== input.repro) await persist(repro);
  const currentTaskRefs = new Set(repro.threeLane.bindings.map((binding) => binding.taskRef));
  const terminalRuns = graph
    .runs(repro.projectRef)
    .filter((run) => currentTaskRefs.has(run.taskRef) && isTerminalRun(run))
    .sort((left, right) => (left.finishedAt ?? "").localeCompare(right.finishedAt ?? ""));
  for (const run of terminalRuns) {
    const ingested = await ingestSparkReproTerminalTaskRun({ stateCwd, repro, run });
    if (ingested !== repro) {
      repro = ingested;
      await persist(repro);
    }
  }
  const recovered = checkpointUnacceptedTerminalRuns(repro, graph.runs(repro.projectRef));
  if (recovered !== repro) {
    repro = recovered;
    await persist(repro);
  }
  await ensureFormalizeDraft({ ...input, repro, stateCwd });
  return await advancePendingRoutes({ ...input, repro, persist, stateCwd });
}

function checkpointUnacceptedTerminalRuns(
  repro: SparkSessionRepro,
  runs: TaskRun[],
): SparkSessionRepro {
  let state = repro.threeLane;
  const acceptedEvidenceRefs = new Set(
    state.resultReceipts
      .filter((receipt) => receipt.status === "accepted")
      .map((receipt) => receipt.evidenceRef),
  );
  for (const binding of state.bindings) {
    const run = runs.filter((candidate) => candidate.taskRef === binding.taskRef).at(-1);
    if (!run || !isTerminalRun(run)) continue;
    const outputEvidenceRefs = [
      ...run.outputEvidenceRefs,
      ...(run.completionSummary?.evidenceRefs ?? []),
    ];
    if (outputEvidenceRefs.some((ref) => acceptedEvidenceRefs.has(ref))) continue;
    state = resumeSparkReproRouteFromRecovery(state, {
      workItemId: binding.workItemId,
      lane: binding.lane,
      runRef: run.ref,
      recoveryDigest: digest(
        canonicalJson({
          runRef: run.ref,
          status: run.status,
          finishedAt: run.finishedAt,
          outputEvidenceRefs: [...new Set(outputEvidenceRefs)].sort(),
        }),
      ),
    });
  }
  return updateReproThreeLane(repro, state);
}

/** Manual replay resolves the exact TaskRun and delegates to terminal ingestion. */
export async function replaySparkReproLaneResult(input: {
  cwd: string;
  ctx: SparkReproRuntimeContext;
  ownerSessionId: string;
  repro: SparkSessionRepro;
  evidenceRef: EvidenceRef;
  deps?: SparkReproLaneRuntimeDeps;
}): Promise<SparkSessionRepro> {
  if (!input.repro.projectRef) throw new Error("lane result replay requires a Project");
  const stateCwd = sparkStateCwd(input.cwd, input.ctx);
  const evidence = await defaultEvidenceStore(stateCwd).get(input.evidenceRef);
  const result = parseLaneResultEvidence(evidence);
  const graph = await defaultTaskGraphStore(stateCwd).load();
  const run = graph
    ?.runs(input.repro.projectRef)
    .find((candidate) => candidate.ref === result.runRef);
  if (!run) throw new Error(`lane result references unknown TaskRun ${result.runRef}`);
  const repro = await ingestSparkReproTerminalTaskRun({
    stateCwd,
    repro: input.repro,
    run,
    carrierEvidenceRef: input.evidenceRef,
  });
  const persist = input.deps?.persist ?? ((next) => writeSessionRepro(input.cwd, next, input.ctx));
  if (repro !== input.repro) await persist(repro);
  await ensureFormalizeDraft({ ...input, repro, stateCwd });
  return await advancePendingRoutes({ ...input, repro, persist, stateCwd });
}

async function ingestSparkReproTerminalTaskRun(input: {
  stateCwd: string;
  repro: SparkSessionRepro;
  run: TaskRun;
  carrierEvidenceRef?: EvidenceRef;
}): Promise<SparkSessionRepro> {
  if (!isTerminalRun(input.run)) throw new Error(`TaskRun ${input.run.ref} is not terminal`);
  const runEvidenceRefs = new Set([
    ...input.run.outputEvidenceRefs,
    ...(input.run.completionSummary?.evidenceRefs ?? []),
  ]);
  const candidates = input.carrierEvidenceRef
    ? [input.carrierEvidenceRef]
    : [...runEvidenceRefs].sort();
  const store = defaultEvidenceStore(input.stateCwd);
  let repro = input.repro;
  for (const evidenceRef of candidates) {
    const already = repro.threeLane.resultReceipts.some(
      (receipt) => receipt.evidenceRef === evidenceRef,
    );
    if (already) continue;
    const evidence = await store.tryGet(evidenceRef);
    if (!evidence || evidence.format !== "json") continue;
    if (!isRecord(evidence.body) || evidence.body.schema !== "spark.repro.lane-result/v1") continue;
    const result = parseSparkReproLaneResult(evidence.body);
    const referenced = sparkReproLaneResultEvidenceRefs(result);
    const referencedRecords = await Promise.all(referenced.map((ref) => store.tryGet(ref)));
    const provenanceMatches =
      evidence.provenance.runRef === input.run.ref &&
      evidence.provenance.taskRef === input.run.taskRef &&
      result.runRef === input.run.ref &&
      result.taskRef === input.run.taskRef;
    const allEvidenceBelongsToRun =
      runEvidenceRefs.has(evidenceRef) &&
      referenced.every((ref, index) => {
        const record = referencedRecords[index];
        return (
          runEvidenceRefs.has(ref) &&
          record?.provenance.runRef === input.run.ref &&
          record.provenance.taskRef === input.run.taskRef
        );
      });
    const formalizeSession =
      input.run.execution?.sessionId ?? input.run.execution?.executionSessionId;
    const integratorMatches =
      result.lane !== "formalize" ||
      formalizeSession === repro.threeLane.formalize.ownership?.integratorSessionId;
    if (!provenanceMatches || !integratorMatches) {
      const rejected = rejectSparkReproLaneResult({
        state: repro.threeLane,
        evidenceRef,
        result,
        reason: "invalid_provenance",
      });
      repro = updateReproThreeLane(repro, rejected.state);
      continue;
    }
    if (!allEvidenceBelongsToRun) {
      const rejected = rejectSparkReproLaneResult({
        state: repro.threeLane,
        evidenceRef,
        result,
        reason: "missing_evidence",
      });
      repro = updateReproThreeLane(repro, rejected.state);
      continue;
    }
    const accepted = reconcileSparkReproLaneResult({
      state: repro.threeLane,
      reproId: repro.reproId,
      evidenceRef,
      result,
    });
    repro = updateReproThreeLane(repro, accepted.state);
    if (
      (result.kind === "implementation_candidate" || result.kind === "exactness_finding") &&
      accepted.state.resultReceipts.some(
        (receipt) => receipt.resultId === accepted.resultId && receipt.status === "accepted",
      )
    ) {
      await reopenLaneTask(input.stateCwd, result.taskRef as TaskRef);
    }
  }
  return repro;
}

async function advancePendingRoutes(input: {
  cwd: string;
  ctx: SparkReproRuntimeContext;
  ownerSessionId: string;
  repro: SparkSessionRepro;
  persist: (repro: SparkSessionRepro) => Promise<void>;
  stateCwd: string;
  deps?: SparkReproLaneRuntimeDeps;
}): Promise<SparkSessionRepro> {
  if (!input.repro.projectRef) return input.repro;
  let repro = input.repro;
  const pendingRoutes = repro.threeLane.routes.filter((route) => route.status === "pending");
  if (pendingRoutes.length === 0) return repro;
  let repository: string | undefined;
  let registry: Awaited<ReturnType<typeof createSparkRoleRegistry>> | undefined;
  for (const route of pendingRoutes) {
    if (route.action === "root_attention") {
      await requestRootAttention(input.ctx, input.ownerSessionId, repro, route);
      continue;
    }
    repository ??= await (input.deps?.repositoryIdentity ?? resolveRepositoryIdentity)(input.cwd);
    registry ??= await createSparkRoleRegistry(input.stateCwd);
    const lane = route.toLane;
    const taskRef = await laneTaskRef(input.stateCwd, repro, lane);
    const artifactRef = laneArtifactRef(repro.reproId, primaryWorkItemId(repro.reproId), lane);
    const currentBinding = sparkReproLaneBinding(repro.threeLane, route.workItemId, lane);
    try {
      await (input.deps?.prepareRouteRevision ?? prepareRouteRevision)({
        cwd: input.cwd,
        stateCwd: input.stateCwd,
        repository,
        repro,
        route,
        artifactRef,
        currentBindingRevision: currentBinding?.sourceRevision,
      });
    } catch (error) {
      if (
        !(error instanceof GitLifecycleError) ||
        error.code !== "materialization_conflict" ||
        (route.action !== "materialize_binding" && route.action !== "refresh_binding")
      ) {
        throw error;
      }
      const sourceTaskRef = await laneTaskRef(input.stateCwd, repro, route.fromLane);
      const repair = await recordGitRepairEvidence({
        stateCwd: input.stateCwd,
        repro,
        route,
        taskRef: sourceTaskRef,
        artifactRef,
        error,
      });
      repro = updateReproThreeLane(
        repro,
        resumeSparkReproRouteFromRepair(repro.threeLane, {
          failedRouteId: route.routeId,
          repairDigest: repair.digest,
          evidenceRef: repair.evidenceRef,
        }),
      );
      await input.persist(repro);
      return await advancePendingRoutes({ ...input, repro });
    }
    if (!currentBinding || currentBinding.originRouteId !== route.routeId) {
      repro = updateReproThreeLane(
        repro,
        materializeSparkReproRouteBinding(repro.threeLane, {
          routeId: route.routeId,
          taskRef,
          gitChangeRef: artifactRef,
          ...(route.cause.evidenceRef ? { evidenceRefs: [route.cause.evidenceRef] } : {}),
        }),
      );
      await input.persist(repro);
    }
    const run = await latestTaskRun(input.stateCwd, repro, taskRef);
    if (run?.execution?.invocationId && !isTerminalRun(run)) {
      repro = updateReproThreeLane(
        repro,
        acknowledgeSparkReproRoute(repro.threeLane, route.routeId),
      );
      await input.persist(repro);
      continue;
    }
    if (!run || isTerminalRun(run)) await reopenLaneTask(input.stateCwd, taskRef);
    await dispatchRouteTask({
      cwd: input.cwd,
      ctx: input.ctx,
      ownerSessionId: input.ownerSessionId,
      repro,
      route,
      taskRef,
      registry,
      dispatch: input.deps?.dispatch,
    });
    repro = updateReproThreeLane(repro, acknowledgeSparkReproRoute(repro.threeLane, route.routeId));
    await input.persist(repro);
  }
  return repro;
}

async function ensureFormalizeDraft(input: {
  cwd: string;
  stateCwd: string;
  repro: SparkSessionRepro;
  deps?: SparkReproLaneRuntimeDeps;
}): Promise<void> {
  if (!input.repro.threeLane.formalize.formalizedTip) return;
  const artifactRef = input.repro.threeLane.formalize.ownership?.gitChangeRef;
  if (!artifactRef) throw new Error("formalized Repro has no canonical GitChange owner");
  const artifact = await defaultArtifactStore(input.stateCwd).get(artifactRef);
  if (artifact.kind !== "git_change" || artifact.body.kind !== "git_change") {
    throw new Error(`${artifactRef} is not a GitChange`);
  }
  const activeEntries = artifact.body.stack.entries.filter((entry) => !entry.isMerged);
  if (activeEntries.some((entry) => entry.pullRequest?.draft === false)) {
    throw new Error("Formalize canonical stack contains a non-Draft pull request");
  }
  if (
    activeEntries.length > 0 &&
    activeEntries.every((entry) => entry.pullRequest?.draft === true)
  ) {
    return;
  }
  if (input.deps?.submitFormalizeDraft) {
    await input.deps.submitFormalizeDraft({
      cwd: input.cwd,
      stateCwd: input.stateCwd,
      artifactRef,
    });
    return;
  }
  await new GitLifecycleService({
    cwd: input.cwd,
    workspaceRoot: input.stateCwd,
  }).submit(artifactRef);
}

async function resumeAnsweredAttentionRoutes(
  stateCwd: string,
  repro: SparkSessionRepro,
): Promise<SparkSessionRepro> {
  const pending = repro.threeLane.routes.filter(
    (route) => route.action === "root_attention" && route.status === "pending",
  );
  if (pending.length === 0) return repro;
  const evidenceRecords = await defaultEvidenceStore(stateCwd).list({ producer: "ask" });
  let state = repro.threeLane;
  for (const route of pending) {
    if (route.action !== "root_attention") continue;
    for (const evidence of evidenceRecords) {
      const event = await verifyCanonicalAnswerEventEvidence(stateCwd, evidence);
      if (
        !event ||
        event.binding.goalOrReproId !== repro.reproId ||
        event.binding.ownerStepOrUnresolvedId !== route.routeId ||
        event.binding.expectedAnswerKind !== route.attention.expectedAnswerKind
      ) {
        continue;
      }
      state = resumeSparkReproRouteFromAnswer(state, {
        attentionRouteId: route.routeId,
        answerId: event.answerEventId,
        answerDigest: digest(canonicalJson(event.answers)),
        evidenceRef: evidence.ref,
      });
      break;
    }
  }
  return updateReproThreeLane(repro, state);
}

async function requestRootAttention(
  ctx: SparkReproRuntimeContext,
  ownerSessionId: string,
  repro: SparkSessionRepro,
  route: Extract<SparkReproRoute, { action: "root_attention" }>,
): Promise<void> {
  if (!ctx.ui?.interaction) return;
  const requestHash = digest(
    canonicalJson({
      reproId: repro.reproId,
      routeId: route.routeId,
      decisionKey: route.decisionKey,
      attention: route.attention,
    }),
  );
  await ctx.ui.interaction({
    kind: "askFlow",
    requestId: createAutonomousAskInteractionRequestId(requestHash),
    toolCallId: `repro-attention:${requestHash}`,
    title: "Repro decision required",
    prompt: route.attention.reason,
    source: "extension",
    delivery: "async",
    mode: "decision",
    evidenceRequest: {
      schema: "spark.evidence-request/v1",
      askRef: `ask:${requestHash}`,
      ownerSessionId,
      goalOrReproId: repro.reproId,
      modeScope: "repro",
      planRevision: route.planRevision,
      ownerStepOrUnresolvedId: route.routeId,
      stepDefinitionDigest: route.cause.digest,
      requestHash,
      ownerQuestionId: route.decisionKey,
      expectedAnswerKind: route.attention.expectedAnswerKind,
    },
    questions: [
      {
        id: route.decisionKey,
        prompt: route.attention.question,
        type: route.attention.expectedAnswerKind,
        required: true,
        defaultValues: [],
      },
    ],
    allowElaborate: true,
  });
}

async function ensureInitialLaneArtifacts(input: {
  cwd: string;
  stateCwd: string;
  repository: string;
  repro: SparkSessionRepro;
  workItemId: string;
  sourceRevision: string;
}): Promise<Record<SparkReproLane, ArtifactRef>> {
  const service = new GitRevisionMaterializationService({
    cwd: input.cwd,
    workspaceRoot: input.stateCwd,
  });
  const entries = await Promise.all(
    LANES.map(async (lane) => {
      const artifactRef = laneArtifactRef(input.repro.reproId, input.workItemId, lane);
      await service.materialize({
        action: "create_candidate",
        operationId: `repro:${input.repro.reproId}:${input.workItemId}:${lane}:launch`,
        authority: "driver_local",
        repository: input.repository,
        artifactRef,
        title: `Repro ${input.repro.reproId} ${lane}`,
        branch: `spark/${safeName(`repro-${input.repro.reproId}-${lane}`)}`,
        baselineRevision: input.sourceRevision,
        repositoryPath: input.cwd,
      });
      return [lane, artifactRef] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<SparkReproLane, ArtifactRef>;
}

async function ensureLaneTasks(input: {
  stateCwd: string;
  repro: SparkSessionRepro;
  workItemId: string;
  artifactRefs: Record<SparkReproLane, ArtifactRef>;
}): Promise<Record<SparkReproLane, TaskRef>> {
  if (!input.repro.projectRef) throw new Error("lane Tasks require a Project");
  const updated = await defaultTaskGraphStore(input.stateCwd).update(
    (graph) => {
      const refs = {} as Record<SparkReproLane, TaskRef>;
      for (const lane of LANES) {
        const name = laneTaskName(input.repro.reproId, lane);
        const existing = graph.tasks(input.repro.projectRef!).find((task) => task.name === name);
        const roleRef = roleForLane(lane);
        if (existing) {
          if (
            existing.roleRef !== roleRef ||
            !existing.artifactRefs.includes(input.artifactRefs[lane])
          ) {
            throw new Error(`Repro lane Task ${name} has a conflicting owner`);
          }
          refs[lane] = existing.ref;
          continue;
        }
        const planItemAt = new Date().toISOString();
        const task = graph.createTask({
          projectRef: input.repro.projectRef!,
          name,
          title: `${laneTitle(lane)}: ${input.repro.goalContract.objective}`,
          description: `Stable ${lane} execution lane for ${input.workItemId}.`,
          kind: "generic",
          status: "ready",
          roleRef,
          artifactRefs: [input.artifactRefs[lane]],
          executionPolicy: {
            sessionLifetime: "task_revision",
            continuity: "reuse_within_revision",
            isolation: "isolated_worktree",
            comparison: "single_side",
            worktreeTarget: {
              primaryArtifactRef: input.artifactRefs[lane],
              writableArtifactRefs: [input.artifactRefs[lane]],
            },
            concurrencyKeys: [`repro:${input.repro.reproId}:${lane}:writer`],
            maxAttempts: 3,
          },
          plan: {
            objective: `Produce typed ${lane} lane results for ${input.workItemId}.`,
            contextRefs: [input.artifactRefs[lane]],
            constraints: [
              "Write only the assigned GitChange worktree.",
              "Never Ask the user directly.",
              "Bind every result to the supplied route, TaskRef, and RunRef.",
            ],
            nonGoals: ["Ready, merge, force-push, or external cleanup."],
            successCriteria: [
              "The attached spark.repro.lane-result/v1 JSON parses strictly and matches the current route, TaskRef, RunRef, source revision, and lane validation outcome.",
            ],
            evidenceRequired: [
              "A spark.repro.lane-result/v1 JSON Evidence record and every referenced validation Evidence linked to the current TaskRun.",
            ],
            steps: [],
            items: [
              {
                id: `${lane}-execute`,
                title: `Execute bounded ${lane} work`,
                description:
                  "Change or inspect only the assigned GitChange at the frozen source revision.",
                status: "pending",
                createdAt: planItemAt,
                updatedAt: planItemAt,
              },
              {
                id: `${lane}-validate`,
                title: `Validate ${lane} outcome`,
                description: "Run the lane-specific checks and retain inspectable output Evidence.",
                status: "pending",
                createdAt: planItemAt,
                updatedAt: planItemAt,
              },
              {
                id: `${lane}-record`,
                title: "Record the typed lane result",
                description:
                  "Attach one strict result carrier and all referenced Evidence to this TaskRun.",
                status: "pending",
                createdAt: planItemAt,
                updatedAt: planItemAt,
              },
            ],
            riskLevel: "normal",
            openQuestions: [],
            askRefs: [],
          },
        });
        refs[lane] = task.ref;
      }
      return refs;
    },
    { createIfMissing: false },
  );
  if (!updated.graph) throw new Error("Repro lane TaskGraph is unavailable");
  return updated.result;
}

async function currentLaneReservations(
  stateCwd: string,
  repro: SparkSessionRepro,
  taskRefs: Record<SparkReproLane, TaskRef>,
): Promise<Record<SparkReproLane, { runRef: RunRef; sessionId: string }>> {
  if (!repro.projectRef) throw new Error("lane reservations require a Project");
  const graph = await defaultTaskGraphStore(stateCwd).load();
  if (!graph) throw new Error("Repro lane TaskGraph is unavailable");
  const result = {} as Record<SparkReproLane, { runRef: RunRef; sessionId: string }>;
  for (const lane of LANES) {
    const run = graph
      .runs(repro.projectRef)
      .filter((candidate) => candidate.taskRef === taskRefs[lane])
      .at(-1);
    const sessionId = run?.execution?.sessionId ?? run?.execution?.executionSessionId;
    if (!run || !sessionId) throw new Error(`Repro ${lane} Session reservation is missing`);
    result[lane] = { runRef: run.ref, sessionId };
  }
  return result;
}

async function dispatchRouteTask(input: {
  cwd: string;
  ctx: SparkReproRuntimeContext;
  ownerSessionId: string;
  repro: SparkSessionRepro;
  route: SparkReproRoute;
  taskRef: TaskRef;
  registry: Awaited<ReturnType<typeof createSparkRoleRegistry>>;
  dispatch?: typeof dispatchManagedTaskSessions;
}): Promise<ManagedTaskSessionDispatchRecord[]> {
  if (!input.repro.projectRef) throw new Error("route dispatch requires a Project");
  return await (input.dispatch ?? dispatchManagedTaskSessions)({
    cwd: input.cwd,
    ctx: input.ctx,
    ownerSessionId: input.ownerSessionId,
    projectRef: input.repro.projectRef,
    taskRefs: [input.taskRef],
    registry: input.registry,
    renderPromptExtension: ({ taskRef, runRef }) =>
      renderLaneEnvelope(input.repro, input.route, taskRef, runRef),
  });
}

async function prepareRouteRevision(input: {
  cwd: string;
  stateCwd: string;
  repository: string;
  repro: SparkSessionRepro;
  route: SparkReproRoute;
  artifactRef: ArtifactRef;
  currentBindingRevision?: string;
}): Promise<void> {
  const artifact = await defaultArtifactStore(input.stateCwd).get(input.artifactRef);
  if (artifact.kind !== "git_change" || artifact.body.kind !== "git_change") {
    throw new Error(`${input.artifactRef} is not a GitChange`);
  }
  const expectedTargetRevision = artifact.body.revisionMaterialization?.headRevision;
  if (!expectedTargetRevision) throw new Error("GitChange has no revision materialization state");
  if (expectedTargetRevision === input.route.sourceRevision) return;
  const workItem = input.repro.threeLane.workItems.find(
    (candidate) => candidate.workItemId === input.route.workItemId,
  );
  const sourceBaseRevision =
    input.route.action === "refresh_binding"
      ? (input.currentBindingRevision ?? expectedTargetRevision)
      : workItem?.sourceRevision;
  if (!sourceBaseRevision) throw new Error("route has no provable source base revision");
  const supersededRevisions = input.repro.threeLane.resolutions
    .filter(
      (resolution) =>
        resolution.workItemId === input.route.workItemId &&
        resolution.canonicalRevision === input.route.sourceRevision,
    )
    .flatMap((resolution) => resolution.supersededRevisions);
  await new GitRevisionMaterializationService({
    cwd: input.cwd,
    workspaceRoot: input.stateCwd,
  }).materialize({
    action: input.route.action === "refresh_binding" ? "refresh_candidate" : "prepare_layer",
    operationId: input.route.routeId,
    authority: "driver_local",
    repository: input.repository,
    artifactRef: input.artifactRef,
    expectedTargetRevision,
    sourceBaseRevision,
    sourceRevision: input.route.sourceRevision,
    supersededRevisions: [...new Set(supersededRevisions)],
  });
}

async function reopenLaneTask(stateCwd: string, taskRef: TaskRef): Promise<void> {
  await defaultTaskGraphStore(stateCwd).update(
    (graph) => {
      let task = graph.getTask(taskRef);
      if (task.claim) task = graph.releaseTaskClaim(taskRef, task.claim.claimedBy);
      if (task.status === "ready" || task.status === "pending") return;
      graph.updateTask(taskRef, { status: "ready" });
    },
    { createIfMissing: false },
  );
}

async function laneTaskRef(
  stateCwd: string,
  repro: SparkSessionRepro,
  lane: SparkReproLane,
): Promise<TaskRef> {
  if (!repro.projectRef) throw new Error("lane Task lookup requires a Project");
  const graph = await defaultTaskGraphStore(stateCwd).load();
  const task = graph
    ?.tasks(repro.projectRef)
    .find((candidate) => candidate.name === laneTaskName(repro.reproId, lane));
  if (!task) throw new Error(`Repro ${lane} Task is missing`);
  return task.ref;
}

async function latestTaskRun(
  stateCwd: string,
  repro: SparkSessionRepro,
  taskRef: TaskRef,
): Promise<TaskRun | undefined> {
  if (!repro.projectRef) return undefined;
  return (await defaultTaskGraphStore(stateCwd).load())
    ?.runs(repro.projectRef)
    .filter((run) => run.taskRef === taskRef)
    .at(-1);
}

async function requireCurrentRun(
  stateCwd: string,
  repro: SparkSessionRepro,
  taskRef: TaskRef,
): Promise<TaskRun> {
  const run = await latestTaskRun(stateCwd, repro, taskRef);
  if (!run) throw new Error(`Repro lane TaskRun is missing for ${taskRef}`);
  return run;
}

function renderLaneEnvelope(
  repro: SparkSessionRepro,
  route: SparkReproRoute,
  taskRef: TaskRef,
  runRef: RunRef,
): string {
  const lane = route.action === "root_attention" ? route.fromLane : route.toLane;
  const binding = sparkReproLaneBinding(repro.threeLane, route.workItemId, lane);
  return [
    "Runtime binding checkpoint (authoritative):",
    `reproId=${repro.reproId}`,
    `workItemId=${route.workItemId}`,
    `lane=${lane}`,
    `originRouteId=${route.routeId}`,
    `planRevision=${route.planRevision}`,
    `bindingRevision=${binding?.bindingRevision ?? route.sourceBindingRevision + 1}`,
    `taskRef=${taskRef}`,
    `runRef=${runRef}`,
    ...(binding ? [`gitChangeRef=${binding.gitChangeRef}`] : []),
    `sourceRevision=${route.sourceRevision}`,
    ...(route.cause.kind === "repair"
      ? [
          `repairEvidenceRef=${route.cause.evidenceRef}`,
          `failedRouteId=${route.cause.id}`,
          "Repair the candidate revision that failed exact Git materialization, then emit a new typed result from this same lane.",
        ]
      : []),
    "The result carrier and every referenced Evidence must be linked to this exact TaskRun.",
  ].join("\n");
}

async function recordGitRepairEvidence(input: {
  stateCwd: string;
  repro: SparkSessionRepro;
  route: Exclude<
    SparkReproRoute,
    { action: "root_attention" | "start_binding" | "resume_binding" }
  >;
  taskRef: TaskRef;
  artifactRef: ArtifactRef;
  error: GitLifecycleError;
}): Promise<{ evidenceRef: EvidenceRef; digest: string }> {
  const body = {
    schema: "spark.repro.git-repair/v1",
    reproId: input.repro.reproId,
    workItemId: input.route.workItemId,
    failedRouteId: input.route.routeId,
    action: input.route.action,
    fromLane: input.route.fromLane,
    toLane: input.route.toLane,
    repairLane: input.route.fromLane,
    sourceRevision: input.route.sourceRevision,
    targetArtifactRef: input.artifactRef,
    error: { code: input.error.code, message: input.error.message },
  };
  const repairDigest = digest(canonicalJson(body));
  const evidenceRef = `evidence:repro-git-repair-${repairDigest.slice(0, 32)}` as EvidenceRef;
  const store = defaultEvidenceStore(input.stateCwd);
  const existing = await store.tryGet(evidenceRef);
  if (!existing) {
    await store.put({
      ref: evidenceRef,
      kind: "record",
      title: `Repro Git repair for ${input.route.routeId}`,
      format: "json",
      body,
      provenance: {
        producer: "spark",
        ...(input.repro.projectRef ? { projectRef: input.repro.projectRef } : {}),
        taskRef: input.taskRef,
        ...(input.route.cause.evidenceRef
          ? { parentEvidenceRefs: [input.route.cause.evidenceRef] }
          : {}),
      },
      links: [{ to: input.taskRef, relation: "input" }],
      curation: {
        status: "candidate",
        retention: "project",
        reason: "Mechanical Git conflict assigned to the revision-producing lane.",
      },
    });
  }
  return { evidenceRef, digest: repairDigest };
}

function parseLaneResultEvidence(evidence: {
  format: string;
  body: unknown;
}): SparkReproLaneResult {
  if (evidence.format !== "json" || !isRecord(evidence.body)) {
    throw new Error("lane result Evidence must contain a JSON object");
  }
  return parseSparkReproLaneResult(evidence.body);
}

async function resolveHeadRevision(cwd: string): Promise<string> {
  const result = await defaultGitCommandRunner(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    cwd,
  );
  const revision = result.stdout.trim();
  if (result.code !== 0 || !/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error(`unable to freeze Repro source revision: ${result.stderr.trim()}`);
  }
  return revision;
}

async function resolveRepositoryIdentity(cwd: string): Promise<string> {
  const result = await defaultGitCommandRunner("git", ["remote", "get-url", "origin"], cwd);
  const remote = result.stdout.trim();
  if (result.code !== 0 || !remote) {
    throw new Error(`unable to resolve Repro repository identity: ${result.stderr.trim()}`);
  }
  const repository = gitHubRepositoryFromRemote(remote);
  if (!repository) throw new Error(`Repro requires a GitHub origin: ${remote}`);
  return repository;
}

function primaryWorkItemId(reproId: string): string {
  return `work:primary:${digest(reproId).slice(0, 24)}`;
}

function laneArtifactRef(reproId: string, workItemId: string, lane: SparkReproLane): ArtifactRef {
  return `artifact:repro-${digest(`${reproId}:${workItemId}:${lane}`).slice(0, 32)}` as ArtifactRef;
}

function laneTaskName(reproId: string, lane: SparkReproLane): string {
  return safeName(`repro-${reproId}-${lane}-lane`);
}

function roleForLane(lane: SparkReproLane): RoleRef {
  if (lane === "implementation") return "role:extension-repro-implementation-explorer" as RoleRef;
  if (lane === "exactness") {
    return "role:extension-repro-exactness-instrumentation-worker" as RoleRef;
  }
  return "role:extension-repro-precision-fixer" as RoleRef;
}

function laneTitle(lane: SparkReproLane): string {
  return lane === "implementation"
    ? "Implementation"
    : lane === "exactness"
      ? "Exactness"
      : "Formalize";
}

function isTerminalRun(run: TaskRun): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status);
}

function safeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 96);
  if (!normalized) throw new Error("unable to derive a stable Repro runtime name");
  return normalized;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical value is not finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("canonical value is not JSON");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updateReproThreeLane(
  repro: SparkSessionRepro,
  threeLane: SparkSessionRepro["threeLane"],
): SparkSessionRepro {
  return threeLane === repro.threeLane ? repro : { ...repro, threeLane, updatedAt: nowIso() };
}

async function withOwnerReconciliation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = OWNER_RECONCILIATIONS.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  OWNER_RECONCILIATIONS.set(key, settled);
  try {
    return await run;
  } finally {
    if (OWNER_RECONCILIATIONS.get(key) === settled) OWNER_RECONCILIATIONS.delete(key);
  }
}
