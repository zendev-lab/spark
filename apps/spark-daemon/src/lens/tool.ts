import type { DatabaseSync } from "node:sqlite";

import { resolveArtifactFileRoot } from "@zendev-lab/spark-files";
import { captureWorkspaceRevision, type LensDiagnosticReport } from "@zendev-lab/spark-lens";

import { DaemonLensCodeIntelligence } from "./code-intelligence.ts";
import { DaemonLensCodeIntelligenceStore } from "./code-intelligence-store.ts";
import { TypeScriptLensVerificationService } from "./typescript-verification.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../local-rpc/types.ts";

type LensExecuteRequest = Extract<LocalRpcServiceRequest, { method: "lens.execute" }>;

const services = new WeakMap<DatabaseSync, TypeScriptLensVerificationService>();
const intelligenceServices = new WeakMap<DatabaseSync, DaemonLensCodeIntelligence>();

export async function closeDaemonLensToolService(db: DatabaseSync): Promise<void> {
  const service = services.get(db);
  services.delete(db);
  intelligenceServices.delete(db);
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
