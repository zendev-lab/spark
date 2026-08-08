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
  contract: Record<string, any>,
  candidateVersion: string,
  publishedVersions: string[],
  explicit?: string,
): string;
export function runReleaseCompatibilityGate(
  input: ReleaseCompatibilityArguments,
  dependencies?: Record<string, any>,
): Promise<Record<string, any>>;
