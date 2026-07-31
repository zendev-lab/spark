import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  defaultEvidenceStore,
  type EvidenceRef,
  type JsonValue,
} from "@zendev-lab/spark-artifacts";
import { resolveArtifactFileRoot } from "@zendev-lab/spark-files";
import {
  aggregateDiagnosticFindings,
  captureWorkspaceRevision,
  evaluateLensVerdict,
  TSC_PROVIDER_ID,
  TYPESCRIPT_DUAL_ROUTE_DIGEST,
  TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  VITE_PLUS_PROVIDER_ID,
  type DiagnosticFinding,
  type LensDiagnosticReport,
  type LensVerificationReceipt,
  type ProviderResult,
} from "@zendev-lab/spark-lens";

import { DaemonLensRuntime } from "./runtime.ts";
import { DaemonLensStateStore } from "./state-store.ts";
import {
  createTypeScriptDiagnosticProviders,
  inspectTypeScriptToolchain,
  type CommandDiagnosticValue,
} from "./typescript-providers.ts";

export interface RunTypeScriptDiagnosticsInput {
  cwd: string;
  artifactRef?: string;
  path?: string;
  maxFindings?: number;
}

export interface TypeScriptVerificationResult {
  report: LensDiagnosticReport;
  evidenceRef?: EvidenceRef;
}

export class TypeScriptLensVerificationService {
  readonly #runtime: DaemonLensRuntime;
  readonly #stateStore: DaemonLensStateStore;

  constructor(db: DatabaseSync) {
    this.#stateStore = new DaemonLensStateStore(db);
    this.#runtime = new DaemonLensRuntime({ stateStore: this.#stateStore });
    for (const provider of createTypeScriptDiagnosticProviders()) this.#runtime.register(provider);
  }

  async health(cwd: string, artifactRef?: string) {
    const root = await resolveArtifactFileRoot(cwd, artifactRef);
    return {
      profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE.id,
      routeDigest: TYPESCRIPT_DUAL_ROUTE_DIGEST,
      providers: await inspectTypeScriptToolchain(root.cwd),
    };
  }

  async diagnostics(input: RunTypeScriptDiagnosticsInput): Promise<TypeScriptVerificationResult> {
    const root = await resolveArtifactFileRoot(input.cwd, input.artifactRef);
    const revision = await captureWorkspaceRevision({
      workspaceRoot: root.cwd,
      profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
    });
    const request = { capability: "diagnostics" as const, input: {}, revision };
    const [owner, verifier] = await Promise.all([
      this.#runtime.run({
        requestId: `tsc:${randomUUID()}`,
        providerId: TSC_PROVIDER_ID,
        request,
        timeoutMs: 120_000,
      }),
      this.#runtime.run({
        requestId: `vite-plus:${randomUUID()}`,
        providerId: VITE_PLUS_PROVIDER_ID,
        request,
        timeoutMs: 120_000,
      }),
    ]);
    const providerResults = [owner, verifier];
    const findings = providerResults.flatMap((result) => findingsFrom(result));
    const filtered =
      input.path === undefined
        ? findings
        : findings.filter((finding) => finding.path?.endsWith(input.path!) === true);
    const observations = aggregateDiagnosticFindings(
      revision.digest,
      filtered.slice(0, input.maxFindings ?? 100),
    );
    this.#stateStore.saveObservations(root.cwd, observations);
    const current = await captureWorkspaceRevision({
      workspaceRoot: root.cwd,
      profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
    });
    const verdict =
      current.digest === revision.digest
        ? evaluateLensVerdict({
            revision,
            results: providerResults,
            observations,
            requiredProviderIds: [TSC_PROVIDER_ID, VITE_PLUS_PROVIDER_ID],
          })
        : "stale";
    return {
      report: {
        schemaVersion: 1,
        profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE.id,
        routeDigest: TYPESCRIPT_DUAL_ROUTE_DIGEST,
        revision,
        verdict,
        providerResults,
        observations,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async verify(input: RunTypeScriptDiagnosticsInput): Promise<TypeScriptVerificationResult> {
    const result = await this.diagnostics(input);
    const root = await resolveArtifactFileRoot(input.cwd, input.artifactRef);
    const receipt = verificationReceipt(result.report, root.artifactRef);
    const evidence = await defaultEvidenceStore(root.cwd).put({
      kind: "record",
      title: `Spark Lens verification ${receipt.verdict}`,
      format: "json",
      body: receipt as unknown as JsonValue,
      provenance: {
        producer: "spark",
        note: `lens:${TYPESCRIPT_DUAL_VERIFICATION_PROFILE.id}`,
      },
      curation: {
        status: "raw",
        retention: "task",
        reason: "revision-bound Lens verification receipt",
      },
    });
    return { ...result, evidenceRef: evidence.ref };
  }

  async close(): Promise<void> {
    await this.#runtime.close();
  }
}

function findingsFrom(result: ProviderResult): DiagnosticFinding[] {
  if (result.status !== "ok") return [];
  const value = result.value as CommandDiagnosticValue | undefined;
  return Array.isArray(value?.findings) ? value.findings : [];
}

function verificationReceipt(
  report: LensDiagnosticReport,
  gitChangeRef?: `artifact:${string}`,
): LensVerificationReceipt {
  return {
    schemaVersion: 1,
    ...(gitChangeRef === undefined ? {} : { gitChangeRef }),
    workspaceRevision: report.revision,
    routeDigest: report.routeDigest,
    profileDigest: report.revision.profileDigest,
    providers: report.providerResults.map((result) => ({
      id: result.providerId,
      version: result.providerVersion,
      status: result.status,
      durationMs: result.durationMs,
    })),
    obligations: ["typescript diagnostics owner", "independent native type-check verifier"],
    observationRefs: report.observations.map((observation) => observation.ref),
    verdict: report.verdict,
    createdAt: new Date().toISOString(),
  };
}
