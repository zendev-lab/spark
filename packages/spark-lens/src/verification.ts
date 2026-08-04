import { createHash } from "node:crypto";

import { stableJson } from "./revision.ts";
import { capabilityRoute, digestibleRoute } from "./routes.ts";
import type {
  LensVerdict,
  Observation,
  ObservationRef,
  ProviderId,
  ProviderResult,
  ProviderVersion,
  WorkspaceRevision,
} from "./types.ts";

export const TSC_PROVIDER_ID = "typescript-6-tsc" as ProviderId;
export const VITE_PLUS_PROVIDER_ID = "vite-plus-native-check" as ProviderId;
export const TYPESCRIPT_DUAL_VERIFICATION_ROUTE = capabilityRoute.verify(
  "diagnostics",
  TSC_PROVIDER_ID,
  [VITE_PLUS_PROVIDER_ID],
);
export const TYPESCRIPT_DUAL_VERIFICATION_PROFILE = {
  id: "typescript-dual-verification-v1",
  route: digestibleRoute(TYPESCRIPT_DUAL_VERIFICATION_ROUTE),
  providers: [
    { id: TSC_PROVIDER_ID, binary: "workspace:typescript/tsc" },
    { id: VITE_PLUS_PROVIDER_ID, binary: "workspace:vite-plus/vp" },
  ],
} as const;

export interface DiagnosticFinding {
  providerId: ProviderId;
  providerVersion: ProviderVersion;
  path?: string;
  line?: number;
  character?: number;
  code?: string;
  severity: "error" | "warning" | "info";
  message: string;
  fingerprint?: string;
  durationMs: number;
}

export interface LensDiagnosticReport {
  schemaVersion: 1;
  profile: string;
  routeDigest: string;
  revision: WorkspaceRevision;
  verdict: LensVerdict;
  providerResults: readonly ProviderResult[];
  observations: readonly Observation[];
  createdAt: string;
}

export interface LensVerificationReceipt {
  schemaVersion: 1;
  gitChangeRef?: `artifact:${string}`;
  workspaceRevision: WorkspaceRevision;
  routeDigest: string;
  profileDigest: string;
  providers: readonly {
    id: ProviderId;
    version: ProviderVersion;
    status: ProviderResult["status"];
    durationMs: number;
  }[];
  obligations: readonly string[];
  observationRefs: readonly ObservationRef[];
  externalChecks?: readonly {
    provider: string;
    subjectRevision: string;
    verdict: LensVerdict;
    obligations: readonly string[];
    observedAt: string;
  }[];
  verdict: LensVerdict;
  createdAt: string;
}

export function digestLensProfile(profile: unknown): string {
  return createHash("sha256").update(stableJson(profile)).digest("hex");
}

export const TYPESCRIPT_DUAL_ROUTE_DIGEST = digestLensProfile(TYPESCRIPT_DUAL_VERIFICATION_ROUTE);

export function aggregateDiagnosticFindings(
  revisionDigest: string,
  findings: readonly DiagnosticFinding[],
): Observation[] {
  const groups = new Map<string, DiagnosticFinding[]>();
  for (const finding of findings) {
    const key = finding.fingerprint ?? diagnosticFingerprint(finding);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fingerprint, grouped]) => {
      const first = grouped[0]!;
      const providers = new Set(grouped.map((finding) => finding.providerId));
      return {
        ref: `observation:${createHash("sha256")
          .update(`${revisionDigest}\0${fingerprint}`)
          .digest("hex")}` as ObservationRef,
        revisionDigest,
        capability: "diagnostics",
        subject: {
          ...(first.path === undefined ? {} : { path: first.path }),
          ...(first.line === undefined
            ? {}
            : {
                range: {
                  start: {
                    line: first.line,
                    character: first.character ?? 0,
                  },
                  end: {
                    line: first.line,
                    character: (first.character ?? 0) + 1,
                  },
                },
              }),
        },
        category: "type",
        severity: grouped.some((finding) => finding.severity === "error") ? "error" : "warning",
        summary: first.message,
        disposition: "open",
        agreement: providers.size > 1 ? "corroborated" : "single_source",
        observations: grouped.map((finding) => ({
          providerId: finding.providerId,
          providerVersion: finding.providerVersion,
          ...(finding.code === undefined ? {} : { code: finding.code }),
          message: finding.message,
          durationMs: finding.durationMs,
        })),
      } satisfies Observation;
    });
}

function diagnosticFingerprint(finding: DiagnosticFinding): string {
  const message = finding.message
    .toLowerCase()
    .replaceAll(/\b(?:ts|report)[a-z]*\d+\b/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return [
    finding.path ?? "",
    String(finding.line ?? ""),
    String(finding.character ?? ""),
    finding.code ?? "",
    message,
  ].join("\0");
}
