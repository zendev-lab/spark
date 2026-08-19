import type { DatabaseSync } from "node:sqlite";
import { validateSparkReproV10, type SparkSessionRepro } from "@zendev-lab/spark-repro";

interface ReproRow {
  state_json: string;
}

export interface SparkReproV10ProjectionReceipt {
  reproId: string;
  stateUpdatedAt: string;
  reportArtifactRef: `artifact:${string}`;
  reportRevision: number;
  workbenchArtifactRef: `artifact:${string}`;
  workbenchRevision: number;
  projectedAt: string;
}

interface ProjectionRow {
  repro_id: string;
  state_updated_at: string;
  report_artifact_ref: `artifact:${string}`;
  report_revision: number;
  workbench_artifact_ref: `artifact:${string}`;
  workbench_revision: number;
  projected_at: string;
}

export class SparkReproV10Store {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(reproId: string): SparkSessionRepro | undefined {
    const row = this.#db
      .prepare("SELECT state_json FROM daemon_repro_runs WHERE repro_id = ?")
      .get(reproId) as ReproRow | undefined;
    return row ? parseState(row.state_json) : undefined;
  }

  currentForOwner(ownerSessionId: string): SparkSessionRepro | undefined {
    const row = this.#db
      .prepare(
        `SELECT state_json
         FROM daemon_repro_runs
         WHERE owner_session_id = ?
         ORDER BY updated_at DESC, repro_id DESC
         LIMIT 1`,
      )
      .get(ownerSessionId) as ReproRow | undefined;
    return row ? parseState(row.state_json) : undefined;
  }

  listRecoverable(limit = 100): SparkSessionRepro[] {
    const rows = this.#db
      .prepare(
        `SELECT runs.state_json
         FROM daemon_repro_runs AS runs
         LEFT JOIN daemon_repro_projections AS projections
           ON projections.repro_id = runs.repro_id
         WHERE runs.status IN ('provisioning', 'active', 'waiting_attention')
            OR projections.state_updated_at IS NULL
            OR projections.state_updated_at != runs.updated_at
         ORDER BY runs.updated_at ASC, runs.repro_id ASC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(100, Math.floor(limit)))) as unknown as ReproRow[];
    return rows.map((row) => parseState(row.state_json));
  }

  projection(reproId: string): SparkReproV10ProjectionReceipt | undefined {
    const row = this.#db
      .prepare(
        `SELECT repro_id, state_updated_at, report_artifact_ref, report_revision,
                workbench_artifact_ref, workbench_revision, projected_at
         FROM daemon_repro_projections
         WHERE repro_id = ?`,
      )
      .get(reproId) as ProjectionRow | undefined;
    return row
      ? {
          reproId: row.repro_id,
          stateUpdatedAt: row.state_updated_at,
          reportArtifactRef: row.report_artifact_ref,
          reportRevision: row.report_revision,
          workbenchArtifactRef: row.workbench_artifact_ref,
          workbenchRevision: row.workbench_revision,
          projectedAt: row.projected_at,
        }
      : undefined;
  }

  recordProjection(input: SparkReproV10ProjectionReceipt): void {
    this.#db
      .prepare(
        `INSERT INTO daemon_repro_projections (
           repro_id, state_updated_at, report_artifact_ref, report_revision,
           workbench_artifact_ref, workbench_revision, projected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repro_id) DO UPDATE SET
           state_updated_at = excluded.state_updated_at,
           report_artifact_ref = excluded.report_artifact_ref,
           report_revision = excluded.report_revision,
           workbench_artifact_ref = excluded.workbench_artifact_ref,
           workbench_revision = excluded.workbench_revision,
           projected_at = excluded.projected_at
         WHERE daemon_repro_projections.state_updated_at != excluded.state_updated_at
            OR daemon_repro_projections.report_artifact_ref != excluded.report_artifact_ref
            OR daemon_repro_projections.report_revision != excluded.report_revision
            OR daemon_repro_projections.workbench_artifact_ref != excluded.workbench_artifact_ref
            OR daemon_repro_projections.workbench_revision != excluded.workbench_revision`,
      )
      .run(
        input.reproId,
        input.stateUpdatedAt,
        input.reportArtifactRef,
        input.reportRevision,
        input.workbenchArtifactRef,
        input.workbenchRevision,
        input.projectedAt,
      );
  }

  insertIntent(state: SparkSessionRepro): { state: SparkSessionRepro; changed: boolean } {
    validateSparkReproV10(state);
    const existing = this.get(state.reproId);
    if (existing) {
      if (
        existing.ownerSessionId !== state.ownerSessionId ||
        existing.workspaceId !== state.workspaceId ||
        existing.objective !== state.objective
      ) {
        throw new Error(`Repro id ${state.reproId} is already bound to different content`);
      }
      return { state: existing, changed: false };
    }
    const active = this.#db
      .prepare(
        `SELECT repro_id
         FROM daemon_repro_runs
         WHERE owner_session_id = ?
           AND status IN ('provisioning', 'active', 'waiting_attention')
         LIMIT 1`,
      )
      .get(state.ownerSessionId) as { repro_id: string } | undefined;
    if (active) throw new Error(`owner Session already has active Repro ${active.repro_id}`);
    this.#db
      .prepare(
        `INSERT INTO daemon_repro_runs (
           repro_id, owner_session_id, workspace_id, status, state_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state.reproId,
        state.ownerSessionId,
        state.workspaceId,
        state.status,
        JSON.stringify(state),
        state.createdAt,
        state.updatedAt,
      );
    return { state, changed: true };
  }

  replace(state: SparkSessionRepro, expectedUpdatedAt?: string): boolean {
    validateSparkReproV10(state);
    const result = expectedUpdatedAt
      ? this.#db
          .prepare(
            `UPDATE daemon_repro_runs
             SET status = ?, state_json = ?, updated_at = ?
             WHERE repro_id = ? AND updated_at = ?`,
          )
          .run(
            state.status,
            JSON.stringify(state),
            state.updatedAt,
            state.reproId,
            expectedUpdatedAt,
          )
      : this.#db
          .prepare(
            `UPDATE daemon_repro_runs
             SET status = ?, state_json = ?, updated_at = ?
             WHERE repro_id = ?`,
          )
          .run(state.status, JSON.stringify(state), state.updatedAt, state.reproId);
    return result.changes === 1;
  }
}

function parseState(raw: string): SparkSessionRepro {
  const value = JSON.parse(raw) as SparkSessionRepro;
  validateSparkReproV10(value);
  return value;
}
