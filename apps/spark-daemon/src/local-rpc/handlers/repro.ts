import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import type { EvidenceRef } from "@zendev-lab/spark-core";
import type { SparkReproFormalEvidenceReceipt } from "@zendev-lab/spark-protocol/repro-formal-evidence";
import { SparkReproFormalEvidenceReceiptStore } from "../../store/repro-formal-evidence.ts";
import { getWorkspaceByPath } from "../../store/workspaces.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type ReproRequest = Extract<LocalRpcServiceRequest, { method: "repro.formal-evidence.record" }>;

export async function handleReproRequest(
  ctx: LocalRpcDispatchContext,
  request: ReproRequest,
): Promise<LocalRpcServiceOutput<ReproRequest>> {
  const verifier = ctx.options.reproFormalEvidenceVerifier;
  if (!verifier) {
    throw new Error("no registered daemon formal Evidence verifier is configured");
  }
  const workspace = getWorkspaceByPath(ctx.db, request.params.workspaceCwd);
  if (!workspace || workspace.localPath !== request.params.workspaceCwd) {
    throw new Error("formal Evidence workspace is not an exact registered daemon workspace");
  }
  if (
    request.params.candidate.workspaceCwd !== workspace.localPath ||
    request.params.workspaceCwd !== workspace.localPath
  ) {
    throw new Error("formal Evidence candidate workspace binding does not match registration");
  }
  const evidence = await defaultEvidenceStore(workspace.localPath).tryGet(
    request.params.candidate.evidenceRef as EvidenceRef,
  );
  if (!evidence || evidence.hash !== request.params.candidate.evidenceHash) {
    throw new Error("formal Evidence candidate does not match durable workspace Evidence");
  }
  if (
    evidence.curation?.status === "superseded" ||
    (evidence.curation?.supersededBy?.length ?? 0) > 0
  ) {
    throw new Error("formal Evidence candidate is superseded");
  }

  const verified = await verifier.verify(request.params.candidate, evidence.body);
  if (verified.verdict !== "accepted") {
    throw new Error("registered daemon formal Evidence verifier did not accept the candidate");
  }
  const receipt: SparkReproFormalEvidenceReceipt = {
    schema: "spark.repro.formal-evidence-receipt/v1",
    ...request.params.candidate,
    verifierId: verified.verifierId,
    verifierVersion: verified.verifierVersion,
    verdict: "accepted",
    verifiedAt: verified.verifiedAt,
    stale: false,
    superseded: false,
  };
  const recorded = new SparkReproFormalEvidenceReceiptStore(ctx.db).record(
    workspace.localPath,
    receipt,
  );
  return { recorded: true, receipt: recorded };
}
