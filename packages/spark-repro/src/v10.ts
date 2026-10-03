import { createHash } from "node:crypto";
import {
  parseSparkReproLaneResult,
  type SparkReproCheckpointKind,
  type SparkReproLane,
  type SparkReproLaneResult,
} from "@zendev-lab/spark-protocol/repro-lane";

export const SPARK_REPRO_VERSION = 10 as const;
export const SPARK_REPRO_SCHEMA = "spark.repro.session/v10" as const;

export const SPARK_REPRO_CHECKPOINTS = [
  "implementation",
  "exactness",
  "formalize",
  "exactness_refresh",
  "implementation_refresh",
] as const satisfies readonly SparkReproCheckpointKind[];

export const SPARK_REPRO_LANES = [
  "implementation",
  "exactness",
  "formalize",
] as const satisfies readonly SparkReproLane[];

export type SparkReproV10Status =
  | "provisioning"
  | "active"
  | "waiting_attention"
  | "complete"
  | "stopped"
  | "blocked";
export type SparkReproCheckpointStatus = "pending" | "running" | "attention" | "accepted";

export interface SparkReproFrozenModel {
  provider: string;
  model: string;
  thinkingLevel?: string;
}

export interface SparkReproLaneBinding {
  lane: SparkReproLane;
  sessionId: string;
  taskRef: `task:${string}`;
  roleRef: `role:${string}`;
  model: SparkReproFrozenModel;
}

export interface SparkReproAttention {
  decisionKey: string;
  question: string;
  reason: string;
  expectedAnswerKind: "single" | "multi" | "freeform";
  requestedByRunRef: `run:${string}`;
  requestedAt: string;
  answerEvidenceRef?: `evidence:${string}`;
}

export interface SparkReproCheckpoint {
  checkpointId: string;
  kind: SparkReproCheckpointKind;
  lane: SparkReproLane;
  status: SparkReproCheckpointStatus;
  sessionId: string;
  taskRef: `task:${string}`;
  sourceCheckpointId?: string;
  parentCheckpointId?: string;
  runRef?: `run:${string}`;
  attempt: number;
  evidenceRefs: `evidence:${string}`[];
  summary?: string;
  attention?: SparkReproAttention;
  acceptedAt?: string;
}

export interface SparkReproAcceptedReceipt {
  receiptId: string;
  checkpointId: string;
  runRef: `run:${string}`;
  resultHash: string;
  acceptedAt: string;
}

export interface SparkSessionRepro {
  version: typeof SPARK_REPRO_VERSION;
  schema: typeof SPARK_REPRO_SCHEMA;
  reproId: string;
  ownerSessionId: string;
  workspaceId: string;
  projectRef: `proj:${string}`;
  objective: string;
  workItem: {
    workItemId: string;
    title: string;
    scope: string;
  };
  status: SparkReproV10Status;
  lanes: Record<SparkReproLane, SparkReproLaneBinding>;
  checkpoints: SparkReproCheckpoint[];
  currentCheckpointId?: string;
  receipts: SparkReproAcceptedReceipt[];
  formalizedRevision?: string;
  blockingReason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  stoppedAt?: string;
  migratedFromV9Digest?: string;
}

export interface CreateSparkReproV10Input {
  reproId: string;
  ownerSessionId: string;
  workspaceId: string;
  objective: string;
  laneRoles: Record<SparkReproLane, `role:${string}`>;
  laneModels: Record<SparkReproLane, SparkReproFrozenModel>;
  now: string;
}

export function createSparkReproV10(input: CreateSparkReproV10Input): SparkSessionRepro {
  const objective = requiredText(input.objective, "Repro objective");
  const reproId = stableIdentifier(input.reproId, "Repro id");
  const ownerSessionId = stableIdentifier(input.ownerSessionId, "owner Session id");
  const workspaceId = stableIdentifier(input.workspaceId, "Workspace id");
  const lanes = Object.fromEntries(
    SPARK_REPRO_LANES.map((lane) => {
      const laneKey = deterministicId(reproId, lane);
      return [
        lane,
        {
          lane,
          sessionId: `session:repro-${laneKey}`,
          taskRef: `task:repro-${laneKey}` as const,
          roleRef: input.laneRoles[lane],
          model: { ...input.laneModels[lane] },
        },
      ];
    }),
  ) as Record<SparkReproLane, SparkReproLaneBinding>;
  const checkpoints = SPARK_REPRO_CHECKPOINTS.map((kind, index): SparkReproCheckpoint => {
    const lane = checkpointLane(kind);
    const source = index > 0 ? SPARK_REPRO_CHECKPOINTS[index - 1] : undefined;
    const parent = kind.endsWith("_refresh") ? "formalize" : undefined;
    return {
      checkpointId: checkpointId(reproId, kind),
      kind,
      lane,
      status: "pending",
      sessionId: lanes[lane].sessionId,
      taskRef: lanes[lane].taskRef,
      ...(source ? { sourceCheckpointId: checkpointId(reproId, source) } : {}),
      ...(parent ? { parentCheckpointId: checkpointId(reproId, parent) } : {}),
      attempt: 0,
      evidenceRefs: [],
    };
  });
  const state: SparkSessionRepro = {
    version: SPARK_REPRO_VERSION,
    schema: SPARK_REPRO_SCHEMA,
    reproId,
    ownerSessionId,
    workspaceId,
    projectRef: `proj:repro-${deterministicId(reproId, "project")}`,
    objective,
    workItem: {
      workItemId: `work:repro-${deterministicId(reproId, "work")}`,
      title: objective,
      scope: objective,
    },
    status: "provisioning",
    lanes,
    checkpoints,
    currentCheckpointId: checkpoints[0]!.checkpointId,
    receipts: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
  validateSparkReproV10(state);
  return state;
}

export function activateSparkReproV10(state: SparkSessionRepro, now: string): SparkSessionRepro {
  if (state.status === "active") return state;
  if (state.status !== "provisioning") throw new Error("only a provisioning Repro may activate");
  return checked({ ...state, status: "active", updatedAt: now });
}

export function bindSparkReproCheckpointRun(
  state: SparkSessionRepro,
  input: { checkpointId: string; runRef: `run:${string}`; now: string },
): SparkSessionRepro {
  if (state.status !== "active" && state.status !== "waiting_attention") {
    throw new Error("Repro is not runnable");
  }
  if (state.currentCheckpointId !== input.checkpointId) {
    throw new Error("only the current Repro checkpoint may bind a TaskRun");
  }
  const index = checkpointIndex(state, input.checkpointId);
  const current = state.checkpoints[index]!;
  if (current.status === "running" && current.runRef === input.runRef) return state;
  if (current.status === "running")
    throw new Error("Repro checkpoint already has a running TaskRun");
  if (current.status === "accepted")
    throw new Error("accepted Repro checkpoint cannot bind a TaskRun");
  const { attention: _attention, ...withoutAttention } = current;
  const checkpoints = replaceAt(state.checkpoints, index, {
    ...withoutAttention,
    status: "running",
    runRef: input.runRef,
    attempt: current.attempt + 1,
  });
  return checked({ ...state, status: "active", checkpoints, updatedAt: input.now });
}

export function acceptSparkReproLaneResult(
  state: SparkSessionRepro,
  rawResult: unknown,
  now: string,
): SparkSessionRepro {
  const result = parseSparkReproLaneResult(rawResult);
  if (result.reproId !== state.reproId) throw new Error("foreign Repro lane result");
  const resultHash = digest(result);
  const priorByRun = state.receipts.find((receipt) => receipt.runRef === result.runRef);
  if (priorByRun) {
    if (priorByRun.resultHash !== resultHash)
      throw new Error("TaskRun result replay changed payload");
    return state;
  }
  if (state.currentCheckpointId !== result.checkpointId) {
    throw new Error("stale or out-of-order Repro lane result");
  }
  const index = checkpointIndex(state, result.checkpointId);
  const current = state.checkpoints[index]!;
  assertResultBinding(current, result);
  if (current.status !== "running" || current.runRef !== result.runRef) {
    throw new Error("Repro lane result is not bound to the current terminal TaskRun");
  }
  if (result.kind === "attention_request") {
    const checkpoints = replaceAt(state.checkpoints, index, {
      ...current,
      status: "attention",
      attention: {
        decisionKey: result.decisionKey,
        question: result.question,
        reason: result.reason,
        expectedAnswerKind: result.expectedAnswerKind,
        requestedByRunRef: result.runRef,
        requestedAt: now,
      },
    });
    return checked({ ...state, status: "waiting_attention", checkpoints, updatedAt: now });
  }

  const previous = index > 0 ? state.checkpoints[index - 1] : undefined;
  if (previous && previous.status !== "accepted") {
    throw new Error("Repro checkpoint source has not been accepted");
  }
  if (current.parentCheckpointId) {
    const parent = state.checkpoints.find(
      (checkpoint) => checkpoint.checkpointId === current.parentCheckpointId,
    );
    if (parent?.kind !== "formalize" || parent.status !== "accepted") {
      throw new Error("refresh checkpoint requires its accepted Formalize parent");
    }
  }
  const { attention: _attention, ...withoutAttention } = current;
  const acceptedCurrent: SparkReproCheckpoint = {
    ...withoutAttention,
    status: "accepted",
    evidenceRefs: [...new Set(result.evidenceRefs)].sort() as `evidence:${string}`[],
    summary: result.summary,
    acceptedAt: now,
  };
  const checkpoints = replaceAt(state.checkpoints, index, acceptedCurrent);
  const next = checkpoints[index + 1];
  const receipt: SparkReproAcceptedReceipt = {
    receiptId: `receipt:${deterministicId(state.reproId, result.runRef)}`,
    checkpointId: current.checkpointId,
    runRef: result.runRef,
    resultHash,
    acceptedAt: now,
  };
  const { currentCheckpointId: _currentCheckpointId, ...withoutCurrent } = state;
  return checked({
    ...withoutCurrent,
    status: next ? "active" : "complete",
    checkpoints,
    ...(next ? { currentCheckpointId: next.checkpointId } : {}),
    receipts: [...state.receipts, receipt],
    ...(result.checkpoint === "formalize"
      ? { formalizedRevision: result.formalizedRevision! }
      : {}),
    updatedAt: now,
    ...(next ? {} : { completedAt: now }),
  });
}

export function answerSparkReproAttention(
  state: SparkSessionRepro,
  input: {
    checkpointId: string;
    answerEvidenceRef: `evidence:${string}`;
    answerKind: "single" | "multi" | "freeform";
    now: string;
  },
): SparkSessionRepro {
  if (state.status !== "waiting_attention" || state.currentCheckpointId !== input.checkpointId) {
    throw new Error("Repro has no matching pending attention request");
  }
  const index = checkpointIndex(state, input.checkpointId);
  const current = state.checkpoints[index]!;
  if (current.status !== "attention" || !current.attention) {
    throw new Error("Repro checkpoint has no pending attention request");
  }
  if (current.attention.expectedAnswerKind !== input.answerKind) {
    throw new Error("Repro attention answer kind does not match the request");
  }
  const { runRef: _runRef, ...withoutRun } = current;
  const checkpoints = replaceAt(state.checkpoints, index, {
    ...withoutRun,
    status: "pending",
    evidenceRefs: [...new Set([...current.evidenceRefs, input.answerEvidenceRef])],
    attention: { ...current.attention, answerEvidenceRef: input.answerEvidenceRef },
  });
  return checked({ ...state, status: "active", checkpoints, updatedAt: input.now });
}

export function stopSparkReproV10(state: SparkSessionRepro, now: string): SparkSessionRepro {
  if (state.status === "stopped") return state;
  if (state.status === "complete") throw new Error("completed Repro cannot be stopped");
  const { currentCheckpointId: _currentCheckpointId, ...withoutCurrent } = state;
  return checked({
    ...withoutCurrent,
    status: "stopped",
    stoppedAt: now,
    updatedAt: now,
  });
}

export function blockSparkReproV10(
  state: SparkSessionRepro,
  reason: string,
  now: string,
): SparkSessionRepro {
  if (state.status === "blocked" && state.blockingReason === reason) return state;
  if (state.status === "complete" || state.status === "stopped") {
    throw new Error(`terminal Repro cannot be blocked from status ${state.status}`);
  }
  return checked({
    ...state,
    status: "blocked",
    blockingReason: requiredText(reason, "Repro blocking reason"),
    updatedAt: now,
  });
}

export function migrateSparkSessionReproV9(
  value: unknown,
  input: Omit<CreateSparkReproV10Input, "reproId" | "objective">,
): SparkSessionRepro {
  const legacy = record(value, "stored Repro v9");
  if (legacy.version !== 9) throw new Error("only SparkSessionRepro v9 can migrate to v10");
  const reproId = requiredText(legacy.reproId, "stored Repro id");
  const contract = record(legacy.goalContract, "stored Repro goal contract");
  const objective = requiredText(contract.objective ?? legacy.objective, "stored Repro objective");
  const migrated = createSparkReproV10({ ...input, reproId, objective });
  const { currentCheckpointId: _currentCheckpointId, ...withoutCurrent } = migrated;
  return checked({
    ...withoutCurrent,
    status: "blocked",
    blockingReason:
      "Migrated Repro v9 history is preserved read-only; run /repro start with the same objective to materialize v10 checkpoints without guessing provenance.",
    migratedFromV9Digest: digest(legacy),
  });
}

export function validateSparkReproV10(value: SparkSessionRepro): void {
  if (value.version !== 10 || value.schema !== SPARK_REPRO_SCHEMA) {
    throw new Error("unsupported Repro session schema");
  }
  if (value.checkpoints.length !== SPARK_REPRO_CHECKPOINTS.length) {
    throw new Error("Repro v10 must contain exactly five checkpoints");
  }
  for (const [index, kind] of SPARK_REPRO_CHECKPOINTS.entries()) {
    const checkpoint = value.checkpoints[index];
    if (!checkpoint || checkpoint.kind !== kind || checkpoint.lane !== checkpointLane(kind)) {
      throw new Error("Repro v10 checkpoint order or lane is invalid");
    }
    const lane = value.lanes[checkpoint.lane];
    if (checkpoint.sessionId !== lane.sessionId || checkpoint.taskRef !== lane.taskRef) {
      throw new Error("Repro checkpoint does not reuse its stable lane Session and Task");
    }
    if (index > 0 && checkpoint.sourceCheckpointId !== value.checkpoints[index - 1]?.checkpointId) {
      throw new Error("Repro checkpoint source chain is invalid");
    }
    if (kind.endsWith("_refresh")) {
      const formalize = value.checkpoints[2];
      if (checkpoint.parentCheckpointId !== formalize?.checkpointId) {
        throw new Error("Repro refresh checkpoint has no Formalize parent");
      }
    }
  }
  const formalize = value.checkpoints[2];
  if (value.formalizedRevision && formalize?.status !== "accepted") {
    throw new Error("only an accepted Formalize checkpoint may set formalizedRevision");
  }
  if (value.status === "complete" && value.checkpoints.some((item) => item.status !== "accepted")) {
    throw new Error("complete Repro has an unaccepted checkpoint");
  }
  const current = value.currentCheckpointId
    ? value.checkpoints.find((item) => item.checkpointId === value.currentCheckpointId)
    : undefined;
  if (["active", "waiting_attention"].includes(value.status) && !current) {
    throw new Error("active Repro has no current checkpoint");
  }
  const receiptRuns = value.receipts.map((receipt) => receipt.runRef);
  if (new Set(receiptRuns).size !== receiptRuns.length) {
    throw new Error("Repro receipts contain duplicate TaskRuns");
  }
}

export function currentSparkReproCheckpoint(
  state: SparkSessionRepro,
): SparkReproCheckpoint | undefined {
  return state.checkpoints.find(
    (checkpoint) => checkpoint.checkpointId === state.currentCheckpointId,
  );
}

function assertResultBinding(checkpoint: SparkReproCheckpoint, result: SparkReproLaneResult): void {
  if (
    result.checkpoint !== checkpoint.kind ||
    result.lane !== checkpoint.lane ||
    result.sessionId !== checkpoint.sessionId ||
    result.taskRef !== checkpoint.taskRef ||
    result.sourceCheckpointId !== checkpoint.sourceCheckpointId ||
    result.parentCheckpointId !== checkpoint.parentCheckpointId
  ) {
    throw new Error("Repro lane result provenance does not match the checkpoint binding");
  }
}

function checkpointLane(kind: SparkReproCheckpointKind): SparkReproLane {
  if (kind === "formalize") return "formalize";
  return kind.startsWith("exactness") ? "exactness" : "implementation";
}

function checkpointId(reproId: string, checkpoint: SparkReproCheckpointKind): string {
  return `checkpoint:${deterministicId(reproId, checkpoint)}`;
}

function deterministicId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableIdentifier(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!/^[A-Za-z0-9._:-]+$/u.test(text)) throw new Error(`${label} is not a stable identifier`);
  return text;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function checkpointIndex(state: SparkSessionRepro, checkpointIdValue: string): number {
  const index = state.checkpoints.findIndex(
    (checkpoint) => checkpoint.checkpointId === checkpointIdValue,
  );
  if (index < 0) throw new Error("unknown Repro checkpoint");
  return index;
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((candidate, candidateIndex) => (candidateIndex === index ? value : candidate));
}

function checked(value: SparkSessionRepro): SparkSessionRepro {
  validateSparkReproV10(value);
  return value;
}
