import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ArtifactRef } from "@zendev-lab/spark-core";
import type { SparkReproWorkSummary } from "@zendev-lab/spark-repro/work-summary";
import {
  normalizeSparkReproWorkSummaryV3,
  type SparkReproWorkSummaryV3,
} from "@zendev-lab/spark-repro/three-lane-work-summary";
import {
  sparkReproWorkbenchArtifactRef,
  type SparkReproWorkbenchCheckpoint,
  type SparkReproWorkbenchCheckpointKind,
} from "@zendev-lab/spark-repro/workbench";

export type WorkbenchArtifactBindingLifecycle = "pending" | "live" | "sealed" | "error";

export interface WorkbenchArtifactBinding {
  bindingId: string;
  ownerSessionId: string;
  goalId: string;
  workflowRunId: string;
  loopId: string;
  reproId: string;
  artifactRef: ArtifactRef;
  revision: number;
  artifactHash?: string;
  projectionDigest?: string;
  lifecycle: WorkbenchArtifactBindingLifecycle;
  generation: number;
  lastStage?: SparkReproWorkSummary["stage"];
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  sealedAt?: string;
}

interface BindingRow {
  binding_id: string;
  owner_session_id: string;
  goal_id: string;
  workflow_run_id: string;
  loop_id: string;
  repro_id: string;
  artifact_ref: string;
  revision: number;
  artifact_hash: string | null;
  projection_digest: string | null;
  lifecycle: WorkbenchArtifactBindingLifecycle;
  generation: number;
  last_stage: SparkReproWorkSummary["stage"] | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sealed_at: string | null;
}

interface CheckpointRow {
  checkpoint_id: string;
  kind: SparkReproWorkbenchCheckpointKind;
  stage: SparkReproWorkSummary["stage"];
  artifact_ref: string;
  revision: number;
  artifact_hash: string;
  summary_json: string;
  created_at: string;
}

export class WorkbenchArtifactBindingStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  ensure(input: {
    ownerSessionId: string;
    goalId: string;
    workflowRunId: string;
    loopId: string;
    reproId: string;
    generation: number;
    now?: string;
  }): WorkbenchArtifactBinding {
    const now = input.now ?? new Date().toISOString();
    const bindingId = stableId("spark.workbench.binding/v1", input.reproId);
    const artifactRef = sparkReproWorkbenchArtifactRef(input.reproId);
    this.#db
      .prepare(
        `INSERT INTO workbench_artifact_bindings (
           binding_id, owner_session_id, goal_id, workflow_run_id, loop_id, repro_id,
           artifact_ref, revision, lifecycle, generation, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?)
         ON CONFLICT(loop_id) DO UPDATE SET
           generation = excluded.generation,
           updated_at = excluded.updated_at`,
      )
      .run(
        bindingId,
        input.ownerSessionId,
        input.goalId,
        input.workflowRunId,
        input.loopId,
        input.reproId,
        artifactRef,
        input.generation,
        now,
        now,
      );
    const binding = this.requireByLoop(input.loopId);
    if (
      binding.ownerSessionId !== input.ownerSessionId ||
      binding.goalId !== input.goalId ||
      binding.workflowRunId !== input.workflowRunId ||
      binding.reproId !== input.reproId
    ) {
      throw new Error(`WORKBENCH_BINDING_IDENTITY_CONFLICT: ${input.loopId}`);
    }
    return binding;
  }

  getByLoop(loopId: string): WorkbenchArtifactBinding | undefined {
    const row = this.#db
      .prepare(
        `SELECT binding_id, owner_session_id, goal_id, workflow_run_id, loop_id, repro_id,
                artifact_ref, revision, artifact_hash, projection_digest, lifecycle,
                generation, last_stage, last_error, created_at, updated_at, sealed_at
         FROM workbench_artifact_bindings WHERE loop_id = ?`,
      )
      .get(loopId) as BindingRow | undefined;
    return row ? bindingFromRow(row) : undefined;
  }

  getByArtifact(artifactRef: ArtifactRef): WorkbenchArtifactBinding | undefined {
    const row = this.#db
      .prepare(
        `SELECT binding_id, owner_session_id, goal_id, workflow_run_id, loop_id, repro_id,
                artifact_ref, revision, artifact_hash, projection_digest, lifecycle,
                generation, last_stage, last_error, created_at, updated_at, sealed_at
         FROM workbench_artifact_bindings WHERE artifact_ref = ?`,
      )
      .get(artifactRef) as BindingRow | undefined;
    return row ? bindingFromRow(row) : undefined;
  }

  list(): WorkbenchArtifactBinding[] {
    return (
      this.#db
        .prepare(
          `SELECT binding_id, owner_session_id, goal_id, workflow_run_id, loop_id, repro_id,
                  artifact_ref, revision, artifact_hash, projection_digest, lifecycle,
                  generation, last_stage, last_error, created_at, updated_at, sealed_at
           FROM workbench_artifact_bindings ORDER BY created_at, binding_id`,
        )
        .all() as unknown as BindingRow[]
    ).map(bindingFromRow);
  }

  recordProjection(input: {
    bindingId: string;
    expectedRevision: number;
    revision: number;
    artifactHash: string;
    projectionDigest: string;
    generation: number;
    stage: SparkReproWorkSummary["stage"];
    sealed: boolean;
    now?: string;
  }): WorkbenchArtifactBinding {
    const now = input.now ?? new Date().toISOString();
    const changes = Number(
      this.#db
        .prepare(
          `UPDATE workbench_artifact_bindings
           SET revision = ?, artifact_hash = ?, projection_digest = ?, generation = ?,
               last_stage = ?, lifecycle = ?, last_error = NULL, updated_at = ?, sealed_at = ?
           WHERE binding_id = ? AND revision = ?`,
        )
        .run(
          input.revision,
          input.artifactHash,
          input.projectionDigest,
          input.generation,
          input.stage,
          input.sealed ? "sealed" : "live",
          now,
          input.sealed ? now : null,
          input.bindingId,
          input.expectedRevision,
        ).changes,
    );
    if (changes !== 1) {
      throw new Error(`WORKBENCH_BINDING_REVISION_CONFLICT: ${input.bindingId}`);
    }
    return this.require(input.bindingId);
  }

  recordError(bindingId: string, error: unknown, now = new Date().toISOString()): void {
    this.#db
      .prepare(
        `UPDATE workbench_artifact_bindings
         SET lifecycle = 'error', sealed_at = NULL,
             last_error = ?, updated_at = ?
         WHERE binding_id = ?`,
      )
      .run(error instanceof Error ? error.message : String(error), now, bindingId);
  }

  listCheckpoints(bindingId: string): SparkReproWorkbenchCheckpoint[] {
    const rows = this.#db
      .prepare(
        `SELECT checkpoint_id, kind, stage, artifact_ref, revision, artifact_hash,
                summary_json, created_at
         FROM workbench_checkpoints WHERE binding_id = ? ORDER BY created_at, checkpoint_id`,
      )
      .all(bindingId) as unknown as CheckpointRow[];
    return rows.map(checkpointFromRow);
  }

  recordCheckpoint(input: {
    checkpointId: string;
    bindingId: string;
    kind: SparkReproWorkbenchCheckpointKind;
    stage: SparkReproWorkSummary["stage"];
    artifactRef: ArtifactRef;
    revision: number;
    artifactHash: string;
    work: SparkReproWorkSummaryV3;
    now?: string;
  }): SparkReproWorkbenchCheckpoint {
    const now = input.now ?? new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO workbench_checkpoints (
           checkpoint_id, binding_id, kind, stage, artifact_ref, revision,
           artifact_hash, summary_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(binding_id, checkpoint_id) DO NOTHING`,
      )
      .run(
        input.checkpointId,
        input.bindingId,
        input.kind,
        input.stage,
        input.artifactRef,
        input.revision,
        input.artifactHash,
        JSON.stringify(input.work),
        now,
      );
    return this.requireCheckpoint(input.bindingId, input.checkpointId);
  }

  readActionReceipt(idempotencyKey: string):
    | {
        requestDigest: string;
        result: unknown;
      }
    | undefined {
    const row = this.#db
      .prepare(
        `SELECT request_digest, result_json FROM workbench_action_receipts
         WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as { request_digest: string; result_json: string } | undefined;
    return row
      ? { requestDigest: row.request_digest, result: JSON.parse(row.result_json) as unknown }
      : undefined;
  }

  recordActionReceipt(input: {
    idempotencyKey: string;
    requestDigest: string;
    bindingId: string;
    result: unknown;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO workbench_action_receipts (
           idempotency_key, request_digest, binding_id, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        input.idempotencyKey,
        input.requestDigest,
        input.bindingId,
        JSON.stringify(input.result),
        now,
      );
    const stored = this.readActionReceipt(input.idempotencyKey);
    if (!stored || stored.requestDigest !== input.requestDigest) {
      throw new Error(`WORKBENCH_ACTION_IDEMPOTENCY_CONFLICT: ${input.idempotencyKey}`);
    }
  }

  private require(bindingId: string): WorkbenchArtifactBinding {
    const binding = this.list().find((candidate) => candidate.bindingId === bindingId);
    if (!binding) throw new Error(`Workbench binding not found: ${bindingId}`);
    return binding;
  }

  private requireByLoop(loopId: string): WorkbenchArtifactBinding {
    const binding = this.getByLoop(loopId);
    if (!binding) throw new Error(`Workbench binding not found for Loop: ${loopId}`);
    return binding;
  }

  private requireCheckpoint(
    bindingId: string,
    checkpointId: string,
  ): SparkReproWorkbenchCheckpoint {
    const row = this.#db
      .prepare(
        `SELECT checkpoint_id, kind, stage, artifact_ref, revision, artifact_hash,
                summary_json, created_at
         FROM workbench_checkpoints WHERE binding_id = ? AND checkpoint_id = ?`,
      )
      .get(bindingId, checkpointId) as CheckpointRow | undefined;
    if (!row) throw new Error(`Workbench checkpoint not found: ${checkpointId}`);
    return checkpointFromRow(row);
  }
}

export function workbenchRequestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingFromRow(row: BindingRow): WorkbenchArtifactBinding {
  return {
    bindingId: row.binding_id,
    ownerSessionId: row.owner_session_id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    loopId: row.loop_id,
    reproId: row.repro_id,
    artifactRef: row.artifact_ref as ArtifactRef,
    revision: row.revision,
    ...(row.artifact_hash ? { artifactHash: row.artifact_hash } : {}),
    ...(row.projection_digest ? { projectionDigest: row.projection_digest } : {}),
    lifecycle: row.lifecycle,
    generation: row.generation,
    ...(row.last_stage ? { lastStage: row.last_stage } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.sealed_at ? { sealedAt: row.sealed_at } : {}),
  };
}

function checkpointFromRow(row: CheckpointRow): SparkReproWorkbenchCheckpoint {
  const stored = JSON.parse(row.summary_json) as unknown as
    | SparkReproWorkSummary
    | SparkReproWorkSummaryV3;
  return {
    checkpointId: row.checkpoint_id,
    kind: row.kind,
    stage: row.stage,
    artifactRef: row.artifact_ref as ArtifactRef,
    revision: row.revision,
    hash: row.artifact_hash,
    createdAt: row.created_at,
    work: normalizeSparkReproWorkSummaryV3(stored),
  };
}

function stableId(namespace: string, value: string): string {
  return createHash("sha256").update(`${namespace}\0${value}`).digest("hex").slice(0, 32);
}
