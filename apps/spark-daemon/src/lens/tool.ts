import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import { resolveArtifactFileRoot } from "@zendev-lab/spark-files";
import {
  captureWorkspaceRevision,
  TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  type LensActionRequest,
  type LensDiagnosticReport,
  type LensScope,
  type ObservationDisposition,
} from "@zendev-lab/spark-lens";

import { DaemonLensCodeIntelligence } from "./code-intelligence.ts";
import { DaemonLensCodeIntelligenceStore } from "./code-intelligence-store.ts";
import { DaemonLensPatchService } from "./patch-service.ts";
import { DaemonLensPatchStore } from "./patch-store.ts";
import { runGitHubPrChecks } from "./pr-check-provider.ts";
import { DaemonLensReadIntegration } from "./read-integration.ts";
import { DaemonLensStateStore } from "./state-store.ts";
import { TypeScriptLensVerificationService } from "./typescript-verification.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../local-rpc/types.ts";

type LensExecuteRequest = Extract<LocalRpcServiceRequest, { method: "lens.execute" }>;

const services = new WeakMap<DatabaseSync, TypeScriptLensVerificationService>();
const intelligenceServices = new WeakMap<DatabaseSync, DaemonLensCodeIntelligence>();
const patchServices = new WeakMap<DatabaseSync, DaemonLensPatchService>();
const readIntegrations = new WeakMap<DatabaseSync, DaemonLensReadIntegration>();

export async function closeDaemonLensToolService(db: DatabaseSync): Promise<void> {
  const service = services.get(db);
  services.delete(db);
  intelligenceServices.delete(db);
  patchServices.delete(db);
  readIntegrations.delete(db);
  await service?.close();
}

export function lensReadIntegrationFor(db: DatabaseSync): DaemonLensReadIntegration {
  const existing = readIntegrations.get(db);
  if (existing) return existing;
  const integration = new DaemonLensReadIntegration({
    verification: serviceFor(db),
    intelligence: intelligenceFor(db),
    patches: patchServiceFor(db),
  });
  readIntegrations.set(db, integration);
  return integration;
}

export async function executeDaemonLensTool(
  request: LensExecuteRequest,
  db: DatabaseSync,
  cwd = request.params.cwd,
  stateCwd = cwd,
): Promise<LocalRpcServiceOutput<LensExecuteRequest>> {
  const params = request.params.params as LensActionRequest;
  switch (params.action) {
    case "status":
      return await executeStatus(db, params, cwd, stateCwd);
    case "inspect":
      return await executeInspect(db, params, cwd, stateCwd);
    case "check":
      return await executeCheck(db, params, cwd, stateCwd);
    case "fix":
      return await executeFix(db, params);
    case "triage":
      return await executeTriage(db, params, cwd);
    case "verify":
      return await executeVerify(db, params, cwd, stateCwd);
  }
}

async function executeStatus(
  db: DatabaseSync,
  params: Extract<LensActionRequest, { action: "status" }>,
  cwd: string,
  stateCwd: string,
) {
  const health = await serviceFor(db).health(cwd, params.artifactRef, stateCwd);
  const available = health.providers.filter((provider) => provider.available).length;
  return result(
    `Lens status: profile=${health.profile} providers=${available}/${health.providers.length}`,
    {
      view: params.view ?? "summary",
      health,
    },
  );
}

async function executeInspect(
  db: DatabaseSync,
  params: Extract<LensActionRequest, { action: "inspect" }>,
  cwd: string,
  stateCwd: string,
) {
  if (
    [
      "definition",
      "declaration",
      "type_definition",
      "implementation",
      "references",
      "hover",
      "signature",
      "call_hierarchy",
    ].includes(params.operation)
  ) {
    return result(`Lens inspect ${params.operation}: unavailable`, {
      status: "unavailable",
      reason: "The fixed semantic Provider does not expose this operation through Spark yet",
      items: [],
    });
  }

  const resolved = await resolveScope(cwd, params.scope, params.path, stateCwd);
  const revision = await captureWorkspaceRevision({
    workspaceRoot: resolved.cwd,
    profile: { id: "revisioned-code-intelligence-v1", astGrep: "0.45.0" },
  });
  const intelligence = intelligenceFor(db);
  const indexed = await intelligence.index({ revision });
  const limit = Math.min(params.limit ?? 20, 1_000);
  let items: unknown[];
  if (params.operation === "outline" || params.operation === "document_symbols") {
    if (!resolved.path) throw new Error(`${params.operation} requires a path or file scope`);
    items = intelligence.outline(revision, resolved.path);
  } else if (params.operation === "enclosing") {
    if (!resolved.path || !params.position) throw new Error("enclosing requires path and position");
    items = intelligence
      .outline(revision, resolved.path)
      .filter(
        (symbol) =>
          symbol.startLine <= params.position!.line && symbol.endLine >= params.position!.line,
      )
      .sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine))
      .slice(0, 1);
  } else if (params.operation === "impact") {
    if (!resolved.path) throw new Error("impact requires a path or file scope");
    items = intelligence.impact(revision, resolved.path);
  } else if (params.operation === "structural_search" || params.operation === "ast") {
    if (!params.pattern) throw new Error(`${params.operation} requires pattern`);
    items = await intelligence.structuralSearch({
      revision,
      pattern: params.pattern,
      ...(resolved.path ? { path: resolved.path } : {}),
      limit,
    });
  } else {
    if (!params.query) throw new Error(`${params.operation} requires query`);
    items = intelligence.search(revision, params.query, limit);
  }
  const withArtifact = resolved.artifactRef
    ? items.map((item) => addArtifactRef(item, resolved.artifactRef!))
    : items;
  return result(
    `Lens inspect ${params.operation}: ${withArtifact.length} result(s) revision=${revision.digest}`,
    { revisionDigest: revision.digest, indexed, items: withArtifact },
  );
}

async function executeCheck(
  db: DatabaseSync,
  params: Extract<LensActionRequest, { action: "check" }>,
  cwd: string,
  stateCwd: string,
) {
  const resolved = await resolveScope(cwd, params.scope, undefined, stateCwd);
  if (params.kind === "pr") {
    const report = await runGitHubPrChecks(resolved.cwd);
    return result(`Lens check pr: ${report.verdict}\n${report.message}`, { report });
  }
  if (params.kind === "lint" || params.kind === "test") {
    return result(`Lens check ${params.kind}: inconclusive`, {
      verdict: "inconclusive",
      reason: `The fixed ${params.kind} Provider is unavailable for this workspace`,
      observations: [],
    });
  }
  const verification = await serviceFor(db).diagnostics({
    cwd: resolved.cwd,
    ...(resolved.path ? { path: resolved.path } : {}),
    ...(params.maxFindings ? { maxFindings: params.maxFindings } : {}),
  });
  return diagnosticResult(`Lens check ${params.kind}`, verification);
}

async function executeFix(db: DatabaseSync, params: Extract<LensActionRequest, { action: "fix" }>) {
  const patches = patchServiceFor(db);
  if (params.operation === "apply") {
    const promotion = await patches.apply({
      proposalRef: params.proposalRef,
      explicitSelection: params.selectionRef !== undefined,
    });
    lensReadIntegrationFor(db).invalidateAll();
    return result(`Lens fix applied: ${promotion.proposalRef} verdict=${promotion.verdict}`, {
      promotion,
    });
  }
  if (params.operation === "reject") {
    patches.reject(params.proposalRef);
    return result(`Lens fix rejected: ${params.proposalRef}`, {
      proposalRef: params.proposalRef,
      reason: params.reason,
    });
  }
  const proposal = await lensReadIntegrationFor(db).propose({
    candidateRef: params.candidateRef,
    path: params.path,
    kind: params.kind,
  });
  return result(`Lens fix proposed: ${proposal.ref}`, { proposal });
}

async function executeTriage(
  db: DatabaseSync,
  params: Extract<LensActionRequest, { action: "triage" }>,
  cwd: string,
) {
  const revision = await captureWorkspaceRevision({
    workspaceRoot: cwd,
    profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  });
  if (params.disposition === "suppress") {
    const observation = new DaemonLensStateStore(db)
      .listObservations(cwd, revision.digest)
      .find((candidate) => candidate.ref === params.observationRef);
    if (!observation?.subject.path || !observation.subject.range) {
      throw new Error("current suppression target has no source range");
    }
    if (
      ![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].includes(extname(observation.subject.path))
    ) {
      throw new Error("the fixed Provider has no suppression syntax for this file type");
    }
    const path = workspaceRelativePath(cwd, observation.subject.path);
    const source = await readFile(resolve(cwd, path), "utf8");
    const offset = lineStartOffset(source, observation.subject.range.start.line);
    const code = observation.observations.find((entry) => entry.code)?.code;
    const provider = observation.observations[0]?.providerId;
    if (!provider) throw new Error("suppression target has no Provider provenance");
    const comment = `// @ts-expect-error${code ? ` ${code}` : ""} -- ${params.reason?.trim() || "suppressed by Spark Lens"}\n`;
    const proposal = await patchServiceFor(db).propose({
      workspaceRoot: cwd,
      provider,
      edits: [{ path, startOffset: offset, endOffset: offset, newText: comment }],
      expectedResolution: [observation.ref],
      safety: { kind: "safe" },
    });
    return result(`Lens triage ${params.observationRef}: suppression proposed`, {
      status: "proposal_required",
      proposal,
    });
  }
  const disposition = mapDisposition(params.disposition);
  const record = patchServiceFor(db).triage(cwd, {
    observationRef: params.observationRef,
    revisionDigest: revision.digest,
    disposition,
  });
  return result(`Lens triage ${params.observationRef}: ${params.disposition}`, {
    disposition: record,
    ...(params.reason ? { reason: params.reason } : {}),
  });
}

async function executeVerify(
  db: DatabaseSync,
  params: Extract<LensActionRequest, { action: "verify" }>,
  cwd: string,
  stateCwd: string,
) {
  if (params.target.kind === "task" || params.target.kind === "goal") {
    return result(`Lens verify ${params.target.kind}: inconclusive`, {
      verdict: "inconclusive",
      reason: "No daemon-owned verification obligation binding exists for this target yet",
    });
  }
  const artifactRef = params.target.kind === "git_change" ? params.target.artifactRef : undefined;
  const root = await resolveArtifactFileRoot(cwd, artifactRef, stateCwd);
  const externalChecks = [];
  if (params.target.kind === "git_change") {
    const check = await runGitHubPrChecks(root.cwd);
    externalChecks.push({
      provider: check.provider,
      subjectRevision: check.localHeadOid ?? "unavailable",
      verdict: check.verdict,
      obligations: ["clean worktree", "local HEAD equals PR head SHA", "required GitHub checks"],
      observedAt: check.observedAt,
    });
  }
  const verification = await serviceFor(db).verify(
    { cwd, stateCwd, ...(artifactRef ? { artifactRef } : {}) },
    externalChecks,
  );
  return diagnosticResult("Lens verify", verification);
}

async function resolveScope(cwd: string, scope?: LensScope, path?: string, stateCwd: string = cwd) {
  const artifactRef = scope?.kind === "git_change" ? scope.artifactRef : undefined;
  const root = await resolveArtifactFileRoot(cwd, artifactRef, stateCwd);
  return {
    cwd: root.cwd,
    artifactRef: root.artifactRef,
    path: scope?.kind === "file" ? scope.path : path,
  };
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
      const checked = await verification.diagnosticsForRevision(revision);
      return { verdict: checked.report.verdict };
    },
    async verifyPromoted({ workspaceRoot }) {
      const checked = await verification.verify({ cwd: workspaceRoot });
      return {
        verdict: checked.report.verdict,
        ...(checked.evidenceRef ? { evidenceRef: checked.evidenceRef } : {}),
      };
    },
  });
  patchServices.set(db, service);
  return service;
}

function mapDisposition(
  value: "false_positive" | "defer" | "flagged",
): Exclude<ObservationDisposition, "open"> {
  return value === "defer" ? "deferred" : value;
}

function workspaceRelativePath(workspaceRoot: string, path: string): string {
  const root = resolve(workspaceRoot);
  const relation = relative(root, resolve(root, path)).replaceAll("\\", "/");
  if (relation === ".." || relation.startsWith("../")) {
    throw new Error(`Lens path escapes workspace: ${path}`);
  }
  return relation;
}

function lineStartOffset(source: string, zeroBasedLine: number): number {
  if (!Number.isSafeInteger(zeroBasedLine) || zeroBasedLine < 0) {
    throw new Error("suppression range has an invalid line");
  }
  let offset = 0;
  for (let line = 0; line < zeroBasedLine; line += 1) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) throw new Error("suppression range is outside the file");
    offset = newline + 1;
  }
  return offset;
}

function addArtifactRef(value: unknown, artifactRef: `artifact:${string}`): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as { read?: Record<string, unknown> };
  return item.read ? { ...item, read: { ...item.read, artifactRef } } : item;
}

function diagnosticResult(
  label: string,
  verification: { report: LensDiagnosticReport; evidenceRef?: `evidence:${string}` },
) {
  const report = publicReport(verification.report);
  return result(
    [
      `${label}: ${report.verdict}`,
      `revision=${report.revisionDigest}`,
      `observations=${report.observations.length}`,
      ...report.providers.map(
        (provider) =>
          `${provider.id}@${provider.version} ${provider.status} ${Math.round(provider.durationMs)}ms`,
      ),
      ...(verification.evidenceRef ? [`receipt=${verification.evidenceRef}`] : []),
    ].join("\n"),
    { report, ...(verification.evidenceRef ? { evidenceRef: verification.evidenceRef } : {}) },
  );
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
    JSON.stringify({ content: [{ type: "text", text }], details }),
  ) as LocalRpcServiceOutput<LensExecuteRequest>;
}
