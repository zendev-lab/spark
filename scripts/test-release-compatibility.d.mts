import type { CombinedCompatibilityReport } from "./release-compatibility-report.mjs";

export interface ReleaseCompatibilityArguments {
  baselineVersion?: string;
  tarball: string;
  cliTarball: string;
  daemonTarball: string;
  hubTarball: string;
  tuiTarball: string;
}

export function parseReleaseCompatibilityArguments(argv: string[]): ReleaseCompatibilityArguments;
export function selectRequiredBaseline(
  contract: Record<string, unknown>,
  candidateVersion: string,
  publishedVersions: string[],
  explicit?: string,
): string;
export function runReleaseCompatibilityGate(
  input: ReleaseCompatibilityArguments,
  dependencies?: Record<string, unknown>,
): Promise<CombinedCompatibilityReport>;
