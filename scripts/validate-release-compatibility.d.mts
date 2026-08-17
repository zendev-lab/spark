export interface ReleaseCompatibilityContract extends Record<string, unknown> {
  schemaVersion: number;
  adjacentReleaseWindow: number;
  firstSplitRelease: string;
  fullMatrixRequiredFrom: string;
  components: string[];
  edges: Array<{
    id: string;
    left: string;
    right: string;
    surfaces: string[];
  }>;
  releaseGate: {
    harness: string;
    productHarness: string;
    reportPath: string;
    baselineSelection: string;
    compatibilityExemptVersions: string[];
    placeholder?: boolean;
    requiredPhases: Array<{
      id: string;
      edge: string;
      left: string;
      right: string;
      assertions: string[];
    }>;
    sameVersionPhase: { id: string; assertions: string[] };
    firstSplitReleaseException: {
      candidateVersion: string;
      baselineVersion: string;
      phaseStatus: string;
      reason: string;
    };
  };
  protocol: {
    unknownOptionalFields: string;
    unknownRequiredCapabilities?: string;
  };
  database: {
    metadataRequiredFrom: string;
    harness: string;
    reportPath: string;
    owners: Array<{
      id: string;
      migrationManifest: string;
      probeCommand: string;
    }>;
    requiredPhases: string[];
    automaticUpdatePhases: string[];
  };
}

export function compareStableVersions(left: string, right: string): number;
export function validateCompatibilitySemantics<T extends Record<string, unknown>>(contract: T): T;
export function loadAndValidateReleaseCompatibility(
  base?: string,
): Promise<ReleaseCompatibilityContract>;
