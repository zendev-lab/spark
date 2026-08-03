import type { DatabaseSync } from "node:sqlite";

import type { Observation, ProviderResult } from "@zendev-lab/spark-lens";

interface ObservationRow {
  payload_json: string;
}

interface ProviderResultRow {
  result_json: string;
}

export interface LensProviderProcessRecord {
  processKey: string;
  providerId: string;
  worktreeRoot: string;
  projectRoot: string;
  configDigest: string;
  executableDigest: string;
  daemonInstanceId: string;
  processMarker: string;
  pid: number;
  status: "running" | "stopped" | "crashed" | "recovered";
  startedAt: string;
  lastHeartbeatAt: string;
  exitedAt?: string;
}

interface ProviderProcessRow {
  process_key: string;
  provider_id: string;
  worktree_root: string;
  project_root: string;
  config_digest: string;
  executable_digest: string;
  daemon_instance_id: string;
  process_marker: string;
  pid: number;
  status: LensProviderProcessRecord["status"];
  started_at: string;
  last_heartbeat_at: string;
  exited_at: string | null;
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

  saveProviderProcess(record: LensProviderProcessRecord): void {
    this.#db
      .prepare(
        `INSERT INTO lens_provider_processes (
           process_key, provider_id, worktree_root, project_root, config_digest,
           executable_digest, daemon_instance_id, process_marker, pid, status,
           started_at, last_heartbeat_at, exited_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(process_key) DO UPDATE SET
           provider_id = excluded.provider_id,
           worktree_root = excluded.worktree_root,
           project_root = excluded.project_root,
           config_digest = excluded.config_digest,
           executable_digest = excluded.executable_digest,
           daemon_instance_id = excluded.daemon_instance_id,
           process_marker = excluded.process_marker,
           pid = excluded.pid,
           status = excluded.status,
           started_at = excluded.started_at,
           last_heartbeat_at = excluded.last_heartbeat_at,
           exited_at = excluded.exited_at`,
      )
      .run(
        record.processKey,
        record.providerId,
        record.worktreeRoot,
        record.projectRoot,
        record.configDigest,
        record.executableDigest,
        record.daemonInstanceId,
        record.processMarker,
        record.pid,
        record.status,
        record.startedAt,
        record.lastHeartbeatAt,
        record.exitedAt ?? null,
      );
  }

  updateProviderProcess(
    processKey: string,
    patch: {
      status?: LensProviderProcessRecord["status"];
      lastHeartbeatAt?: string;
      exitedAt?: string;
    },
  ): void {
    const current = this.listProviderProcesses().find((record) => record.processKey === processKey);
    if (!current) return;
    this.saveProviderProcess({ ...current, ...patch });
  }

  listProviderProcesses(status?: LensProviderProcessRecord["status"]): LensProviderProcessRecord[] {
    const rows = (status
      ? this.#db
          .prepare(`SELECT * FROM lens_provider_processes WHERE status = ? ORDER BY process_key`)
          .all(status)
      : this.#db
          .prepare(`SELECT * FROM lens_provider_processes ORDER BY process_key`)
          .all()) as unknown as ProviderProcessRow[];
    return rows.map((row) => ({
      processKey: row.process_key,
      providerId: row.provider_id,
      worktreeRoot: row.worktree_root,
      projectRoot: row.project_root,
      configDigest: row.config_digest,
      executableDigest: row.executable_digest,
      daemonInstanceId: row.daemon_instance_id,
      processMarker: row.process_marker,
      pid: row.pid,
      status: row.status,
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      ...(row.exited_at === null ? {} : { exitedAt: row.exited_at }),
    }));
  }
}
