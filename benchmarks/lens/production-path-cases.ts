import {
  aggregateDiagnosticFindings,
  createPatchProposal,
  stableJson,
  type DiagnosticFinding,
  type ObservationRef,
  type ProviderId,
  type ProviderVersion,
  type WorkspaceRevision,
} from "@zendev-lab/spark-lens";

export const STABLE_JSON_ITEM_COUNT = 1_024;
export const DIAGNOSTIC_GROUP_COUNT = 500;
export const PATCH_EDIT_COUNT = 500;

const revision: WorkspaceRevision = {
  schemaVersion: 1,
  workspaceRoot: "/benchmark/workspace",
  headOid: "benchmark",
  trackedDiffDigest: "clean",
  stagedDiffDigest: "clean",
  untrackedContentDigest: "clean",
  profileDigest: "benchmark-profile",
  digest: `sha256:${"a".repeat(64)}`,
  observedAt: "2026-08-05T00:00:00.000Z",
};

export const stableJsonInput = Array.from({ length: STABLE_JSON_ITEM_COUNT }, (_, index) => ({
  z: index,
  nested: { enabled: index % 2 === 0, label: `item-${index}` },
  a: [index, index + 1, index + 2],
}));

export const diagnosticInput: DiagnosticFinding[] = Array.from(
  { length: DIAGNOSTIC_GROUP_COUNT },
  (_, index) =>
    (["typescript", "vite-plus"] as const).map((provider, providerIndex) => ({
      providerId: provider as ProviderId,
      providerVersion: "1.0.0" as ProviderVersion,
      path: `src/module-${index}.ts`,
      line: index + 1,
      character: providerIndex,
      code: `TS${2_000 + index}`,
      severity: index % 10 === 0 ? ("error" as const) : ("warning" as const),
      message: `Type mismatch in module ${index}`,
      fingerprint: `diagnostic-${index}`,
      durationMs: 1,
    })),
).flat();

export const patchInput = {
  baseRevision: revision,
  provider: "typescript" as ProviderId,
  edits: Array.from({ length: PATCH_EDIT_COUNT }, (_, index) => ({
    path: `src/module-${index}.ts`,
    startOffset: index * 10,
    endOffset: index * 10 + 1,
    newText: String(index % 10),
  })),
  preconditions: Array.from({ length: 50 }, (_, index) => ({
    path: `src/module-${index}.ts`,
    expectedVersion: `sha256:${index.toString(16).padStart(64, "0")}` as const,
  })),
  expectedResolution: Array.from(
    { length: 50 },
    (_, index) => `observation:${index}` as ObservationRef,
  ),
  safety: { kind: "safe" as const },
  createdAt: "2026-08-05T00:00:00.000Z",
};

export function runStableJsonCase(): string {
  return stableJson(stableJsonInput);
}

export function runDiagnosticAggregationCase() {
  return aggregateDiagnosticFindings(revision.digest, diagnosticInput);
}

export function runPatchProposalCase() {
  return createPatchProposal(patchInput);
}
