import type { DatabaseSync } from "node:sqlite";

import { resolveArtifactFileRoot } from "@zendev-lab/spark-files";
import {
  captureWorkspaceRevision,
  TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  type LensDiagnosticReport,
  type ObservationDisposition,
  type ObservationRef,
  type PatchProposalRef,
  type PatchSelectionReason,
  type PatchTextEdit,
  type ProviderId,
} from "@zendev-lab/spark-lens";

import { DaemonLensCodeIntelligence } from "./code-intelligence.ts";
import { DaemonLensCodeIntelligenceStore } from "./code-intelligence-store.ts";
import { DaemonLensPatchService } from "./patch-service.ts";
import { DaemonLensPatchStore } from "./patch-store.ts";
import { TypeScriptLensVerificationService } from "./typescript-verification.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../local-rpc/types.ts";

type LensExecuteRequest = Extract<LocalRpcServiceRequest, { method: "lens.execute" }>;

const services = new WeakMap<DatabaseSync, TypeScriptLensVerificationService>();
const intelligenceServices = new WeakMap<DatabaseSync, DaemonLensCodeIntelligence>();
const patchServices = new WeakMap<DatabaseSync, DaemonLensPatchService>();

export async function closeDaemonLensToolService(db: DatabaseSync): Promise<void> {
  const service = services.get(db);
  services.delete(db);
  intelligenceServices.delete(db);
  patchServices.delete(db);
  await service?.close();
}

export async function executeDaemonLensTool(
  request: LensExecuteRequest,
  db: DatabaseSync,
): Promise<LocalRpcServiceOutput<LensExecuteRequest>> {
  const params = request.params.params;
  const action = stringParam(params.action, "action");
  if (
    ![
      "diagnostics",
      "verify",
      "health",
      "search",
      "outline",
      "navigate",
      "structural_search",
      "impact",
      "propose_patch",
      "apply_patch",
      "triage",
    ].includes(action)
  ) {
    throw new Error("unsupported lens action");
  }
  const artifactRef = optionalString(params.artifactRef, "artifactRef");
  const service = serviceFor(db);
  if (action === "health") {
    const health = await service.health(request.params.cwd, artifactRef);
    const available = health.providers.filter((provider) => provider.available).length;
    return result(
      `Lens profile=${health.profile} providers=${available}/${health.providers.length}`,
      { health },
    );
  }
  if (action === "propose_patch" || action === "apply_patch" || action === "triage") {
    const root = await resolveArtifactFileRoot(request.params.cwd, artifactRef);
    const patchService = patchServiceFor(db);
    if (action === "propose_patch") {
      const edits = patchEditsParam(params.edits);
      const provider = stringParam(params.provider, "provider") as ProviderId;
      const expectedResolution = stringArrayParam(
        params.expectedResolution,
        "expectedResolution",
      ) as ObservationRef[];
      const safetyReasons = stringArrayParam(params.safetyReasons, "safetyReasons").map((reason) =>
        patchSelectionReason(reason),
      );
      const proposal = await patchService.propose({
        workspaceRoot: root.cwd,
        provider,
        edits,
        expectedResolution,
        safety:
          safetyReasons.length > 0
            ? { kind: "requires_selection", reasons: safetyReasons }
            : { kind: "safe" },
      });
      return result(`Lens patch proposed: ${proposal.ref}`, { proposal });
    }
    if (action === "apply_patch") {
      const proposalRef = stringParam(params.proposalRef, "proposalRef") as PatchProposalRef;
      const promotion = await patchService.apply({
        workspaceRoot: root.cwd,
        proposalRef,
        explicitSelection: optionalBoolean(params.explicitSelection, "explicitSelection"),
      });
      return result(
        `Lens patch promoted: ${promotion.proposalRef} verdict=${promotion.verdict} revision=${promotion.promotedRevision.digest}`,
        { promotion },
      );
    }
    const observationRef = stringParam(params.observationRef, "observationRef") as ObservationRef;
    const disposition = dispositionParam(params.disposition);
    const revision = await captureWorkspaceRevision({
      workspaceRoot: root.cwd,
      profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
    });
    const proposalRef = optionalString(params.proposalRef, "proposalRef") as
      | PatchProposalRef
      | undefined;
    const dispositionRecord = patchService.triage(root.cwd, {
      observationRef,
      revisionDigest: revision.digest,
      disposition,
      ...(proposalRef ? { patchProposalRef: proposalRef } : {}),
    });
    return result(`Lens observation ${observationRef}: ${disposition}`, {
      disposition: dispositionRecord,
    });
  }
  if (
    action === "search" ||
    action === "outline" ||
    action === "navigate" ||
    action === "structural_search" ||
    action === "impact"
  ) {
    const root = await resolveArtifactFileRoot(request.params.cwd, artifactRef);
    const revision = await captureWorkspaceRevision({
      workspaceRoot: root.cwd,
      profile: { id: "revisioned-code-intelligence-v1", astGrep: "0.45.0" },
    });
    const intelligence = intelligenceFor(db);
    const indexed = await intelligence.index({ revision });
    const path = optionalString(params.path, "path");
    const query = optionalString(params.query, "query");
    const pattern = optionalString(params.pattern, "pattern");
    const maxFindings = optionalInteger(params.maxFindings, "maxFindings") ?? 20;
    let items: unknown[];
    if (action === "outline") {
      if (!path) throw new Error("outline requires path");
      items = intelligence.outline(revision, path);
    } else if (action === "impact") {
      if (!path) throw new Error("impact requires path");
      items = intelligence.impact(revision, path);
    } else if (action === "structural_search") {
      if (!pattern) throw new Error("structural_search requires pattern");
      items = await intelligence.structuralSearch({
        revision,
        pattern,
        ...(path ? { path } : {}),
        limit: Math.min(maxFindings, 1_000),
      });
    } else {
      if (!query) throw new Error(`${action} requires query`);
      items = intelligence.search(revision, query, Math.min(maxFindings, 1_000));
    }
    const withArtifact = root.artifactRef
      ? items.map((item) => addArtifactRef(item, root.artifactRef!))
      : items;
    return result(`Lens ${action}: ${withArtifact.length} result(s) revision=${revision.digest}`, {
      revisionDigest: revision.digest,
      indexed,
      items: withArtifact,
    });
  }

  const path = optionalString(params.path, "path");
  const maxFindings = optionalInteger(params.maxFindings, "maxFindings");
  const input = {
    cwd: request.params.cwd,
    ...(artifactRef === undefined ? {} : { artifactRef }),
    ...(path === undefined ? {} : { path }),
    ...(maxFindings === undefined ? {} : { maxFindings: Math.min(maxFindings, 1_000) }),
  };
  const verification =
    action === "verify" ? await service.verify(input) : await service.diagnostics(input);
  const report = publicReport(verification.report);
  return result(
    [
      `Lens ${action}: ${report.verdict}`,
      `revision=${report.revisionDigest}`,
      `observations=${report.observations.length}`,
      ...report.providers.map(
        (provider) =>
          `${provider.id}@${provider.version} ${provider.status} ${Math.round(provider.durationMs)}ms`,
      ),
      ...(verification.evidenceRef ? [`receipt=${verification.evidenceRef}`] : []),
    ].join("\n"),
    {
      report,
      ...(verification.evidenceRef ? { evidenceRef: verification.evidenceRef } : {}),
    },
  );
}

function serviceFor(db: DatabaseSync): TypeScriptLensVerificationService {
  const existing = services.get(db);
  if (existing) return existing;
  const service = new TypeScriptLensVerificationService(db);
  services.set(db, service);
  return service;
}

function intelligenceFor(db: DatabaseSync): DaemonLensCodeIntelligence {
  const existing = intelligenceServices.get(db);
  if (existing) return existing;
  const service = new DaemonLensCodeIntelligence(new DaemonLensCodeIntelligenceStore(db));
  intelligenceServices.set(db, service);
  return service;
}

function patchServiceFor(db: DatabaseSync): DaemonLensPatchService {
  const existing = patchServices.get(db);
  if (existing) return existing;
  const verification = serviceFor(db);
  const service = new DaemonLensPatchService({
    store: new DaemonLensPatchStore(db),
    async verifyOverlay({ revision }) {
      const result = await verification.diagnosticsForRevision(revision);
      return { verdict: result.report.verdict };
    },
    async verifyPromoted({ workspaceRoot }) {
      const result = await verification.verify({ cwd: workspaceRoot });
      return {
        verdict: result.report.verdict,
        ...(result.evidenceRef ? { evidenceRef: result.evidenceRef } : {}),
      };
    },
  });
  patchServices.set(db, service);
  return service;
}

function addArtifactRef(value: unknown, artifactRef: `artifact:${string}`): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as { read?: Record<string, unknown> };
  return item.read ? { ...item, read: { ...item.read, artifactRef } } : item;
}

function publicReport(report: LensDiagnosticReport) {
  return {
    schemaVersion: report.schemaVersion,
    profile: report.profile,
    routeDigest: report.routeDigest,
    revisionDigest: report.revision.digest,
    verdict: report.verdict,
    providers: report.providerResults.map((provider) => ({
      id: provider.providerId,
      version: provider.providerVersion,
      status: provider.status,
      durationMs: provider.durationMs,
      ...(provider.error === undefined ? {} : { error: provider.error }),
    })),
    observations: report.observations,
    createdAt: report.createdAt,
  };
}

function result(text: string, details: Record<string, unknown>) {
  return JSON.parse(
    JSON.stringify({
      content: [{ type: "text", text }],
      details,
    }),
  ) as LocalRpcServiceOutput<LensExecuteRequest>;
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a string`);
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringParam(value, name);
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function stringArrayParam(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value.map((item) => String(item).trim());
}

function patchEditsParam(value: unknown): PatchTextEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("edits must be a non-empty array");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("each patch edit must be an object");
    }
    const edit = item as Record<string, unknown>;
    const startOffset = Number(edit.startOffset);
    const endOffset = Number(edit.endOffset);
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)) {
      throw new Error("patch edit offsets must be integers");
    }
    if (typeof edit.newText !== "string") throw new Error("patch edit newText must be a string");
    return {
      path: stringParam(edit.path, "edit.path"),
      startOffset,
      endOffset,
      newText: edit.newText,
    };
  });
}

function patchSelectionReason(value: string): PatchSelectionReason {
  if (!["unsafe", "create_delete", "multiple_candidates", "cross_file_rename"].includes(value)) {
    throw new Error(`unsupported patch safety reason: ${value}`);
  }
  return value as PatchSelectionReason;
}

function dispositionParam(value: unknown): Exclude<ObservationDisposition, "open"> {
  const disposition = stringParam(value, "disposition");
  if (!["false_positive", "deferred", "flagged", "suppressed"].includes(disposition)) {
    throw new Error(`unsupported observation disposition: ${disposition}`);
  }
  return disposition as Exclude<ObservationDisposition, "open">;
}
