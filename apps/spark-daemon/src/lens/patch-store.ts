import type { DatabaseSync } from "node:sqlite";

import type { PatchProposal, PatchProposalRef } from "@zendev-lab/spark-lens";

interface ProposalRow {
  payload_json: string;
  status: PatchProposalStatus;
}

type PatchProposalStatus = "proposed" | "applied" | "stale" | "rejected";

export class DaemonLensPatchStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  save(workspaceRoot: string, proposal: PatchProposal): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO lens_patch_proposals (
           proposal_ref, workspace_root, base_revision_digest, payload_json, status,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'proposed', ?, ?)
         ON CONFLICT(proposal_ref) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        proposal.ref,
        workspaceRoot,
        proposal.baseRevision.digest,
        JSON.stringify(proposal),
        now,
        now,
      );
  }

  load(
    ref: PatchProposalRef,
  ): { proposal: PatchProposal; status: PatchProposalStatus } | undefined {
    const row = this.#db
      .prepare(
        `SELECT payload_json, status
         FROM lens_patch_proposals
         WHERE proposal_ref = ?`,
      )
      .get(ref) as ProposalRow | undefined;
    return row
      ? {
          proposal: JSON.parse(row.payload_json) as PatchProposal,
          status: row.status,
        }
      : undefined;
  }

  setStatus(ref: PatchProposalRef, status: PatchProposalStatus): void {
    this.#db
      .prepare(
        `UPDATE lens_patch_proposals
         SET status = ?, updated_at = ?
         WHERE proposal_ref = ?`,
      )
      .run(status, new Date().toISOString(), ref);
  }
}
