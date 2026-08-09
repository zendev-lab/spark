import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  sparkReproFormalEvidenceReceiptSchema,
  type SparkReproFormalEvidenceReceipt,
  type SparkReproFormalEvidenceReceiptIdentity,
} from "@zendev-lab/spark-protocol/repro-formal-evidence";

export class SparkReproFormalEvidenceReceiptStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  record(
    workspaceCwd: string,
    raw: SparkReproFormalEvidenceReceipt,
  ): SparkReproFormalEvidenceReceipt {
    const receipt = sparkReproFormalEvidenceReceiptSchema.parse(raw);
    const cwd = resolve(workspaceCwd);
    if (resolve(receipt.workspaceCwd) !== cwd) {
      throw new Error("formal Evidence receipt workspace binding does not match store scope");
    }
    const receiptKey = workspaceReceiptKey(cwd, receipt);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO daemon_repro_formal_evidence_receipts
          (receipt_key, workspace_cwd, repro_id, requirement_id, step_id, evidence_ref,
           receipt_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(receipt_key) DO UPDATE SET
           workspace_cwd = excluded.workspace_cwd,
           repro_id = excluded.repro_id,
           requirement_id = excluded.requirement_id,
           step_id = excluded.step_id,
           evidence_ref = excluded.evidence_ref,
           receipt_json = excluded.receipt_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        receiptKey,
        cwd,
        receipt.reproId,
        receipt.requirementId,
        receipt.stepId,
        receipt.evidenceRef,
        JSON.stringify(receipt),
        now,
        now,
      );
    return receipt;
  }

  get(
    workspaceCwd: string,
    identity: SparkReproFormalEvidenceReceiptIdentity,
  ): SparkReproFormalEvidenceReceipt | undefined {
    const cwd = resolve(workspaceCwd);
    const receiptKey = workspaceReceiptKey(cwd, identity);
    const row = this.db
      .prepare(
        `SELECT receipt_json AS receiptJson
         FROM daemon_repro_formal_evidence_receipts
         WHERE receipt_key = ? AND workspace_cwd = ?`,
      )
      .get(receiptKey, cwd) as { receiptJson: string } | undefined;
    if (!row) return undefined;
    return sparkReproFormalEvidenceReceiptSchema.parse(JSON.parse(row.receiptJson));
  }
}

function workspaceReceiptKey(
  workspaceCwd: string,
  identity: SparkReproFormalEvidenceReceiptIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceCwd,
        reproId: identity.reproId,
        requirementId: identity.requirementId,
        stepId: identity.stepId,
        evidenceRef: identity.evidenceRef,
        evidenceHash: identity.evidenceHash,
        planRevision: identity.planRevision,
        stepDefinitionDigest: identity.stepDefinitionDigest,
        profileDigest: identity.profileDigest,
        topologyDigest: identity.topologyDigest,
      }),
    )
    .digest("hex");
}
