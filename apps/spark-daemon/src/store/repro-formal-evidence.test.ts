import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { SparkReproFormalEvidenceReceipt } from "@zendev-lab/spark-protocol/repro-formal-evidence";
import { migrateSparkDaemonDatabase } from "./schema.ts";
import { SparkReproFormalEvidenceReceiptStore } from "./repro-formal-evidence.ts";

const receipt: SparkReproFormalEvidenceReceipt = {
  schema: "spark.repro.formal-evidence-receipt/v1",
  workspaceCwd: "/workspace",
  evidenceRef: "evidence:formal-proof",
  evidenceHash: "a".repeat(64),
  reproId: "repro-1",
  requirementId: "alignment",
  stepId: "S1",
  planRevision: 3,
  stepDefinitionDigest: "digest:S1",
  invocationClass: "owning_entrypoint",
  evidenceClass: "entrypoint",
  profileDigest: "b".repeat(64),
  topologyDigest: "c".repeat(64),
  verifierId: "registered-verifier",
  verifierVersion: "1",
  verdict: "accepted",
  verifiedAt: "2026-08-09T00:00:00.000Z",
  stale: false,
  superseded: false,
};

describe("daemon Repro formal Evidence receipt store", () => {
  it("persists one hash-bound receipt under its exact workspace and identity", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      const store = new SparkReproFormalEvidenceReceiptStore(db);
      expect(store.record("/workspace", receipt)).toEqual(receipt);
      expect(store.get("/workspace", receiptIdentity(receipt))).toEqual(receipt);
      const nextRevision = {
        ...receipt,
        planRevision: 4,
        stepDefinitionDigest: "digest:S1-v4",
      };
      expect(store.record("/workspace", nextRevision)).toEqual(nextRevision);
      expect(store.get("/workspace", receiptIdentity(receipt))).toEqual(receipt);
      expect(store.get("/workspace", receiptIdentity(nextRevision))).toEqual(nextRevision);
      const otherReceipt = { ...receipt, workspaceCwd: "/other-workspace" };
      expect(store.record("/other-workspace", otherReceipt)).toEqual(otherReceipt);
      expect(store.get("/workspace", receiptIdentity(receipt))).toEqual(receipt);
      expect(store.get("/other-workspace", receiptIdentity(otherReceipt))).toEqual(otherReceipt);
    } finally {
      db.close();
    }
  });
});

function receiptIdentity(value: SparkReproFormalEvidenceReceipt) {
  return {
    reproId: value.reproId,
    requirementId: value.requirementId,
    stepId: value.stepId,
    evidenceRef: value.evidenceRef,
    evidenceHash: value.evidenceHash,
    planRevision: value.planRevision,
    stepDefinitionDigest: value.stepDefinitionDigest,
    profileDigest: value.profileDigest,
    topologyDigest: value.topologyDigest,
  };
}
