import type { DatabaseSync } from "node:sqlite";

import type { Observation, ProviderResult } from "@zendev-lab/spark-lens";

interface ObservationRow {
  payload_json: string;
}

interface ProviderResultRow {
  result_json: string;
}

export class DaemonLensStateStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  saveProviderResult(result: ProviderResult): void {
    this.#db
      .prepare(
        `INSERT INTO lens_provider_results (
           provider_id, capability, revision_digest, result_json, produced_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, capability, revision_digest) DO UPDATE SET
           result_json = excluded.result_json,
           produced_at = excluded.produced_at`,
      )
      .run(
        result.providerId,
        result.capability,
        result.revisionDigest,
        JSON.stringify(result),
        result.producedAt,
      );
  }

  loadProviderResult(
    providerId: string,
    capability: string,
    revisionDigest: string,
  ): ProviderResult | undefined {
    const row = this.#db
      .prepare(
        `SELECT result_json
         FROM lens_provider_results
         WHERE provider_id = ? AND capability = ? AND revision_digest = ?`,
      )
      .get(providerId, capability, revisionDigest) as ProviderResultRow | undefined;
    return row ? (JSON.parse(row.result_json) as ProviderResult) : undefined;
  }

  saveObservations(workspaceRoot: string, observations: readonly Observation[]): void {
    if (observations.length === 0) return;
    const now = new Date().toISOString();
    const insert = this.#db.prepare(
      `INSERT INTO lens_observations (
         observation_ref, workspace_root, revision_digest, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(observation_ref) DO UPDATE SET
         workspace_root = excluded.workspace_root,
         revision_digest = excluded.revision_digest,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
    );
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const observation of observations) {
        insert.run(
          observation.ref,
          workspaceRoot,
          observation.revisionDigest,
          JSON.stringify(observation),
          now,
          now,
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listObservations(workspaceRoot: string, revisionDigest: string): Observation[] {
    const rows = this.#db
      .prepare(
        `SELECT payload_json
         FROM lens_observations
         WHERE workspace_root = ? AND revision_digest = ?
         ORDER BY observation_ref`,
      )
      .all(workspaceRoot, revisionDigest) as unknown as ObservationRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as Observation);
  }
}
