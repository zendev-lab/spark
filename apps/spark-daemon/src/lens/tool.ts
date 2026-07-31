import type { DatabaseSync } from "node:sqlite";

import type { LensDiagnosticReport } from "@zendev-lab/spark-lens";

import { TypeScriptLensVerificationService } from "./typescript-verification.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../local-rpc/types.ts";

type LensExecuteRequest = Extract<LocalRpcServiceRequest, { method: "lens.execute" }>;

const services = new WeakMap<DatabaseSync, TypeScriptLensVerificationService>();

export async function closeDaemonLensToolService(db: DatabaseSync): Promise<void> {
  const service = services.get(db);
  services.delete(db);
  await service?.close();
}

export async function executeDaemonLensTool(
  request: LensExecuteRequest,
  db: DatabaseSync,
): Promise<LocalRpcServiceOutput<LensExecuteRequest>> {
  const params = request.params.params;
  const action = stringParam(params.action, "action");
  if (action !== "diagnostics" && action !== "verify" && action !== "health") {
    throw new Error("lens action must be diagnostics, verify, or health");
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
